# `/plan` template — implementation plan

## Status

Pre-implementation. Design landed 2026-06-17
([design/meta-task-plan.html](../design/meta-task-plan.html)); this plan distills the design into
phased, sequenced work items. Targets the **M4.a** half of M4 from
[`plans/meta-tasks.md`](./meta-tasks.md) §M4 (template + framework escape hatch + chat-side
slash). Consumer migration (M4.b) lives in a separate plan once this lands.

## Related plans + design

- **Design**: [`design/meta-task-plan.html`](../design/meta-task-plan.html) — per-step phase-1
  contract, phase-2 prompt source, deliverable shape, open-question resolutions (O1–O4).
- [`plans/meta-tasks.md`](./meta-tasks.md) §M4 — the original outline; **superseded by this plan
  for the M4.a portion**. The M4.b consumer-migration outline (M4.5–M4.6) stays in
  `meta-tasks.md` and lands in a separate plan after M5 ships the headless emitter.
- [`design/meta-tasks.html`](../design/meta-tasks.html) — framework contract (Phase1Ask /
  Phase1Result / Phase2Out / retry caps).
- [`plans/memory-context.md`](./memory-context.md) M3 — owner registration. The plan template's
  `assertionInterests` declaration lands in this plan's Phase 4.
- `src/insrc/agent/planner/` (1861 LOC, 10 files) — the legacy planner. **Preserved unchanged**;
  reused via imports only.
- `src/insrc/meta-task/templates/review.ts` — the existing `/review` template, the closest
  precedent for shape and tests.

## Scope (M4.a)

- Land `/plan` as a usable meta-task template via the chat slash command.
- Framework **O1 extension**: `StepDescriptor.phase2?: Phase2Runner` escape hatch so a step can
  supply a synchronous / multi-call phase-2 handler instead of the default one-cloud-call path.
- Port the legacy prompts (`ANALYZE_SYSTEM`, `DRAFT_SYSTEM`, `ENHANCE_SYSTEM`,
  `CONDENSED_SYSTEM`, `DETAIL_SYSTEM`, `SEARCH_PLAN_SYSTEM`) verbatim into the new template's
  phase-2 system preludes.
- Reuse legacy `markdown.{toMarkdown, fromMarkdown}`, `engine.{detectCycles, detectBlockedSteps,
  validateDependencies}`, `progress.getProgressSummary`, `utils.{generateId}`, `types.{Plan, Step,
  ImplementationStepData, TestStepData, MigrationStepData, ...}` via direct import or
  re-export wrapper.
- Wire memory-context M3 owner declaration on the template
  (`assertionInterests`, `ownerId`, `memorySchema`).

**Exit criteria for M4.a** (see §"Exit criteria" below for the full checklist).

## Non-goals (M4.a)

Everything below lands in subsequent phases (M4.b, M5, or §8 of the design doc). This plan does
**not** cover them:

- **Consumer migration.** Delegate (`agent/tasks/delegate/steps.ts`), CLI (`agent/cli.ts`),
  chat-handler intent-classified `'plan'` dispatch (`daemon/chat-handler.ts:2310`) all stay on
  `plannerAgent`. Both paths coexist until M4.b.
- **Deletion of `src/insrc/agent/planner/`.** Stays until every consumer migrates (M4.b).
  Deletion of `scripts/test-planner-live.ts` likewise deferred.
- **Plan revision via the abort gate.** Adjust-plan / New-plan / Approve actions land in
  meta-tasks M5 (`plans/meta-tasks.md` §M5).
- **Post-approval routing** — Jira / GitHub adapters, receipts, idempotency, per-integration
  export buttons. Design doc §8 captures the contract; implementation is a separate plan.
- **Feedback capture** (legacy `recordFeedback`). Closed by the memory-context M1–M5 we shipped;
  `agent:meta-task:plan` will automatically receive user preferences via the assertion-index
  fan-out (Phase 4 declares the interests).
- **Per-step interactive gates** (legacy `validate-plan`, `validate-details`, artifact-save).
  Folded into the framework's M5 plan-revision flow.

## Phasing principle

**Each phase touches each file at most once.** Earlier phases land independently testable
primitives; later phases compose them. The phasing matches the memory-context plan's grain that
worked well.

- **Phase 0** — pre-work + commit this doc.
- **Phase 1** — framework O1: `Phase2Runner` extension (orchestrator + types + tests).
- **Phase 2** — static assets: plan-types re-export wrapper + ported prompts + helpers.
- **Phase 3** — deterministic step runners (P4 validate + P6 synth, both use `Phase2Runner`).
- **Phase 4** — `templates/plan.ts` template definition + registry registration + scripted-cloud
  round-trip.
- **Phase 5** — live-LLM smoke + manual chat-panel verification.

The static assets in Phase 2 are written **once**; Phase 3 imports the helpers; Phase 4 imports
the prompts, helpers, and Phase 3 runners. No file is revisited across phases except `index.ts`
in the templates registry (one new line in Phase 4) and `plan-helpers.ts` if Phase 4's
scripted-cloud test surfaces a missing helper (counted as Phase 4 work in that case, not a
Phase 2 revisit).

---

## Phase 0 — Pre-work

Land this plan as `plans/meta-task-plan.md`. Re-confirm the resolved decisions from the design
doc so subsequent phases reference a stable target:

- **O1 (resolved)**: framework adds `StepDescriptor.phase2?: Phase2Runner`. Default path
  unchanged for steps without it.
- **O2 (resolved)**: `PlanCategory` is a closed enum of 6 values (`implementation` / `migration`
  / `test` / `documentation` / `operational` / `design`) + freeform `subCategory` validated
  client-side per category.
- **O3 (resolved)**: P3 draft collapses the legacy two-stage `DRAFT_SYSTEM` + `ENHANCE_SYSTEM`
  into one combined prompt. Escape hatch (two calls via `phase2`) reserved if needed later.
- **O4 (resolved)**: user-preference capture is the memory-context M1–M5 work that already
  shipped. Plan template declares its `assertionInterests` (Phase 4); no additional capture
  surface needed.

**Output**: this file committed; no code changes.

---

## Phase 1 — Framework O1: `Phase2Runner` escape hatch

Adds the orchestrator escape hatch so a step can supply a synchronous / multi-call phase-2
handler. Needed by P4 (deterministic — `detectCycles` + `detectBlockedSteps`) and P6
(deterministic — `buildPlan` + `toMarkdown`). Future templates with custom phase-2 logic reuse
the same primitive.

### Files

```
src/insrc/meta-task/types.ts                                              MODIFY (+ Phase2Runner, StepDescriptor.phase2?)
src/insrc/meta-task/orchestrator.ts                                       MODIFY (callForPhase2 short-circuit)
src/insrc/meta-task/__tests__/orchestrator-phase2-runner.test.ts          NEW
```

### Shape

```ts
// types.ts
export interface Phase2RunnerCtx {
  readonly stepDesc:         StepDescriptor;
  readonly phase1Result:     Phase1Result | null;
  readonly cumulativeChunks: readonly ContextChunk[];
  readonly cloud:            LLMProvider;            // step may call 0 / 1 / N times
  readonly catalog:          DeliverableCatalog;     // P5 detail + P6 synth read prior deliverables
  readonly deliverables:     ReadonlyMap<number, string>;  // by stepIndex (1-based)
  readonly stepIndex:        number;
  readonly retryAttempt:     number;
  readonly emit:             MetaTaskEmitter;        // for liveStep updates on long runners
  readonly bubble:           string;                 // current step's liveStep bubble label
  readonly signal:           AbortSignal | undefined;
}

export type Phase2Runner = (ctx: Phase2RunnerCtx) => Promise<Phase2Out>;

export interface StepDescriptor {
  readonly name: string;
  readonly intent: string;
  readonly acceptance: readonly AcceptanceCriterion[];
  readonly providerBinding?: string | undefined;
  // M4.a addition:
  readonly phase2?: Phase2Runner | undefined;
}
```

### Orchestrator change (callForPhase2 short-circuit)

```ts
// orchestrator.ts: inside runStep, before the existing callForPhase2 invocation
if (opts.stepDesc.phase2 !== undefined) {
  const output = await opts.stepDesc.phase2({
    stepDesc:         opts.stepDesc,
    phase1Result,
    cumulativeChunks: [...cumulativeChunks],
    cloud:            opts.cloud,
    catalog:          opts.catalog,
    deliverables,                              // available from runMetaTask scope
    stepIndex:        opts.stepIndex,
    retryAttempt:     phase2RetryAttempt,
    emit:             opts.emit,
    bubble,
    signal:           opts.signal,
  });
  // Same downstream Phase2Out routing as the default path.
  if (output.kind === 'deliverable') { ... }
  ...
} else {
  // unchanged default LLM path
}
```

### Tests

- `orchestrator-phase2-runner.test.ts` (~6 tests):
  - Default path unchanged when `phase2` absent (regression — wire to existing review template).
  - `phase2` present and returns `{kind: 'deliverable'}` → orchestrator advances; deliverable
    persisted normally.
  - `phase2` returns `{kind: 'context-needed'}` → routes through the existing context-needed
    retry loop with `retryAttempt` reported correctly.
  - `phase2` returns `{kind: 'abort'}` → meta-task aborts with that resolution.
  - `phase2` throws → step aborts with `resolution: 'user-required'` and a stable error message
    (matches the existing path's failure semantics).
  - `phase2` may opt to call `ctx.cloud.complete()` (scripted) — verify the call lands.

### Acceptance

- Type-check clean.
- Existing 5 orchestrator tests + the 4 orchestrator-preferences tests (M-C M2) stay green.
- `Phase2Runner` exported from `meta-task/types.ts`; consumers can `import type { Phase2Runner }
  from '../types.js'`.
- ~80 LOC across the three files (matches the design doc's framework-side estimate).

---

## Phase 2 — Static assets: plan-types + plan-prompts + plan-helpers

All the legacy planner content we KEEP via re-export or copy, **in one go** so later phases
don't revisit. None of these files contain Phase2 runners — those land in Phase 3.

### Files

```
src/insrc/meta-task/templates/plan-types.ts                                NEW (re-export wrapper + PlanCategory enum)
src/insrc/meta-task/templates/plan-prompts.ts                              NEW (6 verbatim prompts + 1 condensed combined draft prompt per O3)
src/insrc/meta-task/templates/plan-helpers.ts                              NEW (parseStepsJson, buildPlan, extractJson, formatPlanCategory)
src/insrc/meta-task/templates/__tests__/plan-helpers.test.ts               NEW
```

### `plan-types.ts`

```ts
// Re-exports so consumers (Delegate, future M4.b callers, the template internals) have ONE
// canonical import path going forward. The legacy module stays untouched.
export type {
  Plan, Step, StepStatus, PlanStatus, PlanMetadata, StatusTransition,
  ImplementationStepData, TestStepData, MigrationStepData,
  ImplementationPlan, TestPlan, MigrationPlan,
  ProgressSummary,
} from '../../../agent/planner/types.js';

// O2 (resolved): closed-enum top-level category, freeform sub-category validated per top-level.
export type PlanCategory =
  | 'implementation'
  | 'migration'
  | 'test'
  | 'documentation'
  | 'operational'
  | 'design';

export const PLAN_CATEGORIES: readonly PlanCategory[] = [
  'implementation', 'migration', 'test', 'documentation', 'operational', 'design',
] as const;

// Per-category valid sub-categories (used by the P1 helper's validator).
export const PLAN_SUB_CATEGORIES: Readonly<Record<PlanCategory, readonly string[]>> = {
  implementation: ['new-feature', 'bugfix', 'refactor', 'integration', 'performance'],
  migration:      ['data-migration', 'platform-migration', 'framework-upgrade', 'language-port'],
  test:           ['unit', 'integration', 'e2e', 'regression-suite'],
  documentation:  ['api-docs', 'runbook', 'architecture-doc', 'adr'],
  operational:    ['deployment', 'incident-response', 'monitoring', 'cleanup'],
  design:         ['system-design', 'api-design', 'ux-design', 'database-schema'],
};

export function isValidSubCategory(cat: PlanCategory, sub: string): boolean {
  return PLAN_SUB_CATEGORIES[cat].includes(sub);
}
```

### `plan-prompts.ts`

Verbatim copies of the legacy prompt constants from `src/insrc/agent/planner/prompts.ts`,
adapted only where the meta-task framework's phase-2 contract requires:

- Each prompt becomes a `phase2SystemPrelude`-style string. The orchestrator's default phase-2
  call wraps it with the framework's standard `Phase2Out` JSON-shape instruction (see
  `orchestrator.ts:callForPhase2` system message).
- **O3 resolution**: a new `PLAN_DRAFT_COMBINED` prompt merges `DRAFT_SYSTEM` +
  `ENHANCE_SYSTEM` into a single instruction that asks the LLM to "produce a refined,
  production-ready plan in one pass." Legacy two-stage constants stay in this file as
  `PLAN_DRAFT_SKETCH` + `PLAN_DRAFT_REFINE` for future escape-hatch usage if the combined
  prompt's quality regresses.

```ts
export const PLAN_ANALYZE       = `<verbatim copy of ANALYZE_SYSTEM>`;
export const PLAN_SEARCH        = `<verbatim copy of SEARCH_PLAN_SYSTEM>`;
export const PLAN_DRAFT_COMBINED = `<merged DRAFT_SYSTEM + ENHANCE_SYSTEM, single-pass>`;
export const PLAN_DRAFT_SKETCH  = `<verbatim DRAFT_SYSTEM, reserved for escape hatch>`;
export const PLAN_DRAFT_REFINE  = `<verbatim ENHANCE_SYSTEM, reserved for escape hatch>`;
export const PLAN_DRAFT_CONDENSED = `<verbatim CONDENSED_SYSTEM>`;
export const PLAN_DETAIL        = `<verbatim DETAIL_SYSTEM>`;
```

Each prompt is wrapped in a small adapter helper that injects the step's intent + scope so the
template doesn't repeat boilerplate per step.

### `plan-helpers.ts`

Ports from `src/insrc/agent/planner/steps.ts`'s private helpers — the legacy file stays
unmodified per the non-goal:

```ts
import type { Plan, Step } from './plan-types.js';
import { generateId } from '../../../agent/planner/utils.js';
import type { PlanCategory } from './plan-types.js';

export interface RawStep {
  title: string;
  description: string;
  checkpoint?: boolean | undefined;
  complexity?: string | undefined;
  dependsOnIdx?: number[] | undefined;
  fileHint?: string | undefined;
}

export function parseStepsJson(text: string): RawStep[] { /* port verbatim */ }
export function extractJson(text: string): string       { /* port verbatim */ }

export function buildPlan(
  repoPath: string,
  title:    string,
  rawSteps: RawStep[],
  category: PlanCategory,
): Plan { /* port + adapted to use PlanCategory instead of legacy InferredPlanType */ }

// O2: validator the P1 helper calls before persisting the analysis deliverable.
export function validateAnalysisShape(parsed: unknown): {
  ok: true; value: { category: PlanCategory; subCategory: string; goals: string[]; constraints: string[]; scope: string };
} | { ok: false; errors: readonly string[] };
```

### Tests

- `plan-helpers.test.ts` (~10 tests):
  - `parseStepsJson` handles code-fence wrap, raw JSON array, mixed markdown — pin every legacy
    case the existing planner exercised.
  - `buildPlan` produces stable ids, preserves dependency edges, drops self-dependencies.
  - `validateAnalysisShape` accepts well-formed analysis, rejects unknown category, rejects
    sub-category mismatched to its category.
  - `extractJson` parity with the legacy version.

### Acceptance

- All helpers tested in isolation; no template wiring yet.
- Re-exports from `plan-types.ts` resolve at compile time without circular deps.
- Zero edits to `src/insrc/agent/planner/`.

---

## Phase 3 — Deterministic step runners (P4 validate + P6 synth)

Both use the `Phase2Runner` from Phase 1. Independently testable; no LLM calls. Live in their
own files so the template (Phase 4) just imports them.

### Files

```
src/insrc/meta-task/templates/plan-step-validate.ts                        NEW (P4 Phase2Runner)
src/insrc/meta-task/templates/plan-step-synth.ts                           NEW (P6 Phase2Runner)
src/insrc/meta-task/templates/__tests__/plan-step-validate.test.ts         NEW
src/insrc/meta-task/templates/__tests__/plan-step-synth.test.ts            NEW
```

### `plan-step-validate.ts`

```ts
import type { Phase2Runner } from '../types.js';
import { detectCycles, detectBlockedSteps } from '../../../agent/planner/engine.js';
import { buildPlan, parseStepsJson } from './plan-helpers.js';

export const planValidateRunner: Phase2Runner = async (ctx) => {
  // 1. Pull P3 draft deliverable from ctx.deliverables.
  // 2. parseStepsJson on the draft body, buildPlan.
  // 3. detectCycles + detectBlockedSteps.
  // 4. Pass -> { kind: 'deliverable', body: '# Validation pass\n\nNo cycles. ...' }
  //    Fail -> { kind: 'abort', resolution: 'plan-revisable',
  //              reason: 'cycle detected: a -> b -> a',
  //              hint: 'consider re-ordering steps so X precedes Y' }
};
```

### `plan-step-synth.ts`

```ts
import type { Phase2Runner } from '../types.js';
import { toMarkdown } from '../../../agent/planner/markdown.js';
import { buildPlan, parseStepsJson } from './plan-helpers.js';

export const planSynthRunner: Phase2Runner = async (ctx) => {
  // 1. Pull P3 draft + P5 detail deliverables from ctx.deliverables.
  // 2. parseStepsJson on draft, buildPlan.
  // 3. Merge P5 detail enrichments (skip when sentinel '(skipped)').
  // 4. Call toMarkdown(plan).
  // 5. Return { kind: 'deliverable', body: <markdown> }.
};
```

### Tests

- `plan-step-validate.test.ts` (~5 tests):
  - Pass path: simple linear plan → deliverable with "no dependency issues" body.
  - Cycle: 3-step cycle → abort('plan-revisable') with cycle path in reason.
  - Blocked steps: step depends on missing id → abort('plan-revisable').
  - Malformed P3 deliverable (not parseable JSON) → abort('user-required').
  - P3 deliverable missing from ctx.deliverables → abort('user-required').

- `plan-step-synth.test.ts` (~4 tests):
  - Happy path: P3 + P5 present → markdown body round-trips via `fromMarkdown` to a Plan with
    the right shape.
  - P5 sentinel '(skipped)' → markdown emitted without per-step detail enrichments.
  - P3 missing → abort('user-required').
  - Markdown body is non-empty + contains expected headers (`# Plan: ...`, `## Steps`).

### Acceptance

- Both runners pass their tests with **no cloud LLM call** (verified by injecting a cloud
  provider that throws — the runner never invokes it).
- Round-trip: `synthRunner` output → `fromMarkdown` → `buildPlan` (manual reconstitution) →
  equivalent Plan.

---

## Phase 4 — `templates/plan.ts` + registration + scripted-cloud round-trip

The big phase: wires the 6 step descriptors into a `MetaTaskTemplate`, registers it in the
builtins manifest with memory-context M3 owner declaration, and exercises the entire pipeline
end-to-end with a scripted cloud LLM.

### Files

```
src/insrc/meta-task/templates/plan.ts                                      NEW (planTemplate)
src/insrc/meta-task/templates/index.ts                                     MODIFY (+ planTemplate in BUILTIN_TEMPLATES)
src/insrc/meta-task/templates/__tests__/plan-template.test.ts              NEW (scripted-cloud round-trip)
```

### `plan.ts`

```ts
import type { AssertionInterest } from '../../daemon/substrate/types.js';
import type { MetaTaskTemplate, TemplateMemoryNamespace } from './index.js';
import type { Plan, ScopeManifest, StepDescriptor } from '../types.js';
import { PLAN_ANALYZE, PLAN_SEARCH, PLAN_DRAFT_COMBINED, PLAN_DRAFT_CONDENSED, PLAN_DETAIL } from './plan-prompts.js';
import { planValidateRunner } from './plan-step-validate.js';
import { planSynthRunner }   from './plan-step-synth.js';

const PLAN_ASSERTION_INTERESTS: readonly AssertionInterest[] = [
  { subjectPattern: 'test-policy',          description: 'Test coverage / style for implementation plans' },
  { subjectPattern: 'documentation-policy', description: 'Doc requirements per plan step' },
  { subjectPattern: 'code-style',           description: 'Conventions reflected in plan steps' },
  { subjectPattern: 'architecture-policy',  description: 'Architectural patterns per plan step' },
  { subjectPattern: 'workflow-policy',      description: 'Workflow conventions for plans' },
];

const planFn = (scope: ScopeManifest): Plan => ({
  revision: 0,
  steps: [
    {
      name: 'P1 analyze',
      intent: `Classify the user's planning intent into a typed analysis: { category, subCategory, goals, constraints, scope }. Source intent: ${scope.intent}`,
      acceptance: [{ id: 'analysis.shape', description: 'Deliverable body is parseable JSON matching { category, subCategory, goals[], constraints[], scope }', kind: 'hard' }],
      // Default framework path (one cloud call) -- phase-1 typically `{kind:'sufficient'}` per
      // design 4.1.
    } satisfies StepDescriptor,
    {
      name: 'P2 gather',
      intent: 'Pull relevant codebase context for the planning request.',
      acceptance: [{ id: 'gather.body', description: 'Deliverable body is non-empty markdown', kind: 'soft' }],
    } satisfies StepDescriptor,
    {
      name: 'P3 draft',
      intent: 'Produce a refined ordered step list from the analysis + gather outputs.',
      acceptance: [{ id: 'draft.steps', description: 'Body parses to a non-empty array of {title, description}', kind: 'hard' }],
    } satisfies StepDescriptor,
    {
      name: 'P4 validate',
      intent: 'Deterministically check the drafted plan for cycles + blocked steps.',
      acceptance: [{ id: 'validate.no-cycles', description: 'No dependency cycles', kind: 'hard' }],
      phase2: planValidateRunner,        // O1 escape hatch -- no LLM call.
    } satisfies StepDescriptor,
    {
      name: 'P5 detail',
      intent: 'Enrich each step with category-specific data (skipped when category lacks a domain schema).',
      acceptance: [{ id: 'detail.body', description: 'Body is JSON enrichments OR the sentinel "(skipped)"', kind: 'soft' }],
    } satisfies StepDescriptor,
    {
      name: 'P6 synth',
      intent: 'Assemble the final Plan and serialize via markdown.toMarkdown.',
      acceptance: [{ id: 'synth.markdown', description: 'Body is round-trippable via fromMarkdown', kind: 'hard' }],
      phase2: planSynthRunner,           // O1 escape hatch -- no LLM call.
    } satisfies StepDescriptor,
  ],
});

export const planTemplate: MetaTaskTemplate = {
  id:                 'plan',
  displayName:        'Plan',
  worktreeMode:       'none',
  plan:               planFn,
  // P2 / P3 / P5 use the default phase-2 LLM path; the framework's `phase2SystemPrelude` is set
  // per-step via a per-step prompt accessor (no single template-wide prelude).
  // M3 substrate registration.
  ownerId:            'agent:meta-task:plan',
  schemaVersion:      1,
  assertionInterests: PLAN_ASSERTION_INTERESTS,
  memorySchema: [
    { namespace: 'user-assertions', kind: 'constraint' },
  ],
};
```

**Per-step phase-2 prompts**: the framework currently exposes one `phase2SystemPrelude` per
template. For `/plan` we need different system preludes per step. Phase 4 either:
1. (Preferred) Extends `StepDescriptor` with `phase2SystemPrelude?: string` so per-step
   preludes override the template-level one.
2. Inlines the prelude into the step's `intent` field (less clean — `intent` is for user-facing
   step naming).

**Option 1 is the right call.** It's a 5-LOC addition to `types.ts` + a corresponding read in
`orchestrator.ts`'s `buildPhase2Prompt`. **Phase 4 makes this addition** — it's the only
revisit of a Phase 1 file but it's a small, well-scoped one and the alternative is uglier.

### `index.ts` change

```ts
import { reviewTemplate } from './review.js';
import { planTemplate }   from './plan.js';                              // NEW
const BUILTIN_TEMPLATES: readonly MetaTaskTemplate[] = [reviewTemplate, planTemplate];
```

### Tests

- `plan-template.test.ts` (~6 tests):
  - `listTemplates()` includes 'plan'.
  - `planTemplate.plan(scope)` returns 6-step Plan with correct `name` + `phase2` references.
  - Memory-context routing: a scripted `classifyAssertion('always include unit tests')` fans
    out to BOTH `agent:chat` and `agent:meta-task:plan` (mirrors the M3 review test).
  - **Scripted-cloud end-to-end**: feed a 4-response cloud script (P1 analysis JSON, P2 markdown
    summary, P3 draft JSON, P5 detail JSON or sentinel). Run `runMetaTask({ templateId: 'plan',
    ... })` → `outcome: 'completed'`, `deliverables.size === 6`, `deliverables.get(6)` is
    valid plan markdown that `fromMarkdown` round-trips.
  - Scripted-cloud cycle path: P3 emits a cyclic plan → P4 validateRunner aborts → meta-task
    ends with `outcome: 'aborted'`, reason includes 'cycle'.
  - Scripted-cloud "generic" plan path: P1 emits a generic category → P5 emits sentinel
    `'(skipped)'` → P6 still produces a deliverable.

### Acceptance

- `npm test` (focused: meta-task + memory-context suites) stays green; ~3 new test files green.
- `/plan <intent>` via the existing `/plan` slash interceptor
  (`src/vs/workbench/contrib/insrc/browser/chat/chatView.ts:1766`) now succeeds — the regex
  already routes to `meta-task.run`; this phase just makes the daemon-side template exist.
- `agent:meta-task:plan` owner registered with the substrate's AssertionIndex after daemon boot
  (verified by the registry-side test).

---

## Phase 5 — Live-LLM smoke + manual chat verification

Verifies the template against a real cloud LLM (or, in test-only paths, real Ollama via a
local model that can produce structured outputs). Validates that the legacy prompts still
produce viable outputs in the new framework path.

### Files

```
src/insrc/meta-task/templates/__tests__/plan-template.live.test.ts        NEW
```

### Tests

- `plan-template.live.test.ts` (1–2 tests, skipped when `INSRC_LIVE_LLM` unset):
  - Run `/plan implement a token-bucket rate limiter for /v1/sessions` end-to-end against the
    active configured cloud provider.
  - Assert: `outcome: 'completed'`, deliverable[6] non-empty markdown, `fromMarkdown` parses
    successfully, plan has ≥ 2 steps, no cycles.
  - Optional second test: contrast the new template's deliverable against the legacy planner's
    output on the same intent (qualitative — log both for manual diff; no assert).

### Manual smoke (no automation)

- Run the workbench locally, type `/plan add a feature flag system` in the chat panel.
- Confirm the chat shows live progress for P1-P6.
- Confirm the report pane auto-opens with the rendered markdown plan.
- Confirm `~/.insrc/meta/<id>/synthesis.md` exists and is non-empty.

### Acceptance

- Live test green (when env var set) OR skipped cleanly (when unset).
- Manual smoke: at least one full run produces a usable plan in the chat panel.

---

## Exit criteria (M4.a)

- [ ] `Phase2Runner` exported from `meta-task/types.ts`; orchestrator escape hatch tested.
- [ ] `planTemplate` registered; `listTemplates()` returns it.
- [ ] `/plan <intent>` via the chat panel produces a non-empty markdown deliverable in the
      report pane (manual verification).
- [ ] Deliverable from P6 is round-trippable via `markdown.fromMarkdown` (scripted-cloud test).
- [ ] Legacy `src/insrc/agent/planner/` unchanged + still wired to the intent-classified
      `'plan'` dispatch (`daemon/chat-handler.ts:2310`), CLI (`agent/cli.ts`), and Delegate
      (`agent/tasks/delegate/`).
- [ ] Memory-context M3 owner declaration: `agent:meta-task:plan` registered with
      assertion-interest fan-out for the 5 declared subjects.
- [ ] All new tests green (~25 new tests across phases 1, 2, 3, 4).
- [ ] Existing meta-task suite (77 tests) + memory-context suite (155 tests including substrate
      + prefs + context) stay green.
- [ ] No file revisited across phases (verified by `git log -p` per-phase commit review).
- [ ] Each phase = one commit + one push.

## Risks + mitigations

- **Risk**: `Phase2Runner` extension breaks the existing `/review` template (it doesn't use
  `phase2`, but the orchestrator change is in the hot path).
  - **Mitigation**: Phase 1's test set includes an explicit regression test wiring the existing
    `reviewTemplate` through the modified orchestrator and asserting `outcome: 'completed'` on
    the happy path. Existing 5 orchestrator tests stay green.

- **Risk**: Legacy prompts perform worse in the framework path (different surrounding system
  context — the framework wraps every phase-2 call with a "respond with JSON" instruction; the
  legacy `runAgent` path was more direct).
  - **Mitigation**: Phase 5's optional contrast test logs both outputs for manual diff. If
    regression is real, escape via `phase2` runners that build their own prompt (the O1
    extension was designed for this).

- **Risk**: P3's collapsed prompt (O3 — `PLAN_DRAFT_COMBINED`) is qualitatively weaker than the
  legacy sketch-then-refine two-stage pattern.
  - **Mitigation**: Phase 2 preserves `PLAN_DRAFT_SKETCH` + `PLAN_DRAFT_REFINE` constants. If
    M4.a's smoke shows a regression, P3 switches to a `phase2` runner that calls cloud twice —
    ~15 LOC change, single phase commit.

- **Risk**: Per-step `phase2SystemPrelude` extension (Phase 4) ripples into Phase 1 review.
  - **Mitigation**: extension is additive (`StepDescriptor.phase2SystemPrelude?` defaults to
    template-level when absent). Phase 4 includes a regression test that confirms `/review`
    still uses the template-level prelude.

- **Risk**: Slash command interceptor regex in `chatView.ts:1766` already lists `plan`, but the
  daemon-side template missing means `/plan` errors today; users may have learned to avoid it.
  - **Mitigation**: this is non-blocking — fixing it IS the M4.a outcome. No mitigation needed.

## What this plan defers

### M4.b (separate plan, depends on M5 headless emitter)

- Migrate `agent/tasks/delegate/steps.ts:74-82` to invoke `/plan` as a sub-meta-task.
- Migrate `agent/cli.ts:414` plan subcommand.
- Migrate `daemon/chat-handler.ts:2310` intent-classified `'plan'` dispatch.
- Delete `src/insrc/agent/planner/`.
- Delete `scripts/test-planner-live.ts`.

### Meta-tasks M5 (separate plan)

- Approve / Adjust plan / New plan / Retry / Abort gate after deliverable completion.
- `planRevisionCount` cap with greyed-out actions at the cap.
- User feedback injection into P1 analyze on revision.

### Design doc §8 (separate plan)

- Plan document output settings (`~/.insrc/settings.yaml` `output:` block).
- Jira / GitHub adapters in `MetaTaskTemplate.exportAdapters`.
- `ExternalIntegration` framework registry.
- Receipts + idempotency (`exports.json`).
- `/export-plan <integration>` slash command.

## Timeline estimate (rough)

| Phase | Effort (single dev) |
|-------|--------------------|
| Phase 0 | ~0.25 day |
| Phase 1 | ~1 day (framework O1 extension + tests) |
| Phase 2 | ~1 day (port prompts + helpers + tests) |
| Phase 3 | ~0.5 day (two small Phase2Runners + tests) |
| Phase 4 | ~1.5 days (template + per-step prelude + scripted round-trip) |
| Phase 5 | ~0.5 day (live test + manual smoke) |

**Total (M4.a)**: ~4.75 days for one dev. Sequential — no cross-phase parallelism.

## Validation strategy

- Per-phase: unit tests next to the module (`__tests__/<file>.test.ts`).
- Phase 4: scripted-cloud end-to-end test exercising all 6 steps.
- Phase 5: live-LLM smoke gated by `INSRC_LIVE_LLM`.
- Each phase committed + pushed independently. CI gates via the existing precommit hook
  (hygiene + format) + manual `npx tsc --noEmit -p src/insrc/tsconfig.json` per phase.

## File-touch summary

| File | Touched in phase |
|------|------------------|
| `meta-task/types.ts` | 1 (Phase2Runner) + 4 (per-step prelude addendum) — only file revisited |
| `meta-task/orchestrator.ts` | 1 (escape hatch) + 4 (per-step prelude read) — only file revisited |
| `meta-task/__tests__/orchestrator-phase2-runner.test.ts` | 1 (NEW) |
| `meta-task/templates/plan-types.ts` | 2 (NEW) |
| `meta-task/templates/plan-prompts.ts` | 2 (NEW) |
| `meta-task/templates/plan-helpers.ts` | 2 (NEW) |
| `meta-task/templates/__tests__/plan-helpers.test.ts` | 2 (NEW) |
| `meta-task/templates/plan-step-validate.ts` | 3 (NEW) |
| `meta-task/templates/plan-step-synth.ts` | 3 (NEW) |
| `meta-task/templates/__tests__/plan-step-validate.test.ts` | 3 (NEW) |
| `meta-task/templates/__tests__/plan-step-synth.test.ts` | 3 (NEW) |
| `meta-task/templates/plan.ts` | 4 (NEW) |
| `meta-task/templates/index.ts` | 4 (one-line manifest add) |
| `meta-task/templates/__tests__/plan-template.test.ts` | 4 (NEW) |
| `meta-task/templates/__tests__/plan-template.live.test.ts` | 5 (NEW) |

Two files (`types.ts`, `orchestrator.ts`) are revisited in Phase 4 — both for the same small
per-step prelude addendum. Every other file is touched in exactly one phase.
