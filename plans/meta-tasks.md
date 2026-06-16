# Plan: Meta-tasks framework

Implementation plan for the design at [`design/meta-tasks.html`](../design/meta-tasks.html).

Builds the framework layer above `/handoff`: a structured orchestrator that decomposes a high-level
intent (`/design`, `/plan`, `/implement`, `/migrate`, `/review`) into ordered steps, runs each through
a two-phase context-then-task cycle, accumulates results to disk, and supports user-driven plan revision
when reality diverges.

## Status

Pre-implementation. Design landed 2026-06-16 ([design/meta-tasks.html](../design/meta-tasks.html));
implementation plan written 2026-06-16 immediately after. Targets the framework + a minimal `/plan`
module only — per-template design docs (`design/meta-task-<name>.html`) gate M6.

## Related plans + design

- **Design**: [`design/meta-tasks.html`](../design/meta-tasks.html) — contract for the two-phase model,
  retry loops, plan revision, persistence, heartbeats, IDE surface reuse.
- [`plans/external-agent-integration.md`](./external-agent-integration.md) — handoff is the leaf primitive
  meta-tasks invoke; the spec/audit/deliverable shape comes from here.
- [`plans/section-flow-architecture-redesign.md`](./section-flow-architecture-redesign.md) — section-flow
  is the step-runner meta-tasks plug into. The Q8 todo-orchestrator work lands a `TodoList`-driven
  executor we reuse.
- `src/insrc/agent/planner/` — the existing planner agent, distilled into the `/plan` meta-task in M4
  and deleted at the same milestone.
- `src/insrc/daemon/controllers/code-analyzer-orchestrator.ts` — the emission pattern (`liveStep` +
  `progress` + `todos` + `gate` + `updateListBody`) meta-tasks reuse verbatim for IDE surface.

## Goals

1. Ship the wire contract and schema validators for the two-phase model: `ContextRequest`,
   `Phase1Ask`, `Phase1Result` (with `needs-narrowing` push-back), `Phase2Out` (with cloud-declared
   `resolution` on abort).
2. Ship the local-LLM-driven context fetcher: one slot kind at a time, wired to `db/search.ts`, the
   LMDB graph layer, Lance ANN, and the memory store. Honors byte caps; emits `needs-narrowing` with
   structured hints when requests are too broad.
3. Ship the meta-task orchestrator: two-phase loop, two independent retry caps (narrowing 2,
   context-needed 3), 30 s heartbeat, JSONL persistence under `~/.insrc/meta/<id>/`. Both phases
   verbatim (no orchestrator paraphrasing).
4. Ship a single end-to-end meta-task template (`/review`) wired to the daemon IPC and the existing
   chat surface. Zero new IDE components — `liveStep` + `progress` + `todos` + `gate` already do
   everything we need.
5. Ship composability: one meta-task invoking another as a sub-meta-task (shared persistRoot
   sub-namespace, headless gate inheritance). Lays the path for `/design` and friends invoking
   `/plan`.
6. Migrate the existing `plannerAgent` to a `/plan` meta-task definition. Delete
   `src/insrc/agent/planner/`. Migrate Delegate to invoke `/plan` as a sub-meta-task. No
   compatibility shim.
7. Ship user-driven plan revision: abort gate with `[Adjust plan] [New plan] [Retry step]
   [Abort meta-task]` actions + free-text feedback. `maxPlanRevisions: 2` cap.
8. Ship the full template set (`/design`, `/implement`, `/migrate`, `/review`) — gated on each
   template having its own design doc.

## Non-goals

- Replacing handoff. Handoff stays the leaf primitive; meta-tasks invoke handoffs (via the
  existing `handoff.run` IPC) where the leaf is an editing operation.
- Replacing section-flow. Section-flow is the step-runner; meta-tasks are recipes section-flow
  executes.
- New IDE chat components, new gate UI, new report pane. Reuse code-analyzer's emission set
  verbatim. The one new IDE bit is the meta-task chat card (modeled on `chatHandoffWidget`),
  which lands in M5.
- Cross-language template support beyond what handoff already covers (TS / Py / Go / Java / Scala).
- Per-template substance (the step content of `/design`, `/implement`, etc.). Those land in their
  own design docs + their own implementation milestones inside M6.
- Embedding the cloud LLM. Cloud calls go through the existing `LLMProvider` interface; no new
  provider plumbing.
- Resuming a meta-task across daemon restarts in M1–M5. The persistence layout supports it (JSONL
  + append-only logs); the resume logic lands later as a follow-up.

## Architecture summary

```
chat (/<template>) → daemon IPC: meta-task.run
                         │
                  ┌──────▼───────────────────────────────┐
                  │  meta-task orchestrator (daemon)      │
                  │  ┌──────────────────────────────────┐ │
                  │  │  per step:                        │ │
                  │  │    phase 1 ask  (cloud LLM)       │ │
                  │  │    phase 1 fulfill (local LLM)    │ │
                  │  │    ↕ narrowing loop (cap 2)       │ │
                  │  │    phase 2 task (cloud LLM)       │ │
                  │  │    ↕ context-needed loop (cap 3)  │ │
                  │  │    abort? → user gate             │ │
                  │  └──────────────────────────────────┘ │
                  │  emits: liveStep / progress / todos / │
                  │         gate / updateListBody          │
                  │  persists: ~/.insrc/meta/<id>/         │
                  └────────────────┬──────────────────────┘
                                   │
                  ┌────────────────┴───────────────┐
                  ▼                                ▼
            handoff.run                    sub-meta-task.run
            (when leaf is                  (when leaf is another
             an editing op)                 meta-task, e.g. /plan)
```

Process boundaries unchanged: orchestrator runs in the daemon (DB access invariant preserved).
IDE talks to it via existing IPC stream patterns. Cloud / local LLM calls go through the existing
`LLMProvider` factory.

## File layout (target end state)

```
src/insrc/meta-task/
  index.ts                          # runMetaTask() entrypoint
  types.ts                          # ContextRequest, Phase1Ask/Result, Phase2Out, ContextChunk
  schema.ts                         # validators (parse + reject malformed)
  orchestrator.ts                   # two-phase loop, retries, abort routing
  context-fetcher.ts                # local-LLM driver: one slot at a time
  fetchers/
    entities.ts                     # kind: 'entities' fulfillment
    files.ts                        # kind: 'files'
    deliverable.ts                  # kind: 'deliverable'
    semantic.ts                     # kind: 'semantic'
    graph.ts                        # kind: 'graph'
    git.ts                          # kind: 'git'
    trace.ts                        # kind: 'trace'
    memory.ts                       # kind: 'memory'
  heartbeat.ts                      # 30 s timer + status string composer
  persist.ts                        # ~/.insrc/meta/<id>/ layout + JSONL appenders
  sub-meta-task.ts                  # nested invocation contract
  event-emitter.ts                  # liveStep / progress / todos / gate emit helpers
  templates/
    index.ts                        # registry + dispatch
    review.ts                       # M2 first end-to-end template
    plan.ts                         # M4: migrated planner
    design.ts                       # M6: gated on design doc
    implement.ts                    # M6: gated on design doc
    migrate.ts                      # M6: gated on design doc
  __tests__/
    schema.test.ts
    context-fetcher.test.ts
    retries.test.ts
    orchestrator.test.ts
    sub-meta-task.test.ts
    review-template.smoke.ts        # scripted-LLM E2E
src/insrc/daemon/
  meta-task-stream.ts               # daemon-side IPC handler (mirrors handoff-stream.ts)
src/vs/workbench/contrib/insrc/browser/meta-task/
  chatMetaTaskWidget.ts             # M5: chat card (mirrors chatHandoffWidget)
  metaTaskFlowContribution.ts       # M5: auto-open report pane on completion
```

---

## Phase 0: Pre-work (prerequisites)

Before phase 1. Small, defensive.

### 0.1 Verify section-flow leaf executor accepts new owner types

Section-flow's `TodoList` already has an `owner` field. Confirm the workbench `TodoListPane` renders
correctly when `owner === 'meta-task'`. If per-owner conditional rendering is needed (per design §10),
add a single switch on `owner` at the relevant render call site. No new pane.

**Files to check**:
- `src/insrc/agent/section-flow/leaf-executor.ts` — confirm it tolerates a meta-task-owned list
- `src/vs/workbench/contrib/insrc/browser/todos/todoListPane.ts` — confirm rendering
- `src/insrc/shared/agent-registry.ts` — add `'meta-task'` to the AgentFamily union with category
  `'orchestration'`, `suppressTodoComments: true` (mirror of how `'handoff'` was added)

### 0.2 Confirm cloud LLM streaming + local LLM tool surface

- Verify `LLMProvider.complete()` supports the structured-output mode we'll use for `Phase1Ask` /
  `Phase2Out` (JSON-schema-constrained responses). Today the chat path uses tool-calling for
  structured outputs; check that's compatible with our schemas in `agent/providers/factory.ts`.
- The local-LLM fetcher needs read-only tool access. Inventory what it can call:
  - `db/search.ts` exports (`searchEntities`, `findCallers`, `findCallees`, `resolveClosure`,
    `closureEntities`, `unreachableEntities`, `sccEntities`)
  - `db/entities.ts` (`getEntityByName`, etc.)
  - `db/conversations.ts` (memory access)
  - `db/relations.ts` for graph operations
  - File reads against the registered repo (bounded by scope)
- These already exist. The fetcher just composes them. No new DB primitives.

**Output**: short audit note (committed inline as a comment in `context-fetcher.ts`) listing the
DB exports the fetcher uses and confirming none need new primitives.

---

## Phase M1: Wire shapes + local-LLM context fetcher

End state: types + schema + per-slot fetchers + heartbeat plumbing, all unit-tested. No
orchestrator yet.

### M1.1 New files

```
src/insrc/meta-task/types.ts
src/insrc/meta-task/schema.ts
src/insrc/meta-task/context-fetcher.ts
src/insrc/meta-task/fetchers/{entities,files,deliverable,semantic,graph,git,trace,memory}.ts
src/insrc/meta-task/heartbeat.ts
src/insrc/meta-task/__tests__/{schema,context-fetcher,heartbeat}.test.ts
```

### M1.2 `types.ts` — wire shapes

Direct translation of design §5 into TypeScript. Discriminated unions on `kind`; readonly fields;
narrow string literals for enums (`'user-required' | 'plan-revisable'`).

Pin: `EntityKind` is imported from `shared/types.ts`; `HandoffVerdict` is imported from
`handoff/types.ts` (we reuse it for the per-step audit verdict).

### M1.3 `schema.ts` — validators

Hand-written validators (consistent with the codebase's existing pattern — see
`src/insrc/handoff/spec/validate.ts`). Reject:

- `Phase1Ask` with `kind: 'context-needed'` and empty `requests` (must be `kind: 'sufficient'`)
- `Phase2Out` with `kind: 'context-needed'` and missing/empty `reason`
- `ContextChunk` with `status: 'needs-narrowing'` and missing `narrowingHint`
- `Phase2Out` with `kind: 'abort'` and missing `resolution`
- Any malformed `ContextRequest` (wrong slot fields per kind)

Validators export `validatePhase1Ask` / `validatePhase1Result` / `validatePhase2Out` /
`validateContextRequest` returning `{ok: true} | {ok: false, errors: string[]}`. Errors are
informative — they go into the orchestrator's JSONL trace and the cloud LLM's next retry prompt.

### M1.4 `fetchers/<slot>.ts` — per-slot fulfillment

One file per `ContextRequest['kind']`. Each exports:

```ts
export type FetchOpts = {
  request:   ContextRequestKindN;
  scope:     ScopeManifest;          // bounds the search to the meta-task's repo + globs
  byteCap:   number;                 // hard cap; emit needs-narrowing if exceeded
  catalog:   DeliverableCatalog;     // for `kind: 'deliverable'`
};

export async function fetch(opts: FetchOpts): Promise<ContextChunk>;
```

Fetcher rules:
- Honors `byteCap` — never emits payload larger than cap.
- Picks under cap when the cloud has set a `topK` or accepts truncation (`status: 'partial'`).
- Emits `status: 'needs-narrowing'` with a `narrowingHint` (match count, suggested filters,
  alternative kinds) when the request is too broad to fulfill cleanly:
  - `files`: glob matches > 10× cap or spans > 3 top-level dirs without filters
  - `semantic`: no `topK` and corpus size > 1000
  - `graph`: depth-unbounded closure or matches > cap
  - `entities`: > 100 matches without a `repos` filter
- Emits `note` field with the rationale (used in retry prompts).

Slot-specific notes:
- `kind: 'deliverable'` reads from `~/.insrc/meta/<id>/` (current meta-task) or
  `~/.insrc/handoffs/<sid>/` (referenced handoffs). The catalog is built once at orchestrator
  startup and passed to every fetcher invocation; no per-fetch directory scan.
- `kind: 'memory'` calls into `db/conversations.ts` ANN over `turn_vec` + `config_vec`. Mirrors
  the cold-classify memory bundle path in `agent/intent/resolver.ts`.
- `kind: 'graph'` op-by-op dispatch to `db/search.ts` exports.

### M1.5 `context-fetcher.ts` — the driver

Top-level entry: `fulfill(ask: Phase1Ask, scope: ScopeManifest, catalog: DeliverableCatalog)`.
- Returns `Phase1Result` (chunks + meta).
- Loops over `ask.requests` in order; per-request `fetch()` call.
- Aggregates `Phase1Result.meta`: total bytes, elapsed ms, dropped count (status: 'error' counts).
- **No** local-LLM call yet here; the per-fetch local-LLM reasoning is at the slot level (e.g.,
  `semantic` and `files` fetchers may invoke the local LLM via `LLMProvider` to do final
  pick-under-cap reasoning).

### M1.6 `heartbeat.ts` — 30 s timer

```ts
export class Heartbeat {
  constructor(opts: {
    intervalMs?: number;            // default 30_000
    longThresholdMs?: number;       // default 600_000
    onTick: (status: string) => void;
  });
  start(initialStatus: string): void;
  updateStatus(status: string): void;   // resets the silence-since timer
  stop(): void;
}
```

`updateStatus()` is called on every emission (`liveStep` chunk, tool call, etc.) so the
heartbeat only fires when nothing else has emitted within 30 s. After `longThresholdMs` elapsed
with no activity, the tick callback receives a status with `— consider /abort` appended.

### M1.7 Tests

- `schema.test.ts` — round-trip every valid shape; reject ~12 malformed shapes.
- `context-fetcher.test.ts` — table-driven per-slot fetchers; verify cap honoring, narrowing
  trigger thresholds, `status: 'partial'` vs `'needs-narrowing'` boundary.
- `heartbeat.test.ts` — timer fires after 30 s of silence; `updateStatus` resets; long-threshold
  suffix appended; `stop()` clears.

**Exit criteria for M1**: all tests pass; one ad-hoc script (`scripts/test-context-fetcher.ts`)
demonstrates fetching each slot kind against a real repo.

---

## Phase M2: Orchestrator + `/review` template (single-step E2E)

End state: a user can run `/review <intent>` from chat, see the full code-analyzer-style activity
(liveStep bubbles + progress bar + TodoList + final report pane), and get a real cloud-LLM-produced
review deliverable. Single-step, no plan, no composability yet.

### M2.1 New files

```
src/insrc/meta-task/orchestrator.ts
src/insrc/meta-task/index.ts
src/insrc/meta-task/persist.ts
src/insrc/meta-task/event-emitter.ts
src/insrc/meta-task/templates/index.ts
src/insrc/meta-task/templates/review.ts
src/insrc/daemon/meta-task-stream.ts
src/insrc/meta-task/__tests__/{retries,orchestrator}.test.ts
src/insrc/meta-task/__tests__/review-template.smoke.ts
```

### M2.2 Modified files

```
src/insrc/shared/types.ts                                # add IpcStreamKind 'meta-task'
src/insrc/daemon/server.ts                               # register 'meta-task.run' RPC
src/insrc/shared/agent-registry.ts                       # already done in Phase 0
src/vs/workbench/contrib/insrc/browser/chat/chatView.ts  # /review intercept (slash command)
```

### M2.3 `persist.ts` — disk layout

Matches design §8. Top-level helper:

```ts
export class MetaTaskStore {
  constructor(metaTaskId: string);
  readonly root: string;                            // ~/.insrc/meta/<id>/
  writeMeta(meta: MetaTaskMeta): Promise<void>;
  writePlan(plan: Plan): Promise<void>;             // also appends to plan.history.jsonl
  appendStepPhase1(stepIndex: number, entry: Phase1LogEntry): Promise<void>;
  appendStepPhase2(stepIndex: number, entry: Phase2LogEntry): Promise<void>;
  writeStepDeliverable(stepIndex: number, slug: string, body: string): Promise<void>;
  writeStepAudit(stepIndex: number, audit: AuditResult): Promise<void>;
  writeSynthesis(body: string): Promise<void>;
  readAll(): Promise<MetaTaskState>;                // for resume / inspection
}
```

JSONL appenders are crash-safe (one record per line, write-then-flush).

### M2.4 `event-emitter.ts` — IDE surface wiring

Thin shim over the daemon's IPC `send` + the in-process `TodosApi`. Exports a `MetaTaskEmitter`
class with methods that map 1:1 to the code-analyzer emission set:

```ts
export class MetaTaskEmitter {
  emitLiveStep(step: string, text: string, done?: boolean): void;
  emitProgress(step: string, status: string): void;     // also taps Heartbeat.updateStatus
  emitGate(gate: GateRequest): Promise<GateResolution>;
  todos: TodosApi;                                       // pass-through
  emitTodosBody(listId: string, body: string): Promise<void>;
}
```

Naming convention for `step` strings (so the chat bubble label reads cleanly):
`meta-task:<template> / <step.name>: <substate>` — e.g.
`meta-task:review / R1 analyze: phase-1 ctx (narrowing 1/2)`.

### M2.5 `orchestrator.ts` — the two-phase loop

The core. ~400-500 LOC. Exports `runMetaTask(opts: RunMetaTaskOpts): Promise<MetaTaskResult>`.

```ts
async function runMetaTask(opts: RunMetaTaskOpts): Promise<MetaTaskResult> {
  // 1. Allocate metaTaskId, init store, emit initial state.
  // 2. Run scope step (template.scope(intent, repo, memory) -> ScopeManifest).
  // 3. Run plan step (template.plan(scope) -> Plan). For /review (M2) this is trivial:
  //    plan = [{ name: 'R1 analyze', intent: scope.intent, acceptance: ... }].
  // 4. Approve gate (M5: real gate; M2: auto-accept).
  // 5. For each step in plan:
  //    a. Build phase-1 prompt (step def + deliverable catalog + retry context if any).
  //    b. Cloud LLM -> Phase1Ask. Validate or kick to retry.
  //    c. If 'sufficient', skip fetcher; else fulfill via context-fetcher.
  //    d. If any chunk needs-narrowing, narrowing-retry loop (cap 2).
  //    e. Build phase-2 prompt (step def + chunks + retry context if any).
  //    f. Cloud LLM -> Phase2Out. Validate.
  //    g. Route by Phase2Out.kind:
  //       'deliverable'     -> persist; emit done; mark step complete; next step
  //       'context-needed'  -> retry loop (cap 3); if cap exhausted, force best-effort or abort
  //       'abort'           -> user gate (M5: real flow; M2: just fail)
  //    h. Audit (reuse handoff's audit pass when leaf is a code edit; for analysis-only
  //       templates like /review, audit is a soft check that the deliverable has the required
  //       sections).
  // 6. Synthesis step (for multi-step templates; /review is single-step so this is a no-op).
  // 7. Write final body via emitTodosBody; flow contribution auto-opens the report pane.
}
```

Retry loop primitives (in-file private functions): `runNarrowingLoop()`, `runContextNeededLoop()`,
each takes a cap + a builder for the verbatim retry prompt described in design §6.

### M2.6 `templates/review.ts` — the first template

```ts
export const reviewTemplate: MetaTaskTemplate = {
  id: 'review',
  worktreeMode: 'none',                       // /review is read-only
  scope: defaultScopeFn,                       // shared scope analyzer
  plan: scope => ({
    steps: [{
      name: 'R1 analyze',
      intent: scope.intent,
      acceptance: [
        { kind: 'soft', id: 'has-findings', description: 'Deliverable lists at least one finding.' },
      ],
    }],
  }),
  // Single step. No synthesis.
  synthesize: undefined,
};
```

Templates register themselves in `templates/index.ts` via a registry pattern (`registerTemplate`).
Dispatch by id at orchestrator start.

### M2.7 `daemon/meta-task-stream.ts` — IPC handler

Mirrors `handoff-stream.ts`. Subscribes to events the orchestrator emits and forwards them to the
IDE via the existing IPC stream layer. `done` / `error` terminal messages on success / failure.

### M2.8 IDE-side: `/review` slash intercept

In `chatView.ts`, register `/review` alongside the existing `/handoff` intercept. Routes to the
daemon's new `meta-task.run` IPC, streams events back. **Zero new IDE components** — the existing
chat panel already renders `liveStep`, `progress`, `todos` mutations, and `gate` events.

### M2.9 Tests

- `retries.test.ts` — table-driven: simulate phase-1 / phase-2 responses with scripted LLM stubs;
  verify both caps fire correctly; verify the verbatim retry prompt structure (string contains
  prior request serialization + cloud's reason + remaining counter).
- `orchestrator.test.ts` — full two-phase loop against a fully-scripted cloud LLM. Run through
  `sufficient` → fetcher skipped path; `context-needed` → fetcher → second phase-2 success path;
  `needs-narrowing` → fetcher emits hint → cloud refines → success path; abort path; cap-exhausted
  paths.
- `review-template.smoke.ts` — gated by `INSRC_LIVE_LLM=1`. Runs `/review` against a real cloud
  LLM on a small fixture repo; asserts deliverable lands, audit passes, JSONL logs present.

**Exit criteria for M2**: a user can run `/review` from chat in the IDE and see the same activity
they'd see for a code-analyzer run. Report pane auto-opens on completion. JSONL logs under
`~/.insrc/meta/<id>/` are complete and replay-able by reading the files.

---

## Phase M3: Composability + section-flow integration

End state: a meta-task can invoke another meta-task as a sub-step. Section-flow's leaf executor
recognizes meta-task leaves alongside handoff leaves.

### M3.1 New files

```
src/insrc/meta-task/sub-meta-task.ts
src/insrc/meta-task/__tests__/sub-meta-task.test.ts
```

### M3.2 Modified files

```
src/insrc/agent/section-flow/leaf-executor.ts            # add 'meta-task' leaf kind
src/insrc/meta-task/persist.ts                           # sub-namespace support
src/insrc/meta-task/event-emitter.ts                     # gate-passthrough for sub-tasks
```

### M3.3 `sub-meta-task.ts` — nested invocation

Exports `runSubMetaTask(parentId: string, opts: RunMetaTaskOpts): Promise<MetaTaskResult>`.
Semantics per design §3 closing notes:

- **PersistRoot**: child writes under `<parentRoot>/sub-<n>-<template>/` (parent's
  `MetaTaskStore` exposes a `subStoreFor(stepIndex)` factory).
- **Gates**: child runs headless by default — its `emitGate` is rebound to `Promise.resolve(allow)`.
  Templates that need their own user gate at a specific point can opt out by setting
  `subTaskGates: 'passthrough'` on the calling step descriptor. (M5 wires the abort gate
  passthrough explicitly.)
- **Worktree**: child inherits parent's worktree if compatible (parent `shared`, child
  `none` → OK; parent `none`, child `shared` → child gets its own).
- **Deliverable catalog**: child sees parent's catalog (full deliverable namespace), so a sub-task
  can reference upstream context. Parent's subsequent steps see the sub-task's deliverables under
  `sub-<n>-<template>/step-*-*.md` path.

### M3.4 Section-flow leaf kind

Extend the leaf executor's `LeafKind` discriminator with `'meta-task'`. The executor's existing
`handoff` leaf invocation is the model — `meta-task` leaves resolve to `runSubMetaTask` and
collapse the sub-task's emissions into the parent's `liveStep` stream (with the sub-task name
prefixed in the `step` field).

### M3.5 Tests

- `sub-meta-task.test.ts` — scripted parent invokes scripted child; verify persistRoot
  sub-namespace; verify catalog visibility; verify gate-passthrough toggle; verify worktree mode
  compatibility table.

**Exit criteria for M3**: a no-op parent meta-task can invoke `/review` as a sub-step and see the
child's deliverable under `parent/sub-1-review/`. Section-flow's TodoList shows nested step
structure (child's steps render under the parent's step row).

---

## Phase M4: Planner migration

End state: `src/insrc/agent/planner/` is deleted. `/plan` exists as a meta-task. Delegate is
migrated to invoke `/plan` as a sub-meta-task. No backwards-compat shim.

### M4.1 New files

```
src/insrc/meta-task/templates/plan.ts
src/insrc/meta-task/templates/plan-prompts/        # extracted from agent/planner/prompts/
  analyze.md
  search.md
  draft.md
  validate.md
  detail.md
  serialize.md
src/insrc/meta-task/__tests__/plan-template.test.ts
```

### M4.2 Modified files

```
src/insrc/agent/tasks/delegate/agent.ts                  # invoke /plan sub-meta-task
src/insrc/agent/tasks/delegate/steps.ts                  # remove plannerAgent invocation
src/insrc/agent/tasks/delegate/types.ts                  # update DelegatePlan if needed
src/insrc/shared/types.ts                                # update Plan type if needed
```

### M4.3 Deleted

```
src/insrc/agent/planner/                                 # entire directory
```

### M4.4 Migration mechanics

The existing planner is an 8-step `AgentDefinition` (`plannerAgent` in
`src/insrc/agent/planner/agent.ts`). Each of its steps maps to a meta-task step:

| Planner step  | Meta-task step | Phase-1 typical request                          | Phase-2 prompt source                |
|---------------|----------------|--------------------------------------------------|--------------------------------------|
| analyze       | P1 analyze     | `entities` + `files` for the scope               | `plan-prompts/analyze.md`            |
| search        | P2 search      | `semantic` over entities + `graph: closure`      | `plan-prompts/search.md`             |
| draft         | P3 draft       | `deliverable` (P1 + P2 outputs)                  | `plan-prompts/draft.md`              |
| validate      | P4 validate    | `deliverable` (P3 output) + `memory`             | `plan-prompts/validate.md`           |
| detail        | P5 detail      | `deliverable` (P4 output) + `entities`           | `plan-prompts/detail.md`             |
| serialize     | P6 serialize   | `deliverable` (P5 output)                        | `plan-prompts/serialize.md`          |

The migration is largely lift-and-shift: prompts move from `.ts` files (currently inlined or
imported from `prompts/`) to `.md` files under `plan-prompts/`, and the orchestration becomes
declarative (the template's `plan` function returns the step list, no per-step glue code).

Validators currently inside the planner (`validatePlan`, `Plan` type checks) move to the
template's `acceptance` criteria + the final `synthesize` step.

### M4.5 Delegate migration

`Delegate.invoke-planner` step currently calls `runAgent(plannerAgent, ...)`. Replace with
`runSubMetaTask(parentId, {templateId: 'plan', intent, scope, memoryRefs})`. The shape of the
returned `Plan` is preserved (Delegate downstream code is unchanged).

### M4.6 Tests

- `plan-template.test.ts` — runs `/plan` against a scripted cloud LLM; verifies the output
  matches the existing `Plan` type. Reuse the existing planner-agent live test
  (`scripts/test-planner-live.ts`) as a parallel smoke check until M4 lands; delete after.

**Exit criteria for M4**: `npm test` passes including the existing Delegate test suite. The
`scripts/test-planner-live.ts` script is deleted and replaced by a meta-task equivalent. No file
references to `agent/planner/` remain anywhere in the codebase (grep gates this).

---

## Phase M5: User-driven plan revision + chat card

End state: when a step aborts, the user sees a gate with the four actions and a free-text input.
Choosing `Adjust plan` or `New plan` invokes `/plan` as a sub-meta-task with appropriate scope.
A meta-task chat card sits in the chat transcript as a launch point + at-a-glance status.

### M5.1 New files

```
src/insrc/meta-task/plan-revision.ts
src/insrc/meta-task/__tests__/plan-revision.test.ts
src/vs/workbench/contrib/insrc/browser/meta-task/chatMetaTaskWidget.ts
src/vs/workbench/contrib/insrc/browser/meta-task/metaTaskFlowContribution.ts
src/vs/workbench/contrib/insrc/browser/meta-task/media/chatMetaTask.css
```

### M5.2 Modified files

```
src/insrc/meta-task/orchestrator.ts                      # wire abort gate + revision branch
src/vs/workbench/contrib/insrc/browser/chat/chatView.ts  # render meta-task card
src/vs/workbench/contrib/insrc/browser/insrc.contribution.ts  # register flow contribution
src/vs/workbench/contrib/insrc/common/handoffService.ts  # MetaTaskSessionState (if shared)
src/vs/workbench/contrib/insrc/browser/handoff/handoffServiceImpl.ts
```

(Whether MetaTaskSessionState goes in `handoffService.ts` or a new `metaTaskService.ts` depends
on how much state shape overlap there is. Default: new service if surfaces diverge more than
~30 % of fields.)

### M5.3 `plan-revision.ts`

```ts
export async function reviseUserDriven(opts: {
  parentTaskId: string;
  failedStepIndex: number;
  failedAbort: AbortPayload;
  userFeedback: string;                       // free-text from the gate input
  action: 'adjust' | 'new-plan';
  completedDeliverables: DeliverableRef[];
}): Promise<Plan>;
```

`adjust` → invokes `/plan` with scope restricted to "rewrite step N + downstream". `new-plan` →
invokes `/plan` with scope "the original intent, given completed deliverables + this feedback".
Both paths feed the user's free-text feedback as additional input to the planner's `P1 analyze`
step (concatenated into the phase-1 prompt's scope-context section).

Termination cap: maintains a counter in the parent's `MetaTaskMeta` (`planRevisionCount: number`).
At 2, the gate's `Adjust plan` / `New plan` actions are greyed out in the IDE (the orchestrator
emits a flag on the gate request); only `Retry step` / `Abort meta-task` remain.

### M5.4 Chat card

Modeled on `chatHandoffWidget.ts`. Shows:
- Meta-task name + template ID
- Current lifecycle stage badge (`scope` / `plan` / `executing` / `revising` / `synthesize` / `done`)
- Active step + phase indicator (e.g. `R1 analyze · phase-2 task · 47s`)
- "Open dashboard" link → reveals the TodoList pane

No actions on the card itself. All interactions through gates + the dashboard.

### M5.5 Flow contribution

Mirrors `handoffFlowContribution.ts` + `dataAnalyzerFlowContribution.ts`. Watches
`onDidChangeList` for `owner === 'meta-task'` with non-empty body; opens the report pane (reuse
the existing handoff report pane, or extract a shared base if styling diverges).

### M5.6 Tests

- `plan-revision.test.ts` — table-driven: feed a scripted abort → script user feedback → verify
  the sub-meta-task is invoked with the correct scope; verify cap behavior at revisions 1, 2, 3.

**Exit criteria for M5**: a real abort during a `/review` (e.g. force one by truncating the
deliverable mid-stream) surfaces the inline gate with all four actions. Choosing `Adjust plan`
invokes the planner sub-task and splices the new tail. Chat card shows live status throughout.

---

## Phase M6: Full template set (gated on per-template design docs)

End state: `/design`, `/implement`, `/migrate`, `/review` all ship with their own design docs at
`design/meta-task-<name>.html`, plus implementations at `src/insrc/meta-task/templates/<name>.ts`.

### M6.0 Per-template design docs (prerequisite)

**Before** any of M6.1 – M6.4 can start, the corresponding template design doc must land. Each
doc covers (per the design's M6 row):

- Step list with intents + per-step acceptance criteria
- Per-step worktree behavior (uses parent's? requires own? read-only?)
- Deliverable schema (sections required in the final synthesis)
- Module-specific gates (e.g. `/implement` likely has a per-commit gate)
- Audit rules (which acceptance criteria are hard vs soft)
- Any non-default retry / revision cap overrides
- Slash invocation surface (`/design <intent>` etc.)

Filed as `design/meta-task-{design,implement,migrate}.html`. (`/review` already exists from M2;
its design is implicitly the M2 spec and gets a short doc retrofitted for parity.)

### M6.1 `/review` doc retrofit

Convert the M2 implementation notes into a proper design doc at
`design/meta-task-review.html`. Not net-new work; just formalizing what shipped.

### M6.2 `/design` template

Depends on `design/meta-task-design.html`. Multi-step: scope → plan → per-requirement design pass →
synthesis. `worktreeMode: 'none'` (produces docs only).

### M6.3 `/migrate` template

Depends on `design/meta-task-migrate.html`. Multi-step: scope → plan → per-call-site transform →
audit → synthesis. `worktreeMode: 'shared'` (each step modifies the shared worktree).

### M6.4 `/implement` template

Depends on `design/meta-task-implement.html`. Multi-step: scope → plan → per-feature handoff →
audit → synthesis. `worktreeMode: 'shared'`. Each leaf step is a handoff (existing handoff
templates: `SPEC`, `DEBUG`, etc., chosen per the planner's recommendation).

### M6.5 Tests

Per-template smoke tests (`scripts/test-meta-task-<name>-live.ts`) gated by `INSRC_LIVE_LLM=1`.

**Exit criteria for M6**: each template has its design doc + implementation + smoke test, all
green. Slash invocations land in `chatView.ts`. The full set is documented in `CLAUDE.md` under
the intent taxonomy section.

---

## Validation strategy

End-to-end smoke tests per phase. Most live LLM tests gated behind `INSRC_LIVE_LLM=1` so CI
stays fast / deterministic; the live-LLM suite runs nightly + on a per-commit basis when the
relevant module is touched.

Unit-test coverage targets per module:
- `schema.ts` — 100 % branch coverage (it's the contract gate)
- `context-fetcher.ts` + per-slot fetchers — ≥ 90 %
- `orchestrator.ts` retry / abort branches — ≥ 90 %
- `plan-revision.ts` — ≥ 90 %

Mirror the existing handoff test layout: per-module `__tests__/` + cross-module integration tests
in the meta-task root tests dir.

## Timeline estimate (rough)

| Phase | Effort estimate (single dev) |
|-------|------------------------------|
| Phase 0 | ~1 day |
| M1 | ~3-4 days |
| M2 | ~5-7 days (orchestrator is the bulk) |
| M3 | ~2-3 days |
| M4 | ~5-7 days (planner migration; needs careful migration of validators) |
| M5 | ~3-4 days |
| M6 | per-template, ~3-5 days each + design doc time |

Total framework (M1–M5): ~3-4 weeks. M6 grows per-template.

## Risks + mitigations

- **Schema bloat as new slot kinds are added.** Mitigation: every `ContextRequest` variant must
  ship with a fetcher + tests + a section in the design doc. Schema additions PR-gated.
- **Planner migration breaks Delegate.** Mitigation: M4 includes the Delegate migration in the
  same milestone; tests gate the merge. Delegate's existing live test (`scripts/test-delegate-smoke.ts`)
  must pass post-migration.
- **Cloud LLM produces malformed `Phase1Ask` / `Phase2Out` consistently.** Mitigation: the schema
  validator's rejection message is fed back to the cloud LLM as part of the retry prompt; with
  structured-output mode (JSON-schema-constrained) on the cloud provider, this should be rare. If
  it isn't, add a "retry with stricter prompt" path.
- **Heartbeat noise overwhelms the progress bar on parallel meta-tasks.** Probably fine for v1
  (one meta-task per chat session); add a multiplex strategy if it becomes a real problem.
- **Cost.** Two-phase model = potentially 2× cloud calls per step. Mitigation: `kind: 'sufficient'`
  short-circuit is the cloud LLM's own call to make; well-written templates will hit it often.
  Track per-meta-task token counts in `MetaTaskStore` for visibility.

## Out-of-scope follow-ups

Tracked here so they don't go missing, but not in any of M1–M6:
- **Resume across daemon restarts.** Persistence layout supports it; resume logic deferred.
- **Multi-meta-task concurrency in a single chat session.** v1 is one at a time per session.
- **Cross-meta-task deliverable sharing.** Phase-1 catalog is scoped to the current meta-task +
  referenced handoffs only. Cross-task references via explicit IDs.
- **Public API surface.** Currently internal to the daemon; if external callers want to invoke
  meta-tasks programmatically, an MCP-style surface lands later.
