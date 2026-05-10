# Intent classification consolidation

**Status:** draft (2026-05-11)
**Owner:** subhagho@gmail.com
**Standing rule:** **every code path that needs to know the user's intent goes through `resolveIntent(session, message)`. There is no other legal way.**

## Why

We have **seven separate classification entry points** in `src/insrc/`. Each carries its own LLM prompt, its own rules, and its own subset of context (active repo / prior intent tag / slash-command list / continuation hints). They drift independently. The most recent symptom: a `/code-analyze` follow-up of "elaborate on the core filesystem design/architecture" was classified as `research` because it ran through the *decomposer*'s rules ("Informational questions ('what is X', 'how does X work') are 'research' intent") instead of the *classifier*'s sharpened rules (which had the right "in-repo question = code-analysis" tiebreaker plus the active-repo signal).

### Current state -- seven paths

| # | Module | Purpose | Sees active repo? | Sees prior intent? | Notes |
|---|---|---|---|---|---|
| 1 | `agent/decompose.ts` | Splits messages, picks intent | No | No | Causes the bug; runs first |
| 2 | `agent/classify/intent.ts` (`classifyPrimaryIntent`) | Picks intent | Yes | No | Best rules; only runs on fallback |
| 3 | `agent/classify/index.ts` (`classify`) | Generic LLM classifier | Via context | No | Substrate for #2 |
| 4 | `agent/classify/scope.ts` (`classifyScope`) | Scope tier (S..XXXXL) | Via context | No | Orthogonal axis; fine to keep |
| 5 | `agent/intent/resolver.ts` (`resolveIntent`) | Tag-reuse + cold-classify | Yes | **Yes** | Lowest-risk path; **not wired in** |
| 6 | `agent/intent/enhancer.ts` | Rewrites question with prior facts | Yes | Yes | Consumes intent; doesn't pick it |
| 7 | `agent/prefix.ts` (`parsePrefix`) | `/intent <name>` overrides | n/a | n/a | Currently short-circuits before classify |

### Current dispatch matrix

```
chat-handler.runChatMessage
  /code-analyze X     ─→ runCodeAnalyzerSlash    skips ALL classification
  /data-analyze X     ─→ runDataAnalyzerSlash    skips ALL classification
  /intent <name> X    ─→ parsePrefix             override; skips classifier
  /<other slash> X    ─→ slashIdToIntent map     skips classifier
                X     ─→ decompose (LLM)         if confidence > 0.6 keeps decomposer's intent
                                                 ─→ else falls through to classifyPrimaryIntent
```

### Where the rules diverge

- **decompose.ts** has a hardcoded "Informational questions ... are 'research' intent" rule with no active-repo signal. Misclassifies in-repo "elaborate on X" / "describe X" / "explain X" prompts.
- **classify/intent.ts** + **INTENT_CLASSES** has the inverse rule: "research is EXTERNAL-ONLY; in-repo questions default to code-analysis". With the active-repo prior block.
- **resolver.ts** has continuation-detection (`looksLikeContinuation`) for follow-ups like "now show me HDFS Core" but is never called.
- **chat-handler slash paths** stamp no `[intent:current]` tag (or stamp inconsistently — only the Phase 4 fix to `/code-analyze` does this), starving the next turn of intent context.

---

## Goals

1. **One funnel for intent.** Every chat path -- regular, every slash, resume, re-run -- calls exactly one function: `resolveIntent(session, message)`. Returns `ResolvedIntent`.
2. **Decomposer stops classifying.** It still splits messages into primary + attached actions; the intent of each action comes from the resolver.
3. **One source of truth for intent semantics.** `INTENT_CLASSES` + `buildClassifierContext` are the only place rules ("what is research?", "what is code-analysis?", "in-repo prior") live.
4. **Slash commands skip the LLM but not the funnel.** They feed `resolveIntent` a synthetic `ResolvedIntent { source: 'slash-forced' }`, which still stamps the `[intent:current]` tag so the *next* turn benefits.
5. **Tag stamping happens exactly once per turn**, by `resolveIntent`. No manual `setTag(INTENT_TAG_CURRENT, ...)` anywhere else.

## Non-goals

- This plan does NOT change the multi-action decomposition feature (primary + attached actions, file refs, dependencies, format directives). That stays.
- This plan does NOT change scope classification (`classifyScope`). That's a separate axis -- size of work, not type of work.
- This plan does NOT touch the question-enhancer. It's a downstream consumer of the resolver's output and stays as-is.
- This plan does NOT change agent dispatch (controllers, runControlledPipeline, runTaskPipeline). The intent-to-controller routing is unchanged; only how intent gets *picked* changes.

---

## Architecture

### The contract

```ts
// agent/intent/resolver.ts -- the only legal entry point for intent.
export async function resolveIntent(
  session: Session,
  rawMessage: string,
  opts?: ResolveIntentOpts,
): Promise<ResolvedIntent>;

interface ResolveIntentOpts {
  /** Slash-forced intent: skip classifier; stamp tag with this id. */
  readonly slashForced?: Intent | undefined;
  /** Override (from `/intent <name>` prefix): skip classifier; stamp tag. */
  readonly explicitOverride?: Intent | undefined;
}

interface ResolvedIntent {
  readonly id:               Intent;
  readonly source:
    | 'slash-forced'         // /code-analyze, /data-analyze, /design, etc.
    | 'override'             // /intent <name>
    | 'tag'                  // continuation heuristic + prior tag reuse
    | 'classified-fresh'     // cold LLM classify, no prior tag
    | 'classified-shifted';  // cold LLM classify, intent shifted from prior
  readonly previousIntent?:  Intent | undefined;
  readonly confidence:       'high' | 'medium' | 'low';
  readonly reasoning:        string;
  readonly message:          string;     // prefixes stripped
  readonly scope?:           ScopeSize | undefined;  // when classifier ran
}
```

### Internal flow

```
resolveIntent(session, rawMessage, opts)
  ├─ if opts.slashForced: synthesize ResolvedIntent{ source: 'slash-forced' }
  │     → stamp [intent:current] = slashForced
  │     → return
  ├─ parsePrefix(rawMessage)
  │     ├─ if intentOverride: synthesize ResolvedIntent{ source: 'override' }
  │     │     → stamp tag → return
  ├─ readIntentTag(session) → priorId
  ├─ if priorId && looksLikeContinuation(message): reuse
  │     → ResolvedIntent{ id: priorId, source: 'tag' }
  │     → refresh tag timestamp → return
  └─ cold path: classifyPrimaryIntent(message, session)
        → ResolvedIntent{ id, source: 'classified-fresh' | 'classified-shifted' }
        → stamp tag → return
```

`classifyPrimaryIntent` is the only caller of the underlying generic `classify()` for intent. The decomposer never calls it; nothing calls `classify()` for intent except this one function.

### Decomposer's new role

```ts
// agent/decompose.ts -- splits a message into primary + attached actions.
export async function decompose(
  message: string,
  provider: LLMProvider,
  conversationHistory?: ...,
): Promise<DecomposeResult>;

// Action shape no longer carries an `intent` field. Caller resolves
// each action's intent via resolveIntent(session, action.action) in
// parallel after decompose returns.
```

The decomposer's system prompt drops:
- The hardcoded intent list
- The "Informational questions are research" rule
- The "primary research" examples
- The output schema's `intent` field

What stays:
- Primary / attached structural splitting
- Relation types (augment / append / format / depends / parallel)
- File reference extraction
- Output format directives
- `commandHint` for infra/deploy

### chat-handler.ts dispatch (after consolidation)

```ts
// 1. Family-direct slashes -- forced intent, but go through resolver.
if (slashCommand === 'code-analyze') {
  const resolved = await resolveIntent(session, prompt, { slashForced: 'code-analysis' });
  return runCodeAnalyzerSlash(active, ..., resolved);
}
if (slashCommand === 'data-analyze') {
  const resolved = await resolveIntent(session, prompt, { slashForced: 'data-analysis' });
  return runDataAnalyzerSlash(active, ..., resolved);
}

// 2. Intent slashes -- /design, /plan, /implement, etc.
if (intentSlashShortcut) {
  const resolved = await resolveIntent(session, prompt, { slashForced: intentSlashShortcut });
  // ... single-action flow, no decompose call
}

// 3. Regular chat path.
const decomposed = await decompose(message, decomposeProvider, history);
const actions = [decomposed.primary, ...decomposed.attached];
const resolvedActions = await Promise.all(
  actions.map(a => resolveIntent(session, a.action))
);
// Pair each action with its resolved intent; route as before.
```

`resolveIntent` is the only function that touches `[intent:current]`. Every path that reaches it stamps the tag, so the next turn always has a prior to reuse.

---

## Phase 1 -- resolver becomes the canonical entry

`agent/intent/resolver.ts`:

- Add `ResolveIntentOpts` to the public signature with `slashForced` + `explicitOverride`.
- When `slashForced` is set, synthesize a `ResolvedIntent` with `source: 'slash-forced'`, confidence `'high'`, reasoning `'forced by slash command'`. No LLM call. Stamp tag.
- When `explicitOverride` is set, same shape with `source: 'override'`.
- Move the prefix parsing inside resolveIntent (so callers don't need to call `parsePrefix` separately).
- Rest of the function (tag-reuse fast path + cold-classify) is unchanged.

Tests:
- slashForced bypasses classifier entirely; tag is stamped; confidence is 'high'.
- explicitOverride bypasses classifier entirely; tag is stamped.
- existing tag-reuse + classified-fresh + classified-shifted paths still work.

## Phase 2 -- decomposer stops classifying

`agent/decompose.ts`:

- Delete `ALL_INTENTS` constant.
- Rewrite `DECOMPOSE_SYSTEM`: drop intent rules / examples / "Informational questions" line; drop the `intent` field from the output schema.
- Replace with a tighter system prompt that asks ONLY for structural decomposition (primary + attached + relation + refs + format + commandHint).
- Update parsers (`parseAction`, `parsePrimaryAttached`) to read actions without an `intent` field. Action carries `action`, `subject`, `relation`, etc., but NOT `intent`.
- Update `DecomposedAction` interface accordingly.

Tests:
- Decomposer returns structured actions with no intent field.
- Multi-action splitting still works ("design X then implement it" → 2 actions, depends relation).
- File ref extraction still works.
- The rule from the bug ("Informational questions ... are research") is gone -- explicit test that the prompt does NOT contain the string.

## Phase 3 -- chat-handler routes everything through resolveIntent

`daemon/chat-handler.ts`:

- Family-direct slash dispatchers (`runCodeAnalyzerSlash`, `runDataAnalyzerSlash`): call `resolveIntent(session, prompt, { slashForced: 'code-analysis' | 'data-analysis' })` BEFORE dispatching to the orchestrator. Pass the resolved object into the orchestrator (replaces the existing tag-stamping I added in Phase 4 of conversation-flow-refinement).
- Intent slashes: same -- call `resolveIntent(..., { slashForced: <intent> })`.
- Regular chat path: call `decompose(...)` for structural split; then for each action call `resolveIntent(session, action.action)` in `Promise.all`. Pair actions with their resolved intents.
- Delete the fallback `classifyPrimaryIntent` call (line 1803). Resolver handles all intent resolution now.
- Delete any direct `setTag(INTENT_TAG_CURRENT, ...)` calls scattered through the file (the orchestrator's `buildInitialTasks` had one; remove). Resolver is the only writer.

Tests:
- /code-analyze X stamps tag; orchestrator receives ResolvedIntent.
- Regular chat with single action calls resolver once.
- Regular chat with multi-action calls resolver N times in parallel.
- Follow-up turn after /code-analyze: tag is present; resolver hits the fast path with continuation heuristic.

## Phase 4 -- prune redundant code

- `agent/classify/intent.ts:classifyPrimaryIntent` becomes private (or moves into `agent/intent/resolver.ts`). Only resolver calls it.
- Remove any standalone `parsePrefix` consumer in chat-handler -- resolver handles prefixes now.
- Remove the orchestrator's `INTENT_TAG_CURRENT` / `INTENT_TAG_TIMESTAMP` writes from `buildInitialTasks` (made redundant by the slash-forced resolver path).

Tests:
- All existing intent / classify / resolver tests still pass.
- New integration test: a 2-turn session where turn 1 is `/code-analyze describe this repo` and turn 2 is `elaborate on the core filesystem design`. Assert turn 2 resolves to `code-analysis` via the tag-reuse fast path (no LLM classify call). This is the regression test for the bug that triggered this plan.

## Phase 5 -- documentation + rule enforcement

- Add a one-paragraph "Intent classification" section to `CLAUDE.md`: states the rule. Lists `resolveIntent` as the only legal entry point.
- Add a `// CLAUDE: do not classify intent here -- call resolveIntent(session, message) instead.` banner comment at the top of any module that previously had its own classification (decompose, classify/intent, etc.).
- Lint rule (or PR-review checklist item): no new code path may import `classify` for intent purposes; only the resolver may.

## Phase 6 -- regression suite

- Test: every chat-handler dispatch path stamps the `[intent:current]` tag exactly once.
- Test: any file under `src/insrc/agent/` other than `intent/resolver.ts` that imports `classifyPrimaryIntent` fails CI (grep-based assert).
- Test: the decomposer's system prompt does not contain any intent-classification rules (grep-based assert).

---

## Sequencing

Sequential -- each phase depends on the previous. Suggested order:

1. **Phase 1** (resolver gains slash-forced path) -- 1 day. Independently testable.
2. **Phase 2** (decomposer prompt rewrite) -- 1-2 days. Locks the bug fix in. Independently testable.
3. **Phase 3** (chat-handler rewires) -- 2 days. The big surgery.
4. **Phase 4** (prune dead code) -- 0.5 day.
5. **Phase 5** (docs / rule enforcement) -- 0.5 day.
6. **Phase 6** (regression suite) -- 1 day.

Total estimate: 6-7 days of focused work.

---

## Standing rule (record this in CLAUDE.md after Phase 5)

> **All intent classification goes through `resolveIntent(session, message)`. No other module classifies user-message intent. The decomposer splits structure only; it does not pick intents. Slash-forced paths still call `resolveIntent` with `{ slashForced }` so the `[intent:current]` tag stays consistent across paths and the next turn can reuse it. New code that wants to know the intent of a user message imports `resolveIntent` from `agent/intent/resolver.ts` -- no exceptions.**

This rule is recorded in:
- `CLAUDE.md` (top-level project conventions)
- This plan (`plans/intent-classification-consolidation.md`)
- The Claude Code agent's persistent memory at `~/.claude/projects/.../memory/`
