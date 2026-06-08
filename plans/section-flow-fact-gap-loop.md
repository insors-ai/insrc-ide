# Section-flow fact-gap-driven task loop

**Status:** draft
**Owner:** subhagho@gmail.com
**Surfaced:** 2026-06-08, after 4 IDE re-runs of the GRN/INGRN data-analysis question. Successive runs landed three quality fixes (`shape-resolve` restoration, `compare-fields-vs-shape` fabrication guard, planner-wiring DSL clarity) but reports still ship with internal contradictions — early sections carry JSON-shape-as-class fabrications while later sections carry the real `code.class.extract-fields` output. The user's observation: "content gets more factual down the report, initial sections are always incorrect."
**Supersedes:** the current `step-section-planner → step-root-execution → step-section-review` linear flow inside `runTodoOrchestrator` for the per-TODO (task) path. Investigation-plan (top-level TODO list) is unchanged.
**Resurrects (with adaptation):** `plans/code-analyzer-discovery-plan-loop.md` (canonical design, June 2026), `plans/code-analyzer-gather-then-write.md` (G→W separation), `plans/code-analyzer-planner-discovery-loop.md` (cloud-driven discovery catalog). All three were deleted in the section-flow migration; their types survive in [`discovery-plan.ts`](../src/insrc/agent/content-gen/discovery-plan.ts) but the orchestrators that consumed them are gone.

---

## Context

### What we observe

After 4 successive IDE runs against `analyze how JSON in test/integration/data/BB/GRN maps to the Pydantic INGRN class`:

| Layer | Status |
|---|---|
| Catalog wiring (GAP A fix) | ✅ Solid — planner picks real skill ids |
| Shape-resolver (2-step executor restoration) | ✅ Solid — leaves no longer hit `invalid-input` |
| Compare-skill fabrication guard | ✅ Catches JSON-token classFields; ❌ doesn't catch Pydantic-shaped fabrications |
| Wiring-DSL prompt clarity | ⚠️ Marginal — structural failures still happen ~30% of TODOs |
| L2-fallback memory marker | ✅ Surfaces gaps to downstream TODOs |
| **End-to-end report quality** | **Mixed — early sections (TODOs 4-5) contain wrong-but-shaped tables, later sections (6-10) contain real class data, conclusion synthesizes correctly** |

### Why the residual quality problem is structural, not prompt-level

Per-TODO planning today is **task-driven**: given the goal + memory bundle + skill catalog, emit a `PlannedTree`. The planner has no explicit notion of:

- **Required facts** for the goal (what's necessary to answer it)
- **Available facts** in working memory (what was produced by prior TODOs / acquisition)
- **Gaps** = required \ available

Without that frame, the planner emits trees that:
- Include leaves to discover facts already in memory (waste)
- Skip leaves to discover facts that are prerequisites for downstream skills (gap → fabrication)
- Wire skills like `shared.compare.fields-vs-shape` whose `classFields` input must exist, without first ensuring some prior leaf produced that fact

Early TODOs are worst affected because memory is sparsest. Later TODOs accumulate facts and produce better trees by accident. The report assembler concatenates in execution order, so wrong-early/right-late is the natural reading order.

### The fix is per-TODO, not cross-TODO

The user's framing: each TODO should reason "what facts do I need vs what's in memory? Acquire the gap, then synthesize." This is what `discovery-plan-loop.md` designed and implemented in the now-deleted `agent/tasks/code-analyzer/discovery-flow.ts`. The per-section cycle there is structurally the right shape for the per-TODO task flow here.

The plan flow (Step 2 / `runInvestigationPlan`) is unchanged. The task flow (`runTodoOrchestrator` body) is what gets rebuilt.

---

## Decisions (locked unless overturned during implementation)

| # | Decision |
|---|---|
| 1 | Per-TODO orchestrator becomes a multi-cycle loop. Cycle 1 expands an initial discovery plan; cycles 2-3 expand based on the prior reviewer's `new_steps`. Cap = 3 cycles, matching `discovery-plan-loop`'s heuristic. |
| 2 | Reuse `DiscoveryStep / PlannedSkillCall / StepOutput / CycleReviewResponse / CycleMemory / Citation` types verbatim from [`agent/content-gen/discovery-plan.ts`](../src/insrc/agent/content-gen/discovery-plan.ts). They were designed for exactly this shape; current section-flow doesn't use them. |
| 3 | **Gap analysis lives in the reviewer, not the planner.** Cycle reviewer compares the retained ledger against the TODO's required-facts list and emits `new_steps` for uncovered facts. Matches the prior canonical design; keeps the planner purely decompositional. |
| 4 | The TODO's `required-facts` list is produced by a NEW pre-cycle stage (the `FactGapAnalysis`). Cloud LLM, takes the TODO objective + memory bundle, emits a structured list `[{fact, why, status: 'present'|'partial'|'absent', sourceRef?}]`. The cycle reviewer uses this as the coverage target, mirroring `criteriaCoverage` in the prior design but typed per-fact instead of per-criterion. |
| 5 | The cycle reviewer's `new_steps` are typed `DiscoveryStep[]` — same shape as the initial plan. The orchestrator executes them deterministically; no "decide when to stop" loop at the leaf level. |
| 6 | Step execution reuses `leaf-executor.ts` + the 2-step shape-resolver. A `DiscoveryStep` decomposes into `PlannedSkillCall[]`, each of which becomes a single leaf invocation with shape-resolved args. No tree-shape changes at the execution layer. |
| 7 | After the cycle loop terminates, a single **synthesis call** (current `step-section-assembly.ts` extended) produces the section markdown from the retained ledger. Section review (Q5 verdicts) stays in place — its job is now polish, not gap closure. |
| 8 | Memory acquisition order: when the reviewer flags a gap, the orchestrator first checks `cycleMemory.priorAsks` + per-fact `sourceRef` (is this fact already produced by a prior TODO?). If yes, inject from memory; if no, dispatch a skill via the reviewer's `new_steps`. Avoids redundant discovery. |
| 9 | The current `step-section-planner.ts` is replaced by a new `step-fact-gap-analysis.ts` (Stage 1) + `step-discovery-plan-expansion.ts` (per-cycle planner). The `PlannedTree` schema is no longer used at the per-TODO orchestration layer (it survives as the type the executor consumes). |
| 10 | **No feature flag.** The new fact-gap loop replaces the linear `section-planner → root-execution → section-assembly` path outright. The legacy modules are deleted in the same change set; not preserved as a fallback. Justification: the linear flow has been demonstrated to produce contradictory reports across 4 IDE re-runs; a one-env-var rollback isn't useful when the rollback target is broken. |
| 11 | Stop conditions, in order: (a) reviewer emits `new_steps: []`, (b) cycle count == 3, (c) no progress between cycles (current cycle's `keep.length` == 0 AND prior cycle's `keep.length` == 0). |
| 12 | When the cycle loop terminates with insufficient coverage (some facts still `absent`), the orchestrator does NOT fabricate. The synthesis call gets the partial ledger PLUS the gap list as explicit "the following facts could not be acquired" annotations. The section reviewer Q5 verdict surfaces this; report-review can flag as scope-gap (Q7). |
| 13 | **Followup steps are instruction-grade, not hints.** The cycle reviewer's `new_steps[]` must carry concrete acquisition instructions: each `DiscoveryStep.intent` names the specific fact to acquire; each `PlannedSkillCall.skillId` is a catalog-bound real id; each `PlannedSkillCall.context` includes the concrete args the skill needs (entity names, file paths, connection ids) extracted from prior outputs / memory; `dependsOn` is set when a call chains off another's output. Vague "look harder" or "try again" followups are rejected at the cycle-review parse step. |
| 14 | **Unmet-gap synthesis surfaces actionable detail, not just acknowledgement.** When Stage 6 encounters a fact that the cycle loop could not acquire, the synthesized section must include: (a) the fact name, (b) which steps attempted it (by id, from `cycleMemory.priorAsks`), (c) which skills were tried and what they returned (empty / error / off-topic), (d) a concrete next-step suggestion (which skill + args would close the gap on retry). This converts "we don't know" into a structured handoff. |

---

## Architecture

### Current task-flow (replaced by this plan)

```
runTodoOrchestrator(todo, memory):
  for replan in 0..maxReplans:
    tree = runSectionPlanner(todo, memory, catalog)
    rootResult = executeReviewableRoots(tree)
      for each root:
        executeLeaves(...)            // shape-resolve + runSkill
        reviewRoot()
          followup x 3 → revise-major → escalate
    if rootResult.reopen: continue (replan)
    section = assembleSection(rootResult)
    review = reviewSection(section)
    if review.reopen: continue
    return entry
  return l2Fallback()
```

### New task-flow

```
runTodoOrchestrator(todo, memory):
  // Stage 0: identify what facts we need vs have
  gapAnalysis = runFactGapAnalysis(todo, memory)
    └─► RequiredFact[] -- each tagged present | partial | absent

  // Stage 1: initial discovery plan from cloud (only over the absent / partial facts)
  cycle = 1
  cycleMemory = emptyCycleMemory(gapAnalysis.requiredFacts)
  stepsToRun = runDiscoveryPlanExpansion({
    todo, memory, gapAnalysis, catalog, cycle: 1, cycleMemory
  })
  retainedLedger: StepOutput[] = []

  while True:
    // Stage 2: execute each DiscoveryStep deterministically
    cycleOutputs = []
    for step in stepsToRun:
      stepOutput = executeDiscoveryStep(step, retainedLedger, memory)
        └─► for each PlannedSkillCall:
              call leaf-executor (shape-resolve + runSkill)
      cycleOutputs.push(stepOutput)

    // Stage 3: cycle reviewer = gap analyzer
    review = runCycleReview({
      todo, gapAnalysis, cycleOutputs, cycleMemory, retainedLedger
    })
      └─► { keep: stepIds[], new_steps: DiscoveryStep[], scratchpad? }

    // Stage 4: promote kept outputs, update memory
    retainedLedger += cycleOutputs.filter(o => o.stepId in review.keep)
    cycleMemory = updateCycleMemory(cycleMemory, cycle, stepsToRun, retainedLedger, gapAnalysis)

    // Stage 5: terminate?
    if review.new_steps.length === 0: break         // reviewer happy
    if cycle === MAX_CYCLES: break                  // cap
    if noProgress(cycleMemory): break               // safety net
    stepsToRun = review.new_steps
    cycle += 1

  // Stage 6: synthesis (replaces step-section-assembly)
  section = assembleSectionFromLedger({
    todo, retainedLedger, unmetGaps: gapAnalysis.requiredFacts.filter(absent)
  })

  // Stage 7: section review (existing Q5 verdicts, unchanged)
  review = reviewSection(section)
  if review.reopen: ... (revise-major escalation, same as today)
  return entry
```

### Stage-by-stage detail

#### Stage 0 — Fact gap analysis (NEW)

**LLM call:** cloud (using `sectionFlowProvider` from current code).

**Input:**
- Todo objective + origin
- Memory bundle (L1-L5 — system / summary / recent / semantic / code)
- Brief catalog summary (skill ids + one-line descriptions, NOT input schemas)

**Output (JSON, schema-pinned):**
```typescript
interface FactGapAnalysis {
  requiredFacts: RequiredFact[];
  reasoning: string;     // 1-2 sentence rationale for the fact set
}

interface RequiredFact {
  id: string;            // stable kebab-case id, used by DiscoveryStep.targetsCriteria
  fact: string;          // human-readable: "the INGRN class field list with types"
  why: string;           // why this fact is needed for the TODO
  status: 'present' | 'partial' | 'absent';
  sourceRef?: {          // present only when status !== 'absent'
    kind: 'memory-layer' | 'prior-todo';
    layer?: 'summary' | 'recent' | 'semantic' | 'code';
    todoId?: string;
    excerpt?: string;    // ≤200 chars; reviewer uses to verify
  };
  /** Optional suggestion for which skill(s) could acquire this fact. */
  suggestedSkills?: readonly string[];
}
```

**Retry:** 1 corrective if JSON schema violation. After retry → throw → L2 fallback (same as current section-planner exhaustion).

**Failure mode handling:** if Stage 0 yields `requiredFacts: []` (the TODO is trivial — answer is fully in memory), skip Stages 1-5 and go straight to synthesis. This is the natural fast-path for late TODOs that build on accumulated context.

#### Stage 1 — Discovery plan expansion (REPLACES section planner)

**LLM call:** cloud.

**Input:**
- Todo objective
- `requiredFacts` filtered to `absent` + `partial` (the gap set)
- Memory bundle (compact form — summary + relevant excerpts only)
- Full skill catalog (id + description + family + owner, NOT input schemas — those are injected at execute time per the canonical design)
- `cycleMemory` (empty for cycle 1; populated for cycle 2+)
- Cycle number

**Output (JSON, schema-pinned):**
```typescript
interface DiscoveryPlanResponse {
  steps: DiscoveryStep[];   // 2-8 steps per cycle
  reasoning: string;
}
```

`DiscoveryStep` reuses the existing type. Each step targets one or more `RequiredFact.id` via the existing `targetsCriteria` field (renamed semantically but type identical).

**Retry:** 1 corrective on validation failure. Same throw-on-second pattern.

**Catalog membership validation:** every `PlannedSkillCall.skillId` must be in the catalog (matches existing planner's GAP A fix); unknown ids → reject → corrective hint → retry.

#### Stage 2 — Step execution (REUSES leaf-executor)

For each `DiscoveryStep`:
- Build a `priorOutputs` map from `retainedLedger.facts` + `cycleMemory.scratchpad` + the in-cycle outputs from earlier steps (within this cycle).
- For each `PlannedSkillCall` in the step:
  - Build a synthetic `PlannedNode` (leaf with `skill: call.skillId, objective: call.context`, inputs: empty placeholder).
  - Invoke `leaf-executor.ts` with the `priorOutputs` map. The shape-resolver does its existing job: read prior outputs + the call's `context` text + the skill's input schema, emit args.
  - Capture the `SkillResult.value` as the step's contribution to `facts[]` + `citations[]`.

**No tree shape needed at this layer.** `DiscoveryStep[]` IS the execution plan. The current `PlannedTree` machinery (`composition`, `emit:section`, reviewable-roots) is bypassed — those concepts collapse into "step in cycle N produced fact F".

**Step output (`StepOutput` per existing type):**
- `stepId`
- `status: 'ok' | 'partial' | 'failed'` — `ok` if all calls returned non-empty, `partial` if some returned empty, `failed` if all errored
- `facts: string[]` — extracted by a local summarization call (same pattern as `agent/tasks/code-analyzer/summarize-result.ts`, which survives — port if needed)
- `citations: Citation[]` — structured per existing `Citation` type

#### Stage 3 — Cycle review (GAP ANALYZER, replaces per-root reviewer at the section level)

**LLM call:** cloud.

**Input:**
- Todo objective
- `gapAnalysis.requiredFacts` (the canonical target list)
- `cycleOutputs` (this cycle's StepOutput[] in full)
- `cycleMemory` (summarized via `summarizeCycleMemory`)
- Cycle number

**Output (JSON, schema-pinned):** existing `CycleReviewResponse` type.
```typescript
interface CycleReviewResponse {
  keep: string[];               // stepIds whose outputs are on-topic + useful → ledger
  new_steps: DiscoveryStep[];   // empty = terminate; non-empty = run next cycle
  scratchpad?: string;          // ≤300 chars, carried into next cycle's memory
}
```

**Reviewer's gap-analysis job:**
1. For each `RequiredFact` with `status: 'absent' | 'partial'`:
   - Check the `cycleOutputs.facts[]` for coverage.
   - Promote the producing step's stepId into `keep`.
   - Update the fact's effective coverage status.
2. If any `RequiredFact` remains `absent` after this cycle's keeps, emit `new_steps` that target it (suggesting different skills than already tried — see `cycleMemory.priorAsks`).
3. If all `RequiredFact`s are now `present` or `partial` (and the partials are deemed acceptable), emit `new_steps: []` to terminate.

**Followup quality contract (enforced at parse + by prompt; per Decision #13):**

Every emitted `DiscoveryStep` in `new_steps[]` MUST satisfy:

- `intent` is a concrete sentence naming the specific fact being acquired AND why the prior cycle didn't get it. Example: *good* — "Acquire the INGRN pydantic field list (class location known from cycle 1); previous attempt failed because `code.class.extract-fields` was called without a className argument." *Rejected* — "Look harder for the class."
- Each `PlannedSkillCall.skillId` is in the catalog (validator enforces, same retry pattern as Stage 1).
- Each `PlannedSkillCall.context` includes the actual literal args the skill needs, pulled from prior outputs / memory. Example: *good* — "Read class INGRN at path `insors/core/model/invoice/regions/IN/grn.py` (path from cycle-1 `locate-ingrn-class` step)." *Rejected* — "Read the INGRN class somewhere."
- `dependsOn` is set whenever a call needs another call's output (e.g. extract-fields depends on locate's entityId). Forward-ref violations are caught by the planned-tree validator's existing wiring check.
- Reviewer MUST NOT re-emit a step whose `(skillId, context)` pair matches an already-attempted step recorded in `cycleMemory.priorAsks` with a `failed` or `partial` outcome — unless the new step changes the args meaningfully (different className, different path, etc.). The prompt makes this explicit; the parser checks for exact duplicates.

A `new_steps[]` entry that fails any of these checks is rejected at parse time; the reviewer retries once with the rejection reason in a corrective hint. If retry also fails the step is dropped from `new_steps[]` (rather than failing the whole review).

#### Stage 4 — Ledger / cycleMemory update (mechanical)

No LLM call. Orchestrator:
- `retainedLedger += cycleOutputs[review.keep]`
- `cycleMemory.priorAsks.push({ cycle, steps: stepsToRun.map({id, intent}) })`
- `cycleMemory.criteriaCoverage = recomputeCoverage(retainedLedger, gapAnalysis.requiredFacts)`
- `cycleMemory.scratchpad = review.scratchpad ?? cycleMemory.scratchpad`

`recomputeCoverage` is deterministic: for each `RequiredFact.id`, find step outputs whose `targetsCriteria` includes it; mark `covered` if any kept step targets it AND its facts list is non-empty, `partial` if covered but facts list is sparse, `open` otherwise.

#### Stage 5 — Termination

In priority order:
1. `review.new_steps.length === 0` → reviewer is satisfied. Break.
2. `cycle === MAX_CYCLES` (default 3) → cap. Break.
3. `noProgress(cycleMemory)` → this cycle AND the prior cycle both promoted zero step outputs. Break to avoid spinning.

#### Stage 6 — Synthesis (REPLACES step-section-assembly)

**LLM call:** cloud (or local for cheaper synthesis on small ledgers — TBD by empirical validation).

**Input:**
- Todo objective
- `retainedLedger` (StepOutput[], the kept facts + citations)
- Unmet gaps: `gapAnalysis.requiredFacts.filter(f => f.status === 'absent' && not covered by retainedLedger)`

**Prompt directives:**
- Write the section markdown using ONLY facts in `retainedLedger`.
- For each unmet gap (per Decision #14), emit a **structured handoff block** rather than a vague acknowledgement. Each gap entry includes:
  - **Fact name** (from `RequiredFact.fact`)
  - **Why it was needed** (from `RequiredFact.why`)
  - **What was tried** — list of `(stepId, skillIds[], outcome)` triples from `cycleMemory.priorAsks` filtered to this fact's id
  - **Concrete next-step suggestion** — which specific skill + args would close the gap on retry, drawn from the catalog hints in `RequiredFact.suggestedSkills` if present
- Inline citations from `Citation[]` per existing format.
- No invention of fields, types, examples not present in `retainedLedger`.

Example unmet-gap rendering (instead of "We could not retrieve the INGRN class definition"):

```markdown
> **Unresolved fact: INGRN class field definitions**
>
> Required for: producing the JSON-to-class field mapping table.
>
> Acquisition attempts:
> - cycle 1 step `extract-ingrn-fields` — called `code.class.extract-fields` with no `className` arg; returned empty
> - cycle 2 step `retry-class-extract` — called `code.entity.locate-by-name` with `name="INGRN"`; returned 0 matches
>
> Suggested next step: invoke `code.class.extract-fields` with `className="INGRN"` and `filePath="insors/core/model/invoice/regions/IN/grn.py"` (path discovered in cycle 1 by `locate-ingrn-class`).
```

This converts an unmet gap from a dead end into actionable handoff data — useful for the user reading the report AND for a future re-run that gets a richer initial memory.

This replaces the current `step-section-assembly.ts` which assumes a `PlannedTree` with `emit:section` roots. Synthesis here is just markdown generation from typed evidence + structured gap handoffs.

#### Stage 7 — Section review (UNCHANGED)

Current `step-section-review.ts` runs as-is. Its `accept | revise-edits | revise-major` verdicts still gate the section. Note: `revise-major` no longer drives a "replan tree" loop (there's no tree); instead it triggers a re-cycle starting from Stage 1 with `cycleMemory.priorAsks` retained as context.

---

## Module layout

### NEW files

```
src/insrc/agent/section-flow/
  step-fact-gap-analysis.ts          ← Stage 0
  step-discovery-plan-expansion.ts   ← Stage 1
  step-discovery-execute.ts          ← Stage 2 (adapter: DiscoveryStep[] → leaf-executor calls)
  step-cycle-review.ts               ← Stage 3
  step-synthesis-from-ledger.ts      ← Stage 6 (replaces step-section-assembly for new flow)
  cycle-memory.ts                    ← summarizeCycleMemory, recomputeCoverage helpers
  prompts/
    fact-gap-analysis.md             ← Stage 0 prompt
    discovery-plan-expansion.md      ← Stage 1 prompt
    cycle-review.md                  ← Stage 3 prompt
    synthesis-from-ledger.md         ← Stage 6 prompt
  __tests__/
    step-fact-gap-analysis.test.ts
    step-discovery-plan-expansion.test.ts
    step-cycle-review.test.ts
    step-synthesis-from-ledger.test.ts
    cycle-memory.test.ts
    fact-gap-loop.integration.test.ts   ← end-to-end with scripted providers
```

### MODIFIED files

```
src/insrc/agent/section-flow/
  todo-orchestrator.ts               ← gated alternate body; feature flag selects fact-gap-loop vs linear
  index.ts                           ← export new step modules + types
src/insrc/daemon/controllers/
  data-analyzer-orchestrator.ts      ← no change; the orchestrator's call to runSectionFlow is identical
src/insrc/agent/content-gen/
  discovery-plan.ts                  ← un-orphan: re-export from section-flow if useful; add helpers if needed
```

### REUSED unchanged

```
src/insrc/agent/section-flow/
  leaf-executor.ts                   ← shape-resolve + runSkill (no change)
  shape-resolve.ts                   ← 2-step executor stage 1 (no change)
  step-investigation-plan.ts         ← top-level TODO planning (plan flow, untouched)
  step-scope.ts                      ← Step 1 (untouched)
  step-section-review.ts             ← Q5 verdicts (untouched)
  step-report-assemble.ts            ← Q7 report assembly (untouched)
  step-report-review.ts              ← Q7 review (untouched)
  run-section-flow.ts                ← top-level driver (no change)
src/insrc/agent/working-memory/      ← memory shaper + updater (untouched)
src/insrc/agent/content-gen/
  discovery-plan.ts                  ← types we resurrect
```

### DELETED (in the Phase ε cutover, same commit)

```
src/insrc/agent/section-flow/
  step-section-planner.ts            ← replaced by Stages 0 + 1
  step-root-execution.ts             ← replaced by Stages 2 + 3
  step-section-assembly.ts           ← replaced by Stage 6
```

Per Decision #10, these are deleted at the cutover, not deferred. Rollback path if empirical validation regresses is `git revert` of the cutover commit; no runtime fallback is retained.

---

## Migration phases

Mirrors the original `code-analyzer-discovery-plan-loop.md` (Phases α-η):

### Phase α — Types + helpers (no behavior change)

- Verify the existing `discovery-plan.ts` types still parse + export. Re-export from `section-flow/index.ts`.
- Implement `cycle-memory.ts`: `summarizeCycleMemory`, `recomputeCoverage`, `emptyCycleMemory(requiredFacts)`. Patterned after the original `agent/tasks/code-analyzer/cycle-memory.ts` (extract from git history at commit `1bb7806e2f3^`).
- Implement `FactGapAnalysis` types (new, in `step-fact-gap-analysis.ts`).
- **Tests:** ~12 unit tests for cycle-memory + coverage computation.
- **Risk:** low; pure data shape work.

### Phase β — Stage 0 (fact-gap analysis, new module, not wired)

- Implement `runFactGapAnalysis(input)` with cloud LLM call + corrective retry + JSON-schema-pinned output.
- Prompt design: `prompts/fact-gap-analysis.md`. Worked example showing a TODO objective + memory bundle → expected `RequiredFact[]` output.
- **Tests:** 8 tests via scripted provider — happy path, all-present (trivial fast-path), corrective retry, schema violation throw.
- **Live test:** `scripts/live-section-flow/11-fact-gap-analysis.ts` runs the real qwen3.6 against a synthetic TODO + memory bundle, asserts the gap analysis is internally consistent.

### Phase γ — Stages 1, 3 (discovery-plan expansion + cycle review, new modules, not wired)

- Implement `runDiscoveryPlanExpansion(input)` — Stage 1 cloud call.
- Implement `runCycleReview(input)` — Stage 3 cloud call.
- Both reuse the existing `DiscoveryStep` / `CycleReviewResponse` types and the corrective-retry pattern from the existing section-planner.
- **Tests:** 12 tests covering cycle-1 expand, cycle-2+ expand with cycleMemory, review with keep+new_steps, review with keep-only (termination), schema violation.
- **Live tests:** `scripts/live-section-flow/12-discovery-expansion.ts` + `13-cycle-review.ts`.

### Phase δ — Stage 2 (discovery-step executor adapter)

- Implement `executeDiscoveryStep(step, priorOutputs, leafExecutorDeps)` — takes a `DiscoveryStep`, walks its `PlannedSkillCall[]`, dispatches each through the existing `leaf-executor.ts`, captures + summarizes into `StepOutput`.
- Summarization: port `summarize-result.ts` from `agent/tasks/code-analyzer/` (extract from git; it survived the migration as orphan code OR needs re-extracting from `b8c94385f7a^`).
- **Tests:** 8 tests with mock leaf-executor — happy path, partial step (some leaves empty), failed step, multi-call dependency ordering.

### Phase ε — Orchestrator cutover (replaces linear flow outright)

Per Decision #10: no feature flag. The cutover happens in one change set:

- Replace `runTodoOrchestrator`'s body with Stages 0 → 1 → cycle-loop (2 → 3 → 4 → 5) → 6 → 7.
- **Delete** `step-section-planner.ts`, `step-root-execution.ts`, `step-section-assembly.ts` and their unit tests in the same commit. The deletes are part of the cutover, not a follow-up phase.
- Remove the now-dead `LeafExecutorDeps.provider` callsite that the legacy flow used (the shape-resolver call moves under `step-discovery-execute.ts`).
- Update `index.ts` to export only the new stage modules.
- Update `CLAUDE.md` references.
- **Tests:** 5 integration tests covering: trivial fast-path (no gaps), 1-cycle termination, 3-cycle cap, no-progress safety net, unmet-gap synthesis with structured handoff block.

### Phase ζ — Empirical validation

Same workload as the recent IDE re-runs (GRN/INGRN question). The bar is meaningful improvement on the dimensions where the linear flow failed:

- **Per-TODO outcomes:** target ≥7/10 success without L2 fallback (linear baseline: 5/10).
- **Report quality:** target 0 sections with self-contradictory class definitions; ≥80% of factual claims grounded in `retainedLedger`.
- **Unmet-gap rendering:** any TODO with absent facts ships with a structured handoff block (per Decision #14), not a fabricated mapping table.
- **Latency:** expect 2-3× per-TODO cloud cost (extra Stage 0 + per-cycle review calls). Acceptable if quality improvement is real.
- **Memory pressure:** verify accumulated `retainedLedger` across TODOs fits in working memory budget.

If Phase ζ shows regression on per-TODO outcomes (worse than 5/10) the plan rewinds via `git revert` of the cutover commit. There is no fallback path baked into the runtime.

---

## Test strategy

- **Unit tests (~45 across α-δ):** every Stage 0 / 1 / 3 / 6 LLM call has a dedicated test file with scripted providers covering happy path, retry, schema violation, edge cases. Cycle-memory + coverage helpers get pure-function tests.
- **Integration test (1 file, ~5 cases in Phase ε):** runs the full per-TODO loop with three scripted providers (fact-gap, discovery-expand, cycle-review), asserts the orchestrator drives them in the right order and ledger accumulates correctly.
- **Live tests (3 new scripts in Phase β-γ):** `scripts/live-section-flow/{11,12,13}.ts` — same pattern as existing live tests, qwen3.6, schema+sanity validation. Add a `14-fact-gap-loop-e2e.ts` script that runs an entire per-TODO loop end-to-end against the real model on a single TODO.
- **Regression suite (existing):** 389+ tests across working-memory, section-flow, content-gen, skills must keep passing. The new flow is gated so existing tests run the legacy path.

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| **Cloud cost spike** (Stage 0 + per-cycle review × 3 cycles × N TODOs) | Token caching (already landed) softens. Stage 0 is small. Cycle review payload bounded by ledger + cycle outputs. If cost is prohibitive, drop cycle cap to 2 OR move Stage 6 synthesis to local. |
| **Stage 0 fact list is wrong/incomplete** | The cycle reviewer's job is exactly to catch this — if a fact wasn't on the required list but turns out to be needed, the reviewer can still emit `new_steps` for it. Stage 0 is the starting point, not the contract. |
| **Stage 1 planner still hallucinates skill ids** | Catalog-membership validation + corrective retry already in place (inherited from current section-planner). Wiring-DSL prompt clarity (current Fix #2) inherits. |
| **`noProgress` safety net fires too aggressively** | The check is "current AND prior cycle both kept 0 outputs". A single 0-keep cycle doesn't terminate. Pathological run-aways are bounded by `MAX_CYCLES=3`. |
| **Unmet-gap synthesis still fabricates** | Stage 6 prompt explicitly says "for unmet gaps, write a single-sentence acknowledgement; do NOT invent". Section reviewer Q5 verifies. Report reviewer Q7 surfaces as scope-gap. |
| **Existing report-review can't reason about the new entry shape** | Entry shape (`WorkingMemoryEntry`) is unchanged — `findings.perRoot` becomes `findings.cycleOutputs` semantically but the type interface stays. Memory updater unchanged. |
| **Schema drift on the new responseFormat JSON** | All four new LLM calls use schema-pinned `responseFormat`. Corrective retry pattern from current section-planner is the reference. |

---

## Open questions (resolve during implementation)

1. **Stage 6 synthesis: cloud or local?** Cloud gives quality consistency with the rest of the flow; local saves cost. Recommend cloud for v1; revisit after Phase ζ.

2. **`PlannedTree` deprecation timing.** The shape-resolver currently takes a `PlannedNode` (leaf). The new flow constructs synthetic `PlannedNode`s from `PlannedSkillCall`s. Should we keep `PlannedTree` as the leaf-execution contract or simplify? Recommend keep for v1 to minimize blast radius; revisit in cleanup.

3. **Revise-major from section review (Stage 7) → re-cycle.** When Q5 says `revise-major`, the new flow re-cycles. Does that mean Stage 1 again with the same `gapAnalysis`, or does it mean re-running Stage 0 to refresh the gap list given the section reviewer's complaint? Recommend re-run Stage 0 — the reviewer's revise-major reason is the strongest signal about what's missing.

4. **Cross-TODO ledger sharing.** Currently each TODO's `retainedLedger` is private. The working-memory bundle does carry forward facts. Should the cycle reviewer at Stage 3 cite "this fact is already in memory from todo-X" as a reason to emit `new_steps: []`? Recommend yes — add to Stage 3 prompt as a check before emitting new_steps.

5. **Acquisition for memory-layer hits.** When Stage 0 marks a fact as `present` with `sourceRef: { kind: 'memory-layer' }`, does Stage 6 cite it directly or do we need an "acquire from memory" pseudo-step? Recommend direct citation — the memory layer IS the source.

---

## Out of scope

- Investigation-plan (plan flow) iteration. The top-level TODO list still emits once; no re-planning at that level. (The current report-review Q7 `revise-structural` already provides this escape; no changes needed.)
- Cross-TODO parallelism. Each TODO still runs serially. (Memory pressure + LLM rate limits make parallelism risky without separate work.)
- Synthesis quality measurement beyond manual inspection. No automated "report quality score" in this plan.
- Migrating code-analyzer to the same flow. (Separate analyzer; if this pattern works, port via a separate plan.)
- The `compare-fields-vs-shape` skill fabrication guard from the recent fix #1 commit (`7df5e48bfce`) STAYS — it's an orthogonal defense at the skill level.

---

## Success criteria

For the GRN/INGRN question against the same workload as the 4 recent IDE re-runs:

- **Per-TODO outcomes:** ≥7/10 TODOs produce real content (success or `revise-edits`-then-accept) without L2 fallback. Baseline (last run): 5/10.
- **Report-level contradictions:** 0 sections with self-contradictory class definitions. Baseline: every run has at least one.
- **Factual grounding:** every concrete claim in the final report traces to a `retainedLedger.facts` entry OR an explicit "we could not acquire" acknowledgement. No fabricated field names, types, or analysis sections.
- **Reviewer Q7 verdict:** `accept` or `revise-edits`. `revise-structural` only when there's a real cross-section contradiction (which should drop to ~0 given Stage 0's fact-grounding).
- **No regressions** in the 389-test suite.

If any of these regress vs the current state, the locked decisions get revisited.
