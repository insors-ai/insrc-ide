# Plan: Classification Rewrite

Consolidates every ad-hoc classifier in the codebase into one generic
LLM-backed module. Eliminates keyword matchers, per-classifier prompt
copies, drifting whitelists (see the `brainstorm` missing from
`llm-classify.ts`'s `ALL_INTENTS` today), and the hybrid "LLM first,
keyword fallback" complexity. The cloud active-provider default is the
single source of inference; no text parsing fallback.

---

## Goals

1. One reusable `classify({ classes, text, ... })` module that works
   across every classification use-case in the codebase.
2. Cloud-first execution with a local fallback: calls the configured
   active cloud provider's default model when available; falls back to
   the local Ollama provider when no active cloud is configured; raises
   an error when neither is available. The classification surface
   specifically prefers the strong cloud model so every per-agent
   decision is high-quality, but doesn't dead-end users running a
   local-only setup.
3. No keyword matching, no regex heuristics, no hand-tuned score
   thresholds, no "hybrid fallback" plumbing. The LLM is authoritative.
4. A single allow-list per call (`classes`) threaded through the
   prompt AND used to validate the LLM output -- no more drift.
5. Delete every current classifier implementation and update every
   reference to the new module.

---

## The module

### Location

`src/insrc/agent/classify/index.ts` (new package; replaces the whole
`src/insrc/agent/classifier/` directory after migration).

### Public interface

```ts
import type { LLMProvider } from '../../shared/types.js';

/** Each class the caller wants the LLM to consider. */
export interface ClassChoice {
  /** Machine-readable key returned to the caller. */
  readonly id: string;
  /** Short human-readable label shown to the LLM. */
  readonly label?: string;
  /** One-line description. Strongly encouraged -- without it the LLM
   *  has to guess what the class means. */
  readonly description?: string;
}

export interface ClassifyInput {
  /** The classes to choose from. Order preserved. */
  readonly classes: readonly ClassChoice[];
  /** The user / system text to classify. */
  readonly text: string;
  /** Optional context appended to the prompt. Free-form string --
   *  anything the caller wants the LLM to know (prior intent,
   *  active file, previous user turn, etc.). */
  readonly context?: string;
  /**
   * Optional role hint for the prompt preamble
   * ("You are a <role>. Pick the best class for the text.").
   * Defaults to "classifier".
   */
  readonly role?: string;
}

export interface ClassifyResult {
  /** The `id` of the chosen class. Always one of the `classes[i].id`
   *  values -- if the LLM returned anything else, we fall back to
   *  the first class in the list and set `confidence = 0`. */
  readonly id: string;
  /** 0..1 confidence the LLM reported. */
  readonly confidence: number;
  /** One-sentence reasoning the LLM gave. May be empty. */
  readonly reasoning: string;
  /** Whether the LLM hit an error / unparseable response and we had
   *  to fall back to `classes[0]`. Callers can branch on this. */
  readonly fallback: boolean;
}

/**
 * Run a classification. Uses the provider passed in (expected to be
 * the caller's resolved cloud provider at the appropriate step).
 */
export async function classify(
  input: ClassifyInput,
  provider: LLMProvider,
): Promise<ClassifyResult>;
```

### Prompt shape

```
You are a ${role ?? 'classifier'}. Given the text below, pick EXACTLY
ONE class that best describes it.

## Classes
- ${classes[0].id}: ${classes[0].description ?? classes[0].label ?? ''}
- ${classes[1].id}: ${classes[1].description ?? classes[1].label ?? ''}
...

${context ? `## Context\n${context}\n` : ''}
## Text
${text}

Rules:
- Pick the single best-fit class.
- Return ONLY valid JSON with this schema (no markdown fences, no prose):
  { "id": "<class id>", "confidence": <0..1>, "reasoning": "<one sentence>" }
- `id` MUST be one of the listed class ids verbatim.
- `confidence` 0.9+ for clear matches, 0.7-0.9 reasonable, below 0.7 a guess.
```

### Validation

- JSON parse.
- Reject any `id` that isn't in `classes[].id`.
- Clamp `confidence` to `[0, 1]`.
- On any failure: fall back to `classes[0].id` with `confidence: 0`,
  `reasoning: "<parse error | provider error>"`, `fallback: true`.
  Caller decides whether to retry.

### Provider

The module does NOT resolve providers itself. The caller passes in
the provider it wants. In practice every call site resolves the
provider via a shared helper:

```ts
// Resolves: per-step override -> active cloud default -> local.
//           Throws when neither cloud nor local is available.
function resolveClassifierProvider(session: Session, step: string): LLMProvider {
  const override = session.resolver.resolveOrNull('classifier', step);
  if (override) return override;
  const active = session.config.models.activeProvider;
  if (active && session.cloudProvider) return session.cloudProvider;
  if (session.ollamaProvider) return session.ollamaProvider;
  throw new Error('no classifier provider available (no active cloud and no local Ollama)');
}
```

This honours the cloud-first rule: per-step config first (user
override), then active-cloud default, then local Ollama, then hard
error. The `classify()` module stays agnostic -- whatever provider
it's handed, it calls `provider.complete()` and validates the JSON
response.

---

## Current usage surface

Every classifier call site that needs to migrate:

### 1. Primary intent classification

**Today:**
- [chat-handler.ts:697](../src/insrc/daemon/chat-handler.ts#L697) --
  `classify(enrichedMessage, { llmProvider: classifyProvider })`
- [agent/index.ts:281](../src/insrc/agent/index.ts#L281) -- same.
- [agent/cli.ts:169](../src/insrc/agent/cli.ts#L169) -- same.

All three go through
[classifier/index.ts::classify](../src/insrc/agent/classifier/index.ts)
which delegates to `classifyWithLLM` (cloud) and falls back to
`classifyByKeywords` (local keyword matcher).

**After:**
```ts
const result = await classify({
  role: 'intent classifier for a coding assistant',
  classes: INTENT_CLASSES,          // imported from shared/intent.ts
  text: message,
  context: buildSessionContextHint(signals),
}, session.resolver.resolve('classifier', 'classify'));
```

`INTENT_CLASSES` lives next to the `Intent` type in
`src/insrc/shared/types.ts` (or a dedicated `shared/intent.ts`), single
source of truth. Fixes the drift where `llm-classify.ts::ALL_INTENTS`
was missing `brainstorm`.

### 2. Prompt decomposition (multi-action)

**Today:** [decompose.ts](../src/insrc/agent/classifier/decompose.ts)
builds a 388-line prompt that classifies the primary intent AND extracts
attached sub-requests with relations (augment / append / format /
depends / parallel) plus refs.

**After:** not a pure classification anymore -- it's structured
extraction. Out of scope for the generic `classify` module. Keep as-is
(maybe rename to `extract-actions.ts`) OR deprecate entirely in favour
of "primary intent classify + attached classify chain" -- call out as
a follow-on; not in the rewrite's mandatory scope.

### 3. Brainstorm sub-category

**Today:**
- [brainstorm-category.ts](../src/insrc/agent/classifier/brainstorm-category.ts)
  -- keyword matcher + hybrid entry `classifyBrainstormCategoryHybrid`.
- [llm-brainstorm-category.ts](../src/insrc/agent/classifier/llm-brainstorm-category.ts)
  -- LLM classifier.

Called from [task.ts:1438-1441](../src/insrc/daemon/task.ts#L1438-L1441)
inside `resolveController` for brainstorm turns.

**After:**
```ts
const result = await classify({
  role: 'brainstorm sub-category classifier',
  classes: BRAINSTORM_CATEGORIES,   // from shared/brainstorm.ts
  text: message,
}, session.resolver.resolve('classifier', 'brainstorm-subcategory'));
const category = result.id as BrainstormCategory;
```

Kills both files (`brainstorm-category.ts`, `llm-brainstorm-category.ts`,
~216 lines combined).

### 4. Scope detection (pair vs delegate)

**Today:** [scope.ts](../src/insrc/agent/classifier/scope.ts)
-- keyword matcher ("implement X and Y" => batch; "fix the foo
function" => single).

Called from chat-handler, agent/index, agent/cli, coding.ts.

**After:** classify with two classes: `single` / `batch`. Move to the
new module:
```ts
const result = await classify({
  role: 'coding scope classifier',
  classes: SCOPE_CLASSES,           // { id: 'single' | 'batch' }
  text: message,
}, session.resolver.resolve('classifier', 'scope'));
```

Kills [scope.ts](../src/insrc/agent/classifier/scope.ts).

### 5. Keyword fallback (general)

**Today:** [keywords.ts](../src/insrc/agent/classifier/keywords.ts)
-- 135 lines of regex + score tables for every intent.

**After:** deleted outright. The rewrite's rule is cloud-first ->
local-fallback -> error (see `resolveClassifierProvider`). There is
no keyword layer -- if NEITHER cloud NOR local is available, we
raise instead of silently regex-matching.
[keywords.ts](../src/insrc/agent/classifier/keywords.ts) and the
fallback branch in [classifier/index.ts](../src/insrc/agent/classifier/index.ts)
go away.

### 6. Prefix override

**Today:** [prefix.ts](../src/insrc/agent/classifier/prefix.ts) -- parses
leading `/intent` and `@provider` tokens off the user message.

**After:** keep. Not a classifier, just a pre-parser; survives the
rewrite unchanged (rename to `src/insrc/agent/prefix.ts` or similar
to get it out of the classifier/ directory).

### 7. Signals

**Today:** [signals.ts](../src/insrc/agent/classifier/signals.ts) --
the `SessionSignals` interface only.

**After:** move the type into `src/insrc/shared/classify.ts` alongside
the module. Or delete: the new module's `context` field is a free
string; callers format their own signals into it.

---

## Class definitions (shared)

Move every class list into `src/insrc/shared/` so both daemon and
browser can import without reaching into agent internals:

| File | Export | Used by |
|------|--------|---------|
| `shared/intent.ts` (new) | `INTENT_CLASSES: readonly ClassChoice[]` mirroring the `Intent` union | chat-handler, agent/index, agent/cli |
| `shared/brainstorm.ts` (new) | `BRAINSTORM_CATEGORIES: readonly ClassChoice[]` mirroring `BrainstormCategory` | task.ts resolveController |
| `shared/scope.ts` (new) | `SCOPE_CLASSES: readonly ClassChoice[]` (single / batch) | chat-handler, agent/index, agent/cli, coding.ts |

Each file colocates the class list with a type alias so TS catches
drift -- if you add a new `Intent` union member but forget the
`INTENT_CLASSES` entry the compiler complains.

---

## Deletion list

After migration:

| File | Lines | Status |
|------|------:|--------|
| `src/insrc/agent/classifier/index.ts` | 109 | DELETE (replaced by `src/insrc/agent/classify/index.ts`) |
| `src/insrc/agent/classifier/keywords.ts` | 135 | DELETE (no keyword fallback) |
| `src/insrc/agent/classifier/llm-classify.ts` | 173 | DELETE (replaced by generic classify) |
| `src/insrc/agent/classifier/brainstorm-category.ts` | 118 | DELETE |
| `src/insrc/agent/classifier/llm-brainstorm-category.ts` | 98 | DELETE |
| `src/insrc/agent/classifier/scope.ts` | 45 | DELETE (replaced by generic classify) |
| `src/insrc/agent/classifier/signals.ts` | 29 | DELETE (contract absorbed into ClassifyInput.context) |
| `src/insrc/agent/classifier/decompose.ts` | 388 | KEEP (structured extraction, separate concern) |
| `src/insrc/agent/classifier/prefix.ts` | 69 | KEEP, move out of `classifier/` |

Net removal: **~707 lines** across 7 files.

After the move, the entire `src/insrc/agent/classifier/` directory goes
away -- `decompose.ts` and `prefix.ts` relocate to `src/insrc/agent/`.

---

## Reference update list

Grep-based enumeration of call sites that import from
`agent/classifier/*`:

| Call site | Current import | New import |
|-----------|----------------|-----------|
| `src/insrc/daemon/chat-handler.ts` | `classify`, `detectScope`, `decompose` | `classify` from `agent/classify`, `decompose` from `agent/decompose` |
| `src/insrc/daemon/task.ts` | `classifyBrainstormCategoryHybrid` | `classify` from `agent/classify` + `BRAINSTORM_CATEGORIES` |
| `src/insrc/daemon/controllers/coding.ts` | `detectScopeSimple` (local copy) | `classify` from `agent/classify` + `SCOPE_CLASSES`; delete the local `detectScopeSimple` duplicate at line 533 |
| `src/insrc/agent/index.ts` | `classify`, `detectScope` | `classify` from `agent/classify` |
| `src/insrc/agent/cli.ts` | `classify`, `detectScope` | `classify` from `agent/classify` |

No UI-side call sites -- classification is daemon-internal.

Each migration replaces the old call with a `classify({ ... }, provider)`
invocation. The caller resolves the provider from the session's
resolver so the user's step-provider config (Item 17) controls which
cloud model runs.

---

## Migration plan (ordered)

1. **Add the new module.** `src/insrc/agent/classify/index.ts` +
   `src/insrc/shared/classify.ts` with `ClassifyInput` / `ClassifyResult`.
   Build passes.
2. **Add the shared class lists.** `shared/intent.ts`,
   `shared/brainstorm.ts`, `shared/scope.ts`. Build passes.
3. **Migrate scope detection.** Swap all three call sites + delete
   `scope.ts` + delete `detectScopeSimple` from coding.ts. Build + test.
4. **Migrate brainstorm sub-category.** Swap the single call site in
   task.ts + delete both `brainstorm-category.ts` +
   `llm-brainstorm-category.ts`. Build + test.
5. **Migrate primary intent classify.** Swap the three call sites +
   delete `llm-classify.ts` + `keywords.ts` + `classifier/index.ts`
   fallback branch. Build + test.
6. **Relocate `prefix.ts` and `decompose.ts`.** Move to
   `src/insrc/agent/` and rename imports. Build + test.
7. **Delete the empty `classifier/` directory.** Verify via grep that
   no imports from `agent/classifier/*` remain.
8. **Smoke test.** Run a brainstorm turn + a design turn + a
   plain-chat turn. Confirm the intent-confirm gate fires with the
   new classifier output + shows the same fields.

---

## Out of scope / deferred

- **Keyword fallback.** Keyword matching isn't reintroduced. When
  neither cloud nor local is available, `classify()` raises. Callers
  catch and surface a user-visible error ("configure a provider in
  Model Providers or start Ollama").
- **Automatic cloud<->local retry on cloud API error.** Out of scope
  -- if the cloud call errors, `fallback: true` is set and the
  caller decides whether to retry. The rewrite's fallback chain only
  covers "no provider configured", not "provider errored mid-call".
- **Decompose rewrite.** The structured-extraction decomposer stays
  as-is. A future rewrite could use `classify()` as the primary-intent
  step + a loop for attached actions, but that's its own plan.
- **Cached results.** No caching in the rewrite. The classifier runs
  once per turn; the cloud latency is acceptable.

---

## Verification

- Start fresh chat -> type "Brainstorm around X" -> classify returns
  `brainstorm` with reasoning -> intent-confirm gate shows the exact
  classifier output -> user proceeds -> sub-category classifier runs
  with `BRAINSTORM_CATEGORIES` -> returns `design` -> session activates.
- Type "/implement" prefix -> prefix parser strips, no classifier call.
- Type "add a test for foo AND fix bar" -> scope classifier returns
  `batch` -> delegate agent runs.
- Disable active cloud in Model Providers (still have local Ollama
  running) -> classifier falls back to local, turn proceeds with
  degraded classifier accuracy noted in the log.
- Stop Ollama AND have no active cloud -> classifier raises
  "no classifier provider available" -> chat panel surfaces the
  error instead of silently routing the turn.
- Cloud provider returns an API error mid-call -> `classify()`
  returns `fallback: true` with `confidence: 0` -> caller-side
  error message surfaces; this does NOT automatically retry on
  local (tracked as deferred).

---

## Open questions

1. **Default provider for the classifier.** Today the resolver
   returns `session.resolver.resolve('classifier', 'classify')`
   which falls through to the active cloud default. Should the
   classifier have its own config-level provider override (separate
   from the active cloud) so users can run classification on a
   cheap model even when active cloud is Opus? -- leave as-is (use
   the resolver) and users set `models.agents.classifier.*` in the
   step editor.
2. **Secondary intent.** The old `llm-classify` prompt optionally
   returned a secondary intent. The new module does single-class
   only. If secondary intents matter in practice, callers chain
   two `classify()` calls: one for primary, one for "any other
   relevant intent?" with the primary removed from the class list.
   Keeps the module single-purpose.
