# Skill plan: `code.answer-question` (L2 — full Q&A pilot)

**Status:** draft (2026-06-01)
**Owner:** subhagho@gmail.com
**Skill family:** `meta` (this is the agent's headline skill, not source-introspection)
**Tier:** L2 (second L2 pilot — after `code.audit-module`)
**Substrate owner id:** `skill:code.answer-question`

**Why this is the second L2 pilot:** per [`plans/code-analyzer-migration.md`](../../code-analyzer-migration.md) §"Pilot L2 skill" + §"Phase 6":

> Phase 6 — Replace writer + grounding-review pingpong with L2 self-grounding.
> Migrate `code.answer-question` from strawman to live. Sections come from L2 skills, not the writer + grounding loop. meta-narrative-detector becomes a sanity check inside L2 self-grounding rather than a separate pass.

The audit-module pilot (P8) proved the L2 runtime end-to-end on a narrow surface. answer-question is the **open-ended** pilot that demonstrates the framework can replace the legacy writer + grounding-review pipeline.

## What it does

Take a code question + active repo, plan its own discovery, dispatch L1 sub-calls (via classify-question + select-scope, which were migrated to emit goals per A5), draft a section-shaped answer, self-ground every claim. Returns `SkillOutput<AnswerOutput>`.

## Inputs / Output

```ts
interface AnswerQuestionInput {
  readonly question:       string;
  readonly activeRepoPath: string;
  // Optional: tier hint passed through to sub-skills that respect scope.
  readonly scopeTier?:     'S' | 'M' | 'L' | 'XL';
  // Optional: caller-provided repo metadata so we can skip the lookup.
  readonly repoMeta?: {
    readonly primaryLanguages?: readonly string[];
    readonly detectedOrms?:     readonly string[];
    readonly migrationTool?:    string;
  };
}

interface AnswerSection {
  readonly title:   string;         // short heading
  readonly body:    string;         // markdown-shaped text
  // Optional structured data the LLM may surface (tables, lists, etc.).
  readonly details?: unknown;
}

interface AnswerOutput {
  readonly question:    string;
  readonly questionType: string;    // from classify-question
  readonly sections:    readonly AnswerSection[];
  // Sub-skill dispatch trace -- which skills ran with which goals.
  // Surfaces in tool_result for callers that want to render a trace
  // panel; never used to re-derive output (that's the ledger's job).
  readonly dispatched:  readonly { readonly skillId: string; readonly goal: string }[];
}
```

`SkillOutput<AnswerOutput>` adds `evidence: Evidence[]` (per A1 -- every cited claim resolves to a ledger entry), `confidence`, and optional `notes`.

## Internal flow

```
┌──────────────────────────────────────────────────────────────────────┐
│ 1. PLAN -- callL1 code.meta.classify-question(question, repo)         │
│    Returns: { candidates: [{ skillId, goal, mustHaveScope, ... }] }  │
│    Auto-appended to working state as a sub-call ledger entry.        │
└─────────────────────────┬────────────────────────────────────────────┘
                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 2. SCOPE -- callL1 code.meta.select-scope(question, candidates, ...)│
│    Returns: { scoped: [{ skillId, args, resolvedScope }] }           │
│    Auto-appended.                                                    │
└─────────────────────────┬────────────────────────────────────────────┘
                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 3. DISPATCH -- for each scoped invocation, callL1(id, args)          │
│    Each result auto-appends to the ledger.                           │
│    Sequential per CLAUDE.md no-parallel-LLM rule.                    │
└─────────────────────────┬────────────────────────────────────────────┘
                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 4. DRAFT -- one LLM tool-call with all evidence in the prompt.       │
│    Tool: submit_answer({ sections: [{ title, body, citationRefs:    │
│    [ledgerRef, ...] }] }).                                           │
└─────────────────────────┬────────────────────────────────────────────┘
                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 5. GROUND -- map each section's citationRefs to working-state entries│
│    Drop sections with no resolvable citations (self-ground-flagged). │
│    Build Evidence[] (one per section claim).                         │
└─────────────────────────┬────────────────────────────────────────────┘
                          ▼
                       RETURN
```

## Budget

```ts
defaultBudget: {
  maxTokens:      80_000,     // classify + select + draft can be hefty on large catalogs
  maxSubCalls:    16,         // classify + select + ~8 dispatches + headroom
  maxWallclockMs: 300_000,    // 5 minutes wall clock
  maxDepth:       3,          // we go L2 -> L1 (classify + select + dispatches); depth 3 is generous
}
```

## Substrate-facing declarations

Light wiring -- the skill itself doesn't cache (each question is new):

```ts
ownerId:            'skill:code.answer-question',
interestedTriggers: ['repo-add', 'reindex', 'manual'],
contextSlots:       [],
memorySchema: [
  // For future observation distillation: "questions about X
  // typically route through Y first".
  { namespace:   'observations',
    valueType:   'WorkspacePatternObservation',
    autoDistill: 'never',
    indexing:    { kind: 'never' },
    ttl:         '30d' },
],
assertionInterests: [],
```

## What the drafting prompt does

System prompt: instruct the LLM to:
1. Read the evidence below (each ledger entry is presented with its `ref`).
2. Emit a `submit_answer` tool-call with structured `sections[]`.
3. EVERY section's `citationRefs` MUST reference at least one ref from the evidence list.
4. Never invent claims that aren't in the evidence; explicit gap callouts when evidence is thin (use a section with a clear "Gap:" prefix).
5. Keep section bodies concise (markdown shape; bullet lists OK).

The grounding step then verifies every `citationRefs` resolves and drops sections that don't ground.

## Tests

### Unit (deterministic-fake provider + canned L1 results)

Per A6: fake-provider tests pin code-path coverage. Live LLM integration exercises judgment.

1. Input validation rejects missing fields.
2. Happy path: classify returns 1 candidate, select-scope fills args, dispatch runs, draft LLM emits a grounded section. Output has 1 section + 1 evidence entry.
3. Classify returns empty candidates → skill returns a single low-confidence "I don't know which skills apply" section.
4. Draft LLM omits citations → grounding drops the section + confidence drops to low.
5. Dispatch fails for one candidate → other candidates still dispatch; failure noted in `dispatched` trace.
6. Budget overflow from too many sub-calls → returns rejection (runtime catches).

### Live local-LLM (`__tests__/live/`)

1. Boots against Ollama + qwen3-coder. Skips gracefully if Ollama isn't reachable.
2. Provides an in-memory LMDB fixture with a small module + one class + one function.
3. Asks a "What entities are defined in this module?" question.
4. Asserts STRUCTURAL properties only:
   - Output schema validates.
   - `sections.length >= 1`.
   - `evidence.length >= 1`.
   - Every `LedgerRef` resolves (runtime would have rejected otherwise).
   - `confidence` is high or medium.
   - At least one section's body references the fixture file (substring family).

## What's intentionally NOT in this pilot

- **Iterative reflect loop.** Single-pass: classify → scope → dispatch → draft. If gaps appear, the LLM surfaces them in a "Gap:" section. A future iteration can add reflect → re-plan → dispatch-more. The migration plan's Phase 6 calls for `meta-narrative-detector` to fold into self-grounding -- that's the loop, deferred.
- **L2 sub-calls.** No callL2; only L1 dispatches. Matches the audit-module pattern.
- **Feedback consumption.** `applyFeedback` not wired. Future iteration.
- **Caching the full answer.** Each question is new; cache hit rate would be near zero.

## Risks

- **Token budget on large catalogs.** Hadoop's catalog passed to classify-question is ~80 skills × catalog summary; the user prompt for classify can reach 8k+ tokens. The audit-module pilot showed qwen3-coder can handle that. Bumping defaultBudget.maxTokens to 80k covers headroom.
- **Local model unreliability on nested tool-calls.** Per the migration plan's risks: qwen3-coder occasionally omits required fields. We rely on the existing one-retry pattern in classify-question + select-scope; the drafting prompt also has retry-on-validation-failure built into the L2 runtime's output validation path.
- **Grounding false negatives.** The LLM may cite a ledger ref that doesn't exist (typo). The runtime drops via `validateGrounding`; confidence drops to low. This is correct behavior per A1.
- **Dispatch failures cascading.** If classify returns 4 candidates and 2 fail to dispatch (e.g., scope mismatch), the answer is still useful from the other 2. We capture failures in `dispatched` trace + a note; we don't fail the whole skill.
