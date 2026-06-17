# Plan: Memory + Context substrate integration

Implementation plan for the design at [`design/memory-context.html`](../design/memory-context.html).

Wires the existing memory substrate ([`src/insrc/daemon/substrate/`](../src/insrc/daemon/substrate/),
~3,300 LOC, P0–P10 done) into the chat surface, the meta-task framework, and individual
meta-task templates. **No new memory machinery is built** — the substrate already provides
owner-scoped typed storage, user-assertion classifier, feedback bus, context assembler, and
Lance ANN. The work here is integration, not invention.

## Status

Pre-implementation. Design landed 2026-06-17 ([design/memory-context.html](../design/memory-context.html))
covering 10 gaps (G1–G10), all resolved. This plan written 2026-06-17 immediately after.

## Related plans + design

- **Design**: [`design/memory-context.html`](../design/memory-context.html) — full contract,
  resolved gaps, end-to-end worked example.
- [`plans/memory-context-substrate.md`](./memory-context-substrate.md) — substrate's own
  design (D1–D15, locked). Foundation; this plan consumes it.
- [`plans/skills/substrate-implementation-status.md`](./skills/substrate-implementation-status.md) —
  substrate's implementation phases (P0–P10 done). Reference for "what's already there."
- [`design/meta-tasks.html`](../design/meta-tasks.html) — meta-task framework that gains the
  `preferences` slot in M2.
- [`design/meta-task-plan.html`](../design/meta-task-plan.html) — `/plan` template's design;
  M3 here gates on its M4.a.
- [`plans/TODO.md`](./TODO.md) — tracks (a) the 7 externalizable settings landed in M1 and
  (b) the legacy `config/` retirement checklist.

## Goals

1. **Capture every user assertion durably.** Wire chat-handler to invoke
   `runtime.classifyAssertion(turn)` per G1's "both passive + targeted, LLM-classify every
   turn" rule. Land Layer 3 confirm UX (G2) as a non-blocking chat surface + gate-modal-embedded
   variant.
2. **Surface preferences as foundational guidance.** Extend the L1 system segment
   (`src/insrc/agent/context/system.ts`) to merge active-owner curated preferences into the
   chat-side prompt. Event-driven cache invalidation via the substrate's `FeedbackBus`.
3. **Externalize the 7 confidence + threshold settings** identified in G2 + G7 into the
   user settings framework (`insrcConfiguration.ts`).
4. **Plumb the substrate into the meta-task framework.** Add the `kind: 'preferences'`
   `ContextRequest` slot + substrate-backed fetcher + framework-mandatory auto-injection on
   every step's phase-1 fulfillment.
5. **Land per-template owner declarations.** Existing meta-task templates declare
   `ownerId` + `assertionInterests` + `memorySchema`. Substrate registers owners at template
   registry boot.
6. **Verify the worked example end-to-end.** "Always include unit tests" captured in chat →
   stored as constraint on `agent:meta-task:plan` → surfaces in the next `/plan implement: ...`
   run.
7. **Optional backstop**: implicit-capture-during-retrieval (G8). Off by default; flag enables.

## Non-goals

- **Not** building new memory machinery. The substrate provides everything we need; we wire
  it in.
- **Not** migrating the legacy `config/` callers. Those follow each consumer's own retirement
  schedule (per G10 + per-consumer plans). `config/` deprecation is already stamped (G10
  commit).
- **Not** building the dedicated `/prefs` editor pane. The slash command + Layer 3 confirm
  toast/modal cover M1 needs; the dedicated pane is a later UX upgrade.
- **Not** sync-across-machines or cloud-backed preferences. Substrate is workspace-local
  (D5); preferences stored under the same constraint.
- **Not** changing the substrate's design (D1–D15 locked). Anything that would require
  reopening a D-decision is a separate plan.

## Architecture summary

```
chat user turn
   │
   ├──> intent resolver (existing, unchanged)
   │
   └──> chat-handler (M1)
         │
         ├──> classifyAssertion (substrate runtime, LLM hook now wired to Ollama)
         │     │
         │     ├──> AssertionIndex.lookup -> matched owners
         │     ├──> per owner: memory.scope(owner, 'user-assertions').put(...)
         │     │   (G7 confidence dynamics applied at write)
         │     └──> FeedbackBus.emit -> invalidates L1 cache for matched owners
         │
         ├──> Layer 3 confirm (IDE toast / gate-embed) on low confidence
         │
         └──> conversation store turn record gains assertionRefs (G6)

next chat turn
   │
   └──> ContextManager.build (M1 extends L1 builder)
         │
         └──> L1 system =
              static project instructions  (existing, cached per session)
            + active-owner curated preferences  (substrate scan + G5 curation;
                                                  event-driven cache invalidation)

next meta-task /plan invocation
   │
   └──> runMetaTask -> per step phase-1 (M2)
         │
         └──> framework auto-injects {kind: 'preferences', scope, stepIntent}
               │
               └──> fetchPreferences (substrate scan + G4 hard filter + G5 LLM curation)
                     │
                     └──> chunk -> phase-2 prompt
```

## File layout (target end state for M1–M5)

```
src/insrc/daemon/
  chat-handler.ts                              MODIFY (M1): classifyAssertion invocation
  substrate/
    classifier/user-assertion.ts               MODIFY (M1): Layer 2 LLM hook -> Ollama
    runtime.ts                                 MODIFY (M1): expose IPC for chat-handler

src/insrc/internal-ipc/handlers/
  classify-assertion.ts                        NEW  (M1): substrate.classifyAssertion IPC
  preferences-list.ts                          NEW  (M1): for /prefs UX
  preferences-edit.ts                          NEW  (M1)
  preferences-discard.ts                       NEW  (M1)

src/insrc/agent/context/
  system.ts                                    MODIFY (M1): merge active-owner preferences

src/insrc/meta-task/
  types.ts                                     MODIFY (M2): + ContextRequestPreferences
  schema.ts                                    MODIFY (M2): + validator
  fetchers.ts                                  MODIFY (M2): + fetchPreferences
  orchestrator.ts                              MODIFY (M2): auto-inject in phase-1
  templates/plan.ts                            MODIFY (M3, lands with /plan M4.a)
  templates/review.ts                          MODIFY (M3)
  index.ts                                     MODIFY (M3): substrate owner registration

src/vs/workbench/contrib/insrc/browser/
  chat/chatView.ts                             MODIFY (M1): /prefs slash + Layer 3 toast
  chat/chatLayer3ConfirmToast.ts               NEW  (M1)
  preferences/prefsRunner.ts                   NEW  (M1)

src/vs/workbench/contrib/insrc/common/
  insrcConfiguration.ts                        MODIFY (M1): 7 externalized settings

src/insrc/daemon/substrate/
  implicit-capture.ts                          NEW  (M5)
  implicit-capture-state.ts                    NEW  (M5)

src/insrc/db/conversations.ts                  MODIFY (M1): + assertionRefs field
```

---

## Phase ordering

| Phase | Scope | Status |
|-------|-------|--------|
| Phase 0 | Verification of substrate readiness (no code change) | – |
| M1 | Chat-side capture + retrieval end-to-end; settings externalized; /prefs slash | ahead |
| M2 | Meta-task `preferences` slot + fetcher + auto-injection | depends on M1 |
| M3 | Per-template owner declarations + worked example green | depends on M2 + `/plan` M4.a |
| M4 | `config/` deprecation marker | **done** (in G10 commit) |
| M5 | Implicit-capture-during-retrieval backstop | depends on M2 |

**Coherence guarantee:** each phase touches a file at most once. No phase reworks a previous
phase's artifacts. The substrate primitives stay locked throughout; this plan only adds
consumers + wiring around them.

---

## Phase 0: Verification (no code change)

Confirm that the substrate is in the state the design assumes. ~half day.

### 0.1 Substrate tests still green

```
npx tsx --test src/insrc/daemon/substrate/__tests__/*.test.ts
```

All P0–P10 tests must pass. If any are red, fix or rollback before starting M1.

### 0.2 Confirm classifier's LLM hook is injectable

[`substrate/classifier/user-assertion.ts`](../src/insrc/daemon/substrate/classifier/user-assertion.ts):16
documents the hook as "INJECTABLE — the default returns 'defer' so the substrate stays
LLM-free until the daemon wires the active provider." Confirm the constructor accepts a
provider override; this is the M1 wiring point.

### 0.3 Confirm AssertionIndex routing works

```
npx tsx --test src/insrc/daemon/substrate/__tests__/classify-assertion-integration.test.ts
```

The integration test exercises the runtime's `classifyAssertion` end-to-end (classifier →
index → memory write → feedback bus). Should already be green per P5.

### 0.4 Audit settings framework

Confirm `src/vs/workbench/contrib/insrc/common/insrcConfiguration.ts` is the canonical
registration point (it is per the audit) and that new `insrc.memory.*` keys won't collide
with existing keys (they won't).

**Exit criteria for Phase 0**:
- [ ] Substrate test suite green.
- [ ] Classifier LLM hook confirmed injectable.
- [ ] Routing integration test green.
- [ ] Settings framework ready for new keys.

---

## M1 — Chat-side capture + retrieval + /prefs + settings

End state: a user can state a preference in chat, see the Layer 3 confirm bubble (or silent
toast on high-confidence accept), have the preference stored as a substrate constraint
under `agent:chat`, and observe it surface in the L1 system segment of the next chat turn.
The 7 confidence/threshold parameters are externalized as user settings.

This phase is the largest. ~5–7 days.

### M1.1 New files

```
src/insrc/internal-ipc/handlers/classify-assertion.ts
src/insrc/internal-ipc/handlers/preferences-list.ts
src/insrc/internal-ipc/handlers/preferences-edit.ts
src/insrc/internal-ipc/handlers/preferences-discard.ts
src/vs/workbench/contrib/insrc/browser/chat/chatLayer3ConfirmToast.ts
src/vs/workbench/contrib/insrc/browser/preferences/prefsRunner.ts
src/vs/workbench/contrib/insrc/browser/preferences/media/prefsConfirm.css
```

### M1.2 Modified files

```
src/insrc/daemon/substrate/classifier/user-assertion.ts   wire Layer 2 LLM hook to Ollama
src/insrc/daemon/substrate/runtime.ts                     read 7 settings; expose IPC
src/insrc/daemon/chat-handler.ts                          invoke classifyAssertion per turn
src/insrc/db/conversations.ts                             + assertionRefs on TurnRecord
src/insrc/agent/context/system.ts                         merge active-owner preferences
src/insrc/agent/context/index.ts                          subscribe to FeedbackBus
src/insrc/shared/types.ts                                 + agent:chat owner namespace constants
src/vs/workbench/contrib/insrc/common/insrcConfiguration.ts   7 new settings
src/vs/workbench/contrib/insrc/browser/chat/chatView.ts   /prefs slash + Layer 3 mount points
```

### M1.3 Settings externalization

Add to `insrcConfiguration.ts` under a new `insrc.memory` section (per the existing
[`insrc.permissions`](../src/vs/workbench/contrib/insrc/common/insrcConfiguration.ts#L55)
shape):

```ts
'insrc.memory.assertionClassifier.autoAcceptThreshold': { type: 'number', default: 0.85, ... },
'insrc.memory.assertions.baseScore':                    { type: 'number', default: 0.80, ... },
'insrc.memory.assertions.reinforcementRate':            { type: 'number', default: 0.50, ... },
'insrc.memory.assertions.refinementDecay':              { type: 'number', default: 0.15, ... },
'insrc.memory.assertions.weakeningDecay':               { type: 'number', default: 0.40, ... },
'insrc.memory.assertions.contradictionDecay':           { type: 'number', default: 0.65, ... },
'insrc.memory.assertions.noiseThreshold':               { type: 'number', default: 0.30, ... },
```

All values are read at daemon startup + on settings change via the existing
`IConfigurationService` watcher. The substrate runtime gets a `MemoryConfig` deps shape
populated from these.

### M1.4 Layer 2 LLM hook wiring

`substrate/classifier/user-assertion.ts` accepts a `Phase2Hook` constructor arg. M1 wires it
to the active local Ollama provider:

```ts
const hook: Phase2Hook = async (candidate, existingSameSubject) => {
  const response = await ollama.complete([
    { role: 'system', content: USER_ASSERTION_CLASSIFIER_SYSTEM },
    { role: 'user', content: buildPrompt(candidate, existingSameSubject) },
  ], { responseFormat: { schema: ASSERTION_RESPONSE_SCHEMA } });
  return parseAssertionResponse(response.text);
};
```

The schema constrains output to:
```
{ verdict: 'accept' | 'reject' | 'defer',
  confidence: number,
  subject: PreferenceSubject,    // closed-enum (G3)
  relationship: AssertionRelationship,    // G7
  canonicalText: string,
  scope: { categories?: string[]; repoPaths?: string[] },    // G4
  rationale: string }
```

### M1.5 Chat-handler invocation

`chat-handler.ts` gains a `classifyTurnAssertion()` step. Runs:

1. **Regex fast-skip** for clearly-non-assertion turns (single slash commands, empty,
   sub-token-length).
2. Otherwise: **synchronous wait** for Layer 2 LLM (~sub-second on Ollama). Same-turn
   application requires the classifier's write to complete before the turn dispatches
   downstream — per G1's same-turn synchronous decision.
3. On `verdict: 'accept'` + confidence ≥ `autoAcceptThreshold`: substrate runtime persists.
   Toast emitted.
4. On `verdict: 'accept'` + confidence < `autoAcceptThreshold` or `verdict: 'defer'`:
   Layer 3 confirm bubble.
5. On `verdict: 'reject'`: silent discard.

### M1.6 Layer 3 confirm UX (IDE-side)

`chatLayer3ConfirmToast.ts` renders a chat-inline toast with three buttons + free-text
customize editor. State machine:

- Idle → Showing (toast appears at chat-message position)
- Showing → SaveClicked → Persisted (toast collapses to "✓ Saved")
- Showing → CustomizeClicked → Editor (inline editor: canonical text, scope dropdowns)
- Editor → SaveClicked → Persisted
- Showing → DiscardClicked → DiscardedNotPersisted (substrate writes `kind: 'hint'` with
  `pendingConfirm: false` so future passes skip)
- Idle, no action for 60s → Persisted as `kind: 'hint'` with `pendingConfirm: true` (G2's
  no-silent-loss rule).

### M1.7 /prefs slash command

`prefsRunner.ts` wires `chatView.ts`'s slash intercept (mirror handoffRunner pattern):

- `/prefs` (no args) — list active owner's preferences, render as chat bubble.
- `/prefs edit <id>` — open Customize editor for an existing entry.
- `/prefs discard <id>` — confirm-and-discard.
- `/prefs save <text>` — explicit capture path; force Layer 3 path (always confirms).

IPC handlers `preferences-list.ts` / `preferences-edit.ts` / `preferences-discard.ts` are
thin wrappers over `memory.scope(owner, 'user-assertions').{scan,put,delete}`.

### M1.8 L1 system extension (G9)

`agent/context/system.ts`'s `buildSystemContext` adds a per-owner section:

```ts
export async function buildSystemContext(opts: SystemContextOpts): Promise<string> {
  const staticPart = buildStaticInstructions(opts);            // existing
  const preferences = await buildOwnerPreferencesSection(opts);  // NEW
  return [staticPart, preferences].filter(s => s.length > 0).join('\n\n');
}
```

`buildOwnerPreferencesSection`:
1. Resolves the active owner from session metadata (`agent:chat` default; meta-task or
   Pair/Delegate owner when one's active).
2. Cache lookup: if a curated set is cached and not invalidated, return it.
3. Cache miss: scan owner's `user-assertions`, apply G4 hard scope filter (just `repoPath`
   for chat), call Ollama with the G5 curation prompt against the session's rolling topic
   (built from L3a recent + L2 summary).
4. Cache the curated set.
5. Format as `## Active preferences\n- ...` markdown.

`ContextManager` constructor subscribes to substrate's `FeedbackBus` for the active owner.
On `FeedbackEvent` matching the owner, invalidate the preferences cache. On
`chatService.onDidChangeSession` (owner transition), invalidate.

### M1.9 Conversation store schema bump (G6)

`db/conversations.ts`:

```ts
export interface TurnRecord {
  // ... existing fields ...
  readonly assertionRefs?: readonly string[] | undefined;
}
```

Codec for `assertionRefs` lands in `db/codec.ts` (or wherever `TurnRecord` is encoded).
Migration: no migration needed — undefined for existing turns is the default; storage
layer treats missing field as undefined.

### M1.10 Tests

```
src/insrc/daemon/__tests__/chat-handler-classify-assertion.test.ts       NEW
src/insrc/daemon/substrate/__tests__/user-assertion-ollama-hook.test.ts   NEW
src/insrc/agent/context/__tests__/system-preferences-section.test.ts     NEW
src/insrc/internal-ipc/handlers/__tests__/preferences-*.test.ts          NEW
```

Plus a smoke test that runs:
1. Inject a scripted "always include unit tests" turn via chat-handler.
2. Verify substrate has an entry at `agent:chat/user-assertions/...`.
3. Build context for the next turn; assert preferences appear in L1.
4. Toggle a confidence-decay scenario; assert behavior.

**Exit criteria for M1**:
- [ ] All new + modified files compile.
- [ ] Substrate test suite still green.
- [ ] New tests green.
- [ ] One end-to-end captured preference visible in next-turn L1 system segment when
      running the daemon manually.
- [ ] Settings UI shows the 7 new keys; changing them takes effect on next classifier
      invocation.

---

## M2 — Meta-task `preferences` slot + fetcher + auto-injection

End state: meta-task framework has the new `kind: 'preferences'` `ContextRequest` variant;
fetcher pulls owner preferences with G4 hard filter + G5 LLM curation; orchestrator
auto-injects a preferences request into every step's phase-1 fulfillment. `/review`
template gets it for free (no per-template changes needed — owner-level interest declaration
comes in M3).

~2–3 days.

### M2.1 New files

(none — all changes are in existing meta-task module files)

### M2.2 Modified files

```
src/insrc/meta-task/types.ts                + ContextRequestPreferences
src/insrc/meta-task/schema.ts               + validator + relationship discriminator
src/insrc/meta-task/fetchers.ts             + fetchPreferences (substrate scan + LLM curation)
src/insrc/meta-task/orchestrator.ts         auto-inject in phase-1
src/insrc/meta-task/__tests__/fetchers.test.ts          add preferences fetcher tests
src/insrc/meta-task/__tests__/orchestrator.test.ts      add auto-injection tests
```

### M2.3 `ContextRequestPreferences` type

```ts
export type ContextRequestPreferences = {
  readonly kind: 'preferences';
  readonly scope?: {
    readonly templateId?: string;
    readonly category?: string;
    readonly repoPath?: string;
  };
  readonly stepIntent?: string;          // for G5 curation
};
```

Added to the discriminated union `ContextRequest`. Schema validator follows existing
fetchers' patterns.

### M2.4 `fetchPreferences`

```ts
export async function fetchPreferences(
  req: ContextRequestPreferences,
  inputs: FetchInputs,
): Promise<ContextChunk> {
  const owner = `agent:meta-task:${req.scope?.templateId ?? '__unknown__'}` as OwnerId;
  const memory = await getSubstrateMemory();
  const raw = await Array.fromAsync(memory.scope(owner, 'user-assertions').scan(''));
  const scoped = raw.filter(matchesScope(req.scope));   // G4 hard filter
  if (scoped.length === 0) {
    return { request: req, status: 'empty', payload: [] };
  }
  // G5 local-LLM relevance curation
  const relevant = await curateRelevance(scoped, req.stepIntent, inputs.ollama);
  return { request: req, status: 'ok', payload: relevant };
}
```

`curateRelevance` calls Ollama with the inclusion-biased curation prompt; returns the subset
the LLM judged applicable.

### M2.5 Orchestrator auto-injection

`orchestrator.ts` step-execution path:

Before phase-1 fulfillment, the orchestrator pre-pends a synthetic `ContextRequestPreferences`
to whatever the cloud LLM asked for. The fetcher dispatch sees this as just another slot in
the requested set; the slot fetcher handles it like any other.

When the cloud LLM emits `kind: 'sufficient'`, the orchestrator currently skips fetcher
invocation entirely. M2 changes that: preferences slot still runs even on `sufficient` —
documented exception per G5.

### M2.6 Tests

Scripted preferences in a tmp substrate; scripted cloud LLM; verify:
- Slot is auto-injected even when cloud said `sufficient`.
- Hard scope filter respects categories + repoPaths.
- LLM curation called with the right `stepIntent`.
- Empty owner short-circuits without LLM call.

**Exit criteria for M2**:
- [ ] All meta-task tests green (including the new ones).
- [ ] A scripted "always include unit tests" preference written to
      `agent:meta-task:plan/user-assertions/...` surfaces in a `/review`-template phase-1 fulfillment
      with the auto-injection path.
- [ ] No regression in M2's existing 5 orchestrator tests.

---

## M3 — Per-template owner declarations + worked example green

End state: meta-task templates declare `ownerId`, `assertionInterests`, and `memorySchema`
at registration time. Substrate's `lifecycle-runner` is invoked from the template registry
boot path to register the owner. End-to-end worked example
([design/memory-context.html §6](../design/memory-context.html#worked-example))
is green: capture in chat → reuse in next `/plan implement: ...`.

This phase depends on `/plan` template M4.a landing first (per
[design/meta-task-plan.html](../design/meta-task-plan.html) §11).

~2–3 days.

### M3.1 Modified files

```
src/insrc/meta-task/templates/index.ts            substrate owner registration on register()
src/insrc/meta-task/templates/plan.ts             ownerId + interests + memorySchema (M4.a artifact)
src/insrc/meta-task/templates/review.ts           same
src/insrc/meta-task/__tests__/owner-registration.test.ts                NEW
src/insrc/meta-task/__tests__/end-to-end-preferences.smoke.ts           NEW (live-LLM gated)
```

### M3.2 Template declarations

`templates/plan.ts` (extending the M4.a artifact):

```ts
export const planTemplate: MetaTaskTemplate = {
  id: 'plan',
  // ... existing fields ...
  ownerId: 'agent:meta-task:plan',
  schemaVersion: 1,
  assertionInterests: [
    { subjectPattern: 'test-policy',          description: 'Test coverage + style for plans' },
    { subjectPattern: 'documentation-policy', description: 'Doc requirements for plan steps' },
    { subjectPattern: 'code-style',           description: 'Code conventions reflected in plan steps' },
    { subjectPattern: 'architecture-policy',  description: 'Architectural patterns for plan steps' },
    { subjectPattern: 'workflow-policy',      description: 'Workflow conventions for plans' },
  ] satisfies readonly AssertionInterest[],
  memorySchema: [
    { namespace: 'user-assertions', kind: 'constraint' },
  ],
};
```

`templates/review.ts`: similar, narrower interests (review-relevant: `test-policy`,
`code-style`, `security-policy`).

### M3.3 Registry registration

`templates/index.ts`'s `registerTemplate()` calls the substrate's `runtime.registerOwner()`
with the template's declared fields. Lifecycle runner handles bootstrap dispatch.

```ts
export function registerTemplate(template: MetaTaskTemplate): void {
  if (REGISTRY.has(template.id)) {
    throw new Error(`meta-task template '${template.id}' already registered`);
  }
  REGISTRY.set(template.id, template);
  if (template.ownerId !== undefined) {
    substrateRuntime.registerOwner({
      ownerId:           template.ownerId,
      schemaVersion:     template.schemaVersion ?? 1,
      assertionInterests: template.assertionInterests ?? [],
      memorySchema:      template.memorySchema ?? [],
    });
  }
}
```

### M3.4 End-to-end worked example smoke test

`end-to-end-preferences.smoke.ts` (gated by `INSRC_LIVE_LLM=1`):

1. Spin up daemon with substrate + fresh fixture workspace.
2. Inject chat turn: "For this repo, always include unit tests in implementation plans."
3. Assert: substrate has entry at `agent:meta-task:plan/user-assertions/...` with
   `subject: 'test-policy'` and `scope.categories: ['implementation']`.
4. Inject `/plan implement: add a new user model`.
5. Capture the resulting plan markdown.
6. Assert: at least one step references unit tests / coverage / test-related work.

**Exit criteria for M3**:
- [ ] Template tests green.
- [ ] Smoke test green (when run with live LLM).
- [ ] Manual end-to-end via chat panel + IDE works.

---

## M4 — `config/` deprecation marker

**DONE**. Landed in commit `3ff402a177d` (G10 resolution). No additional work.

---

## M5 — Implicit-capture-during-retrieval backstop (G8)

End state: the substrate scans recent unclassified turns at preference-slot fulfillment
time, with per-session cached state to keep cost bounded. Surfaces candidates
**asynchronously** on next chat interaction. Off by default; controlled by a settings
flag.

~3–4 days.

### M5.1 New files

```
src/insrc/daemon/substrate/implicit-capture.ts
src/insrc/daemon/substrate/implicit-capture-state.ts
src/insrc/daemon/substrate/__tests__/implicit-capture.test.ts
```

### M5.2 Modified files

```
src/insrc/daemon/substrate/runtime.ts                                  expose implicit pass + state mgmt
src/insrc/daemon/chat-handler.ts                                       surface candidates on next turn
src/insrc/meta-task/fetchers.ts                                        run pass during preferences fetch
src/insrc/agent/context/system.ts                                      run pass during L1 build
src/vs/workbench/contrib/insrc/common/insrcConfiguration.ts            + insrc.memory.implicitCapture.enabled
```

### M5.3 `ImplicitCaptureState` storage

Per (sessionId, owner). LMDB-backed (substrate's existing store).

```ts
export interface ImplicitCaptureState {
  readonly sessionId:          string;
  readonly owner:              OwnerId;
  readonly lastScannedTurnIdx: number;
  readonly candidates:         readonly ImplicitCandidate[];
  readonly dismissedTurnIdxs:  readonly number[];
}

export interface ImplicitCandidate {
  readonly turnIdx:      number;
  readonly assertion:    AssertionPayload;
  readonly relationship: AssertionRelationship;
  readonly proposedAt:   number;     // unix ms
}
```

### M5.4 Implicit pass

`implicit-capture.ts`:

```ts
export async function runImplicitPass(
  sessionId: string,
  owner: OwnerId,
  deps: ImplicitDeps,
): Promise<ImplicitCaptureState> {
  const state = await deps.loadState(sessionId, owner) ?? freshState(sessionId, owner);
  const newTurns = await deps.conversations.getTurnsSince(sessionId, state.lastScannedTurnIdx);
  if (newTurns.length === 0) {
    return state;
  }
  const candidates = [...state.candidates];
  const dismissedSet = new Set(state.dismissedTurnIdxs);
  for (const turn of newTurns) {
    if (dismissedSet.has(turn.idx)) continue;
    const result = await deps.classifier.classify({ ... turn ... });
    if (result.verdict === 'accept') {
      candidates.push({ turnIdx: turn.idx, assertion: result.payload, relationship: result.relationship, proposedAt: Date.now() });
    } else {
      dismissedSet.add(turn.idx);
    }
  }
  const next = { ...state, lastScannedTurnIdx: newTurns[newTurns.length - 1]!.idx, candidates, dismissedTurnIdxs: [...dismissedSet] };
  await deps.saveState(next);
  return next;
}
```

### M5.5 Asynchronous surfacing

`chat-handler.ts`: before processing a user turn, fetch any pending implicit candidates
for the active owner. If non-empty, append a toast event to the IPC stream
("Found N pending preferences from earlier turns — review?"). Layer 3 confirm UX (reused
from M1) handles each candidate.

### M5.6 Settings

```ts
'insrc.memory.implicitCapture.enabled': {
  type: 'boolean', default: false,
  description: 'Enable implicit-capture-during-retrieval (scan recent turns at slot fulfillment).',
},
```

(Add to `plans/TODO.md` Settings section.)

### M5.7 Tests

- Scripted session with 10 turns, classifier-stub varying verdicts.
- Run pass twice — second pass only scans new turns.
- Dismissed turns skipped on second pass.
- Async surfacing emits the expected event shape.

**Exit criteria for M5**:
- [ ] Implicit-capture tests green.
- [ ] End-to-end: enable the flag, miss a preference at capture time (force classifier
      unavailable), let it surface on next interaction.

---

## Validation strategy

Mirror the meta-task framework's test layout:
- Per-module unit tests under `__tests__/` next to the module.
- Smoke tests under `__tests__/*.smoke.ts` gated by `INSRC_LIVE_LLM=1`.
- One end-to-end "captured preference applied in next /plan run" smoke covers the worked
  example.

Coverage targets:
- `chat-handler.ts` classifier invocation branches: ≥ 90 %.
- `fetchPreferences` + G4 + G5 plumbing: ≥ 90 %.
- L1 system preferences section + cache invalidation: ≥ 90 %.
- `implicit-capture.ts` incremental scan: ≥ 85 %.

Daemon test runs incrementally (`npx tsx --test ...`) per phase; IDE-side hygiene
+ build runs at end of each phase (`bash scripts/build.sh ide`).

## Timeline estimate (rough)

| Phase | Effort (single dev) |
|-------|--------------------|
| Phase 0 | ~0.5 day |
| M1 | ~5–7 days |
| M2 | ~2–3 days |
| M3 | ~2–3 days (depends on `/plan` M4.a landing) |
| M5 | ~3–4 days |

**Total (M1 → M5)**: ~13–17 days for one dev. M3 has an external dependency on the `/plan`
template's M4.a; the rest are sequential within this plan.

## Risks + mitigations

- **Substrate test regression during M1 modifications.** Mitigation: phase 0 confirms green
  baseline. Any M1 commit that breaks substrate tests reverts before merge.
- **Ollama latency hurts chat UX.** Per-turn classifier adds ~sub-second. Acceptable per
  accuracy-first; if it becomes a UX problem, profile + optimize the assertion prompt
  (shorter system, response-schema-constrained output).
- **L1 cache invalidation race.** FeedbackBus is fire-and-forget (D8). If invalidation
  arrives after the next L1 build started, the next-next turn picks it up. Mitigation:
  document the eventual-consistency window; no fix needed.
- **Layer 3 toast collision with other chat UI.** Mitigation: the toast inherits the chat
  gate framework's mount surface; existing gates aren't displaced because the toast renders
  inline at the message position, not modally.
- **Per-template owner registration fails after `/plan` M4.a regression.** M3 has a guard:
  if substrate runtime isn't available, template registers but skips owner; substrate
  consumers (preferences slot) gracefully return empty.
- **Setting changes during in-flight classification.** Substrate runtime reads settings
  at write time, not init. Settings change mid-classification of a turn uses the value
  in effect at write. Acceptable.

## Out-of-scope follow-ups

Tracked here so they don't get lost:

- **Dedicated `/prefs` editor pane** (workbench editor; like the meta-task report pane).
  Slash command + Layer 3 toast cover the M1 needs; this is UX polish.
- **Cross-session implicit recall** — implicit-capture is per-session in M5; cross-session
  would need a separate cross-session index. Speculative; revisit only if user evidence
  surfaces.
- **Preference categories i18n** — the 12-category enum descriptions are English-only.
  Out of scope until insrc itself ships i18n.
- **Programmatic preference API** — currently preferences are read by chat L1 + meta-task
  fetcher. If a CLI / external integration needs preference reads, add an IPC handler at
  that point. Speculative.
- **Per-owner preference export/import** — `/prefs export` / `/prefs import` for sharing
  preferences across workspaces. Speculative; not in the plan until ask surfaces.
