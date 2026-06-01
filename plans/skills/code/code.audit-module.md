# Skill plan: `code.audit-module` (L2 pilot)

**Status:** draft (2026-06-01)
**Owner:** subhagho@gmail.com
**Skill family:** `quality-profile`
**Tier:** L2 (first L2 pilot)
**Substrate owner id:** `skill:code.audit-module`

**Why this is the L2 pilot** (per [`plans/code-analyzer-migration.md`](../../code-analyzer-migration.md) §"Pilot L2 skill"):

> Narrower than `code.answer-question`; the narrower scope is the point. Resist adding "and also handle other-question-shapes" until the narrow pilot succeeds.

Auditing one module is a contained surface where we can prove the L2 model end-to-end without the full open-ended question-answer cycle.

## Goal

Take a `(modulePath, repoPath)` pair, plan its own discovery against the substrate-cached L1 surface, draft an audit, ground every finding to a sub-call ledger entry, return.

## Inputs / Output

```ts
interface AuditModuleInput {
  readonly modulePath: string;
  readonly repoPath:   string;
  // Optional: focus on a specific dimension (otherwise audit looks
  // at all of them). Lets a caller scope down without writing a
  // narrower skill.
  readonly focus?: 'complexity' | 'duplication' | 'unused-exports' | 'cyclic-deps' | 'all';
}

interface AuditFinding {
  readonly kind:       'complexity' | 'duplication' | 'unused-export' | 'cyclic-dep' | 'note';
  readonly severity:   'info' | 'warn' | 'high';
  readonly summary:    string;       // one-line human-readable
  readonly file?:      string;
  readonly line?:      number;
  readonly entityId?:  string;
}

interface AuditModuleOutput {
  readonly module: {
    readonly path:        string;
    readonly fileCount:   number;
    readonly entityCount: number;
    readonly publicCount: number;
  };
  readonly findings: readonly AuditFinding[];
  // One-paragraph natural-language summary the LLM writes.
  readonly summary: string;
}
```

The L2 `SkillOutput<AuditModuleOutput>` adds `evidence` + `confidence` + `notes` (per A1).

## Internal flow

1. **Plan.** Emit `plan-step` event. Decide which L1 sub-calls to dispatch:
   - Always: `code.source.module.describe` (gives module shape).
   - Always: `code.quality.complexity({ repoPath, file: <unset> })` (repo-wide complexity; we'll filter to this module's entities).
   - Conditionally on `focus`:
     - `'duplication'` or `'all'`: `code.quality.duplication`
     - `'unused-exports'` or `'all'`: `code.quality.unused-exports`
     - `'cyclic-deps'` or `'all'`: `code.quality.cyclic-deps`
2. **Dispatch.** Call sub-calls SEQUENTIALLY (per CLAUDE.md no-parallel-LLM; even though the L1 skills don't reach LLMs, sequential keeps things simple and respects the budget linearly). Each `callL1` auto-appends to the working state.
3. **Filter.** Reduce repo-wide quality reports to entries scoped to this module's files (we can do this in-process; no extra sub-call).
4. **Draft.** Single LLM call with:
   - The module's surface (from module.describe).
   - The scoped quality entries.
   - A system prompt asking for a JSON tool-call with `{ findings, summary }`.
   - Each finding MUST cite an entity that appears in the gathered evidence.
5. **Ground.** For every finding the LLM emitted, locate the corresponding ledger entry (the sub-call result whose payload contains the cited entityId / file / line). Build the `Evidence[]` array. Drop any finding that can't be grounded to a ledger entry (`self-ground-flagged` event).
6. **Return.** `SkillOutput<AuditModuleOutput>` with `evidence` + `confidence` (high when grounded findings >= LLM-emitted findings; medium when some dropped; low when nothing grounds).

## Budget

```ts
defaultBudget: {
  maxTokens:      30_000,   // single draft LLM call shouldn't need more
  maxSubCalls:    8,        // describe + complexity + 3 optional quality
  maxWallclockMs: 60_000,   // 60s wall clock
  maxDepth:       2,        // we don't recurse into other L2 skills
}
```

## Substrate-facing declarations

Light wiring -- the skill itself doesn't cache (the underlying L1 cache + classify-question observations cover it). Declare ownership only:

```ts
ownerId:            'skill:code.audit-module',
interestedTriggers: ['repo-add', 'reindex', 'manual'],
contextSlots:       [],
memorySchema: [
  { namespace:   'audits',
    valueType:   'AuditModuleOutput',
    autoDistill: 'on-pin',  // the skill MAY pin its own output for repeat audits
    indexing:    { kind: 'never' },
    ttl:         '24h' },
  { namespace:   'observations',
    valueType:   'WorkspacePatternObservation',
    autoDistill: 'never',
    indexing:    { kind: 'never' },
    ttl:         '30d' },
],
assertionInterests: [],
```

## Tests

### Unit (deterministic-fake provider + canned L1 results)

Per A6: fake providers are fine for narrow code-path coverage but NOT sufficient as the only safety net. These unit tests pin:
- Input schema rejection (missing modulePath / repoPath).
- Sub-call dispatch -- describe + complexity always fire; focus-conditional fires correctly.
- Filter reduces repo-wide complexity to scoped module entries.
- Grounding -- when the LLM emits a finding citing a non-existent entityId, the runtime's grounding validator catches it.

### Live local-LLM integration (`__tests__/live/`)

Per A6: required for any L2 skill. Tests:
1. **End-to-end on a small fixture module.** Boots against Ollama (qwen3-coder or similar). Provides a real `code.source.module.describe` + `code.quality.complexity` against an in-memory fixture LMDB. Asserts:
   - Output validates against the schema.
   - `evidence` is non-empty.
   - Every `LedgerRef` resolves.
   - At least one `findings` entry references a file from the input module (substring family).
   - `confidence` is `'high'` or `'medium'` (not `'low'`).
2. **Skips gracefully when Ollama isn't available** (per the established Hadoop-test pattern -- check + skip).
3. **Property-based assertion:** if input mentions `'complexity'` focus, output `findings.kind` MUST include `'complexity'` for at least one entry.

### NOT in scope for tests

- Asserting LLM prose quality. Per A6: never exact-string match.
- Cloud LLM. Per A6 + budget concerns.
- Real Hadoop module (the fixture LMDB is simpler + faster than spinning up Hadoop's graph).

## What's intentionally NOT in this pilot

- **Cross-domain calls** (calling data skills). This skill is code-only.
- **L2 nesting** -- no `deps.callL2` (depth 1 suffices for an audit). Tests still verify the depth-cap mechanism via the runtime suite.
- **Feedback consumption** -- `applyFeedback` not wired. When user assertions land via the classifier, a future iteration can read them.
- **`code.answer-question`** -- separate pilot per the migration plan.

## Risks

- **Local-model viability.** Per the migration doc's risks: qwen3-coder has been unreliable for nested tool-call payloads. The draft prompt uses a single tool-call with a structured schema (same shape as the migrated meta-skills); if it still fails, document the LLM-side issue + adjust the prompt (don't widen the runtime).
- **Token budget for large modules.** Hadoop's NameNode module has 100+ entities. The scoped complexity report passed to the LLM could be large. Mitigation: truncate to top-N most-complex entries in the prompt; surface the truncation in `notes`.
- **Grounding false negatives.** The LLM may emit a valid finding but cite an entityId that doesn't match exactly (e.g. shortened hash). Mitigation: the grounding step tries to match by file + line first, then by entityId substring. Don't over-aggressively drop.
