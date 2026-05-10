# Analyzer synthesis: cloud-plan / local-expand / cloud-review

**Status:** draft (2026-05-10)
**Owner:** subhagho@gmail.com
**Applies to:** code-analyzer, data-analyzer

## Summary

Today the analyzer synthesis path forks on scope tier: tier `S/M` runs a
single-pass local-only synthesis (`queueSinglePassSynthesise`,
`providerHint: 'local'`, `maxTokens: 4000`); tier `L+` runs the
multi-pass content generator (`generateMultiPass`) which uses ONE
provider — the active cloud — for both the outline pass AND every
per-section draft.

Both paths are wrong for what the user actually wants:

- The S/M path can't scale beyond a single Ollama call. When the scope
  classifier under-shoots (e.g. "do a detailed analysis of HDFS Core"
  → tier M → trivial report, see /tmp/.insrc/agent.2.log:30899-30900),
  the user is locked out of the cloud entirely.

- The L+ path bills cloud tokens on every section body, even though
  most of that work is structural ("draft section X from finding
  bundle Y") that local models do well enough.

This plan replaces both paths with a single uniform flow modelled on
the brainstorm agent's diverge→converge structure:

```
                                  ┌──────────────────────┐
                                  │    plan (cloud)      │
                                  │  -> N action-cards   │
                                  └──────────┬───────────┘
                                             │
                  ┌─────────────────────┬────┴────┬─────────────────────┐
                  ▼                     ▼         ▼                     ▼
        ┌─────────────────┐                              ┌─────────────────┐
        │ expand (local)  │   ... per action ...         │ expand (local)  │
        │   -> draft      │                              │   -> draft      │
        └────────┬────────┘                              └────────┬────────┘
                 ▼                                                ▼
        ┌─────────────────┐                              ┌─────────────────┐
        │ review (cloud)  │                              │ review (cloud)  │
        │ -> accept|refine│                              │ -> accept|refine│
        └────────┬────────┘                              └────────┬────────┘
                 │                                                │
                 └──────────────────────┬─────────────────────────┘
                                        ▼
                              ┌──────────────────┐
                              │  stitch + emit   │
                              │  no overall pass │
                              └──────────────────┘
```

**Key contract: NO overall review pass.** Per the user's specification,
once each action passes its individual cloud review, the stitched
output is final. The cloud doesn't see (or bill) the assembled report.

---

## Goals

1. Every analysis prompt — regardless of tier — runs through
   plan(cloud) → per-action [expand(local) → review(cloud)] →
   stitch.
2. The plan stage is the only place the cloud sees the full prompt +
   skill executions; per-action expand and review see only the
   action-card slice.
3. Per-action review can request ONE refinement round (cloud sends a
   bounded redo hint, local re-expands, cloud reviews again).
   Second-round rejection is accepted as-is — no infinite loop.
4. The overall report is never sent back to the cloud for a global
   review. Per-action review is the final quality gate.
5. Scope tier still controls the action budget (how many actions the
   plan can name) but no longer controls which provider runs which
   stage.

## Non-goals

- This plan does NOT change the skills pipeline (classify-question,
  select-scope, per-skill execution, calibrate-confidence). Those
  upstream stages still run as today.
- This plan does NOT introduce a user-facing gate per action.
  Brainstorm gates after every step because brainstorm is
  collaborative; analyzer is batch. The cloud is the per-action
  reviewer instead of the user.
- This plan does NOT touch the report-pane rendering. The output is
  still markdown; the only change is how that markdown is generated.
- This plan does NOT remove tier classification entirely. Tier still
  drives the action budget cap (S=2, M=4, L=8, XL=12, ...).

---

## Existing primitives (what we build on)

### Brainstorm agent (reference architecture)

`src/insrc/agent/tasks/brainstorm/`. Brainstorm is a multi-round
diverge→converge loop where:

- **Cloud** generates ideas (seed, diverge, promote, update-spec).
- **Local** clusters ideas into themes (the only forced-local step).
- **User** is the per-step critic via gates.

The pattern we borrow is the **decomposition + per-action loop**, not
the user-as-critic pattern. Our equivalent of "user gates" is the
cloud-review step.

### Multi-pass content generator

`src/insrc/agent/content-gen/index.ts:generateMultiPass`. Already does
outline → per-section drafts → stitch, but takes a single `provider`
argument used for both passes. We extend it to accept TWO providers
(planner + expander) and add a third optional `reviewer` callback per
section.

### Skills pipeline result

`src/insrc/agent/tasks/code-analyzer/skills-pipeline.ts`. Produces
`SkillsPipelineResult` with executions, calibrated confidence, notes.
This is what feeds the planner. No changes needed here.

### Provider resolver

`session.resolver.resolve(agent, step)`. Already supports per-step
provider config. We add three new step ids:

- `code-analyzer/plan` — cloud
- `code-analyzer/expand` — local
- `code-analyzer/review` — cloud

(parallel ids for `data-analyzer`).

---

## Architecture

### Stage 1 -- Plan (cloud)

**Input:**
- `request`: the user's prompt (already enhanced by Phase 4
  question-enhancer when the slash path ran).
- `repoSummary`: from `RepoSummary`.
- `executions`: the `PerSkillExecution[]` from the skills pipeline.
- `tier`: the scope tier (caps action count).
- `priorContextSummary` (optional): one-line summary of what prior
  turns covered, so the planner doesn't repeat them.

**Output:** `PlanResult`
```ts
interface PlanResult {
  readonly intentBrief:   string;          // 1-2 sentences: what the report is about
  readonly actions:       readonly PlannedAction[];
}

interface PlannedAction {
  readonly id:            string;          // e.g. "modules-overview"
  readonly title:         string;          // user-facing section heading
  readonly objective:     string;          // 1 sentence: what this section answers
  readonly evidence:      readonly EvidenceRef[];  // skill executions to cite
  readonly maxBudgetTokens: number;        // expand-stage cap
  readonly reviewCriteria: readonly string[]; // 3-5 bullets the reviewer checks
}

interface EvidenceRef {
  readonly skillId:       string;
  readonly executionIdx:  number;
  readonly highlight?:    string;          // optional excerpt the planner wants emphasised
}
```

**Action budget by tier:**
| tier | maxActions |
|------|-----------|
| S    | 2         |
| M    | 4         |
| L    | 8         |
| XL   | 12        |
| XXL  | 16        |
| XXXL | 24        |
| XXXXL | 32       |

These caps are advisory; the planner can return fewer. The orchestrator
clamps to `maxActions`.

**Why cloud:** the planner needs to:
- understand the user's prompt intent
- correlate it against N skill executions
- decompose into focused sections
- write per-action review criteria

This is structured-reasoning + good-taste work. Local Ollama at
qwen3-coder routinely loses focus past 8K context. Cloud is required.

### Stage 2 -- Expand (local), per action

**Input:** one `PlannedAction` + its referenced evidence (sliced from
`PerSkillExecution[]` so only what the plan cited reaches the
expander). Also gets the action-shaped prompt with `objective` and
`reviewCriteria` so the local model knows what shape to write toward.

**Output:** `ExpandResult`
```ts
interface ExpandResult {
  readonly actionId:  string;
  readonly markdown:  string;
  readonly tokenEstimate: number;
}
```

**Why local:** the work is "draft a section about <objective> using
<evidence>". This is well-scoped, has a clear shape (paragraph + bullet
list + code excerpt + cite line), and the action's review criteria tell
the model what to include. Local Ollama is fast and free for this.

**Token cap:** `action.maxBudgetTokens`. Default 1500 per action. The
expander prompt asks the local model to STOP at the cap and emit a
truncation marker — the reviewer then asks for a focused redo if
truncation actually hurt the output.

### Stage 3 -- Review (cloud), per action

**Input:** the `PlannedAction` + the local `ExpandResult` markdown +
the same evidence the expander saw. Uses a structured-output prompt
the reviewer must answer in JSON:

```ts
interface ReviewResult {
  readonly verdict: 'accept' | 'refine';
  readonly accepted?: { markdown: string };          // verdict='accept' may also include polish
  readonly refine?: {
    readonly hint: string;                            // ONE specific fix
    readonly maxAttempts: 1;                          // hard cap
  };
  readonly notes: readonly string[];
}
```

**Verdicts:**
- `accept`: take the local output as-is (or a lightly polished version
  if the reviewer chose to rewrite).
- `refine`: hand back a single focused hint ("section misses the YARN
  cross-reference" / "expand the cyclic-deps citation") and re-run the
  expander once with the hint appended to its system prompt. Second
  review verdict is binding even if `refine` again — emit
  `notes: ['second-review-still-refine; accepting']` and accept.

**Why cloud (not local):** the reviewer is the per-action quality gate.
It checks against the planner's own `reviewCriteria` (which the local
expander tries to satisfy but doesn't always). A weaker model self-
reviewing collapses into "looks fine" rubber-stamping.

**Cost calibration:** the reviewer prompt is small (action card + ~1500
token markdown + 5 review criteria). Each cloud call here is a few
hundred output tokens (the JSON verdict). Per-action review cost ≈
10-15% of what the L+ path currently spends drafting that section in
the cloud. Net: tier L runs get cheaper; tier S/M runs spend a small
amount on cloud (currently zero) but produce vastly better output.

### Stage 4 -- Stitch (no further LLM work)

Concatenate accepted action markdown in plan order with the
intent-brief as the report intro and the existing drill-down footer.
**No overall cloud review.** Per the user's contract, this is the
final output.

---

## Phase 1 -- Plan helper

**File:** `src/insrc/agent/content-gen/plan-actions.ts` (new)

```ts
export interface PlanActionsInput {
  readonly request:     string;
  readonly repo:        RepoMetaContext;
  readonly executions:  readonly PerSkillExecution[];
  readonly tier:        ScopeSize;
  readonly priorContextSummary?: string;
  readonly maxActions:  number;            // caller clamps from tier table
  readonly maxTokens?:  number;            // default 2500
}

export interface PlanActionsResult {
  readonly intentBrief: string;
  readonly actions:     readonly PlannedAction[];
  readonly degraded:    boolean;           // true if planner returned 0 actions or unparseable JSON
}

export async function planActions(
  input: PlanActionsInput,
  cloudProvider: LLMProvider,
): Promise<PlanActionsResult>;
```

Mirrors `generateOutline` in `content-gen/outline.ts`: structured JSON
output, schema-validated, one retry on parse failure, fallback to
`{ intentBrief: '...', actions: [], degraded: true }` on second
failure. Caller handles degraded-empty by falling back to a single
synthetic "summary" action.

System prompt outline:
- "You plan an analysis report."
- Action structure: id, title, objective, evidence, maxBudgetTokens,
  reviewCriteria.
- Hard cap on action count (`maxActions`).
- Each action's evidence MUST cite at least one skillId + executionIdx
  from the supplied executions.
- Review criteria are 3-5 short bullets the reviewer will use.

**Tests:** `agent/content-gen/__tests__/plan-actions.test.ts`
- happy path: returns N actions matching the input
- planner over-shoots `maxActions`: clamped
- planner returns no actions: degraded=true
- evidence references unknown skillId: dropped (not rejected)
- per-action token budget never exceeds `maxTokens / maxActions * 2`

---

## Phase 2 -- Expand helper

**File:** `src/insrc/agent/content-gen/expand-action.ts` (new)

```ts
export interface ExpandActionInput {
  readonly action:    PlannedAction;
  readonly evidence:  readonly PerSkillExecution[];   // already sliced to action.evidence
  readonly request:   string;
  readonly refineHint?: string;                       // optional second-pass hint
}

export interface ExpandActionResult {
  readonly actionId:      string;
  readonly markdown:      string;
  readonly tokenEstimate: number;
  readonly truncated:     boolean;
}

export async function expandAction(
  input: ExpandActionInput,
  localProvider: LLMProvider,
): Promise<ExpandActionResult>;
```

Plain text output (NOT JSON). Single LLM call. Token cap from
`action.maxBudgetTokens`. The system prompt:
- "You write ONE section of an analysis report."
- "The section's objective is: ..."
- "It must satisfy these review criteria: ..."
- "Use ONLY the supplied evidence; cite skillId+excerpt where useful."
- If `refineHint` is set: "On a prior pass the reviewer said: <hint>.
  Address this without rewriting the whole section."

Truncation handling: if response hits `maxTokens`, set
`truncated: true` and let the reviewer judge whether to refine.

**Tests:** `agent/content-gen/__tests__/expand-action.test.ts`
- happy path with stub provider
- truncation flag set when response is at cap
- refineHint appears in the prompt sent to the provider
- evidence-only constraint: when stubbed provider returns markdown
  citing an unsupplied skill, the function does NOT post-validate
  (that's the reviewer's job)

---

## Phase 3 -- Review helper + per-action loop

**File:** `src/insrc/agent/content-gen/review-action.ts` (new)

```ts
export interface ReviewActionInput {
  readonly action:    PlannedAction;
  readonly draft:     ExpandActionResult;
  readonly evidence:  readonly PerSkillExecution[];
}

export interface ReviewActionResult {
  readonly verdict:   'accept' | 'refine';
  readonly accepted?: { markdown: string };
  readonly refine?:   { hint: string };
  readonly notes:     readonly string[];
}

export async function reviewAction(
  input: ReviewActionInput,
  cloudProvider: LLMProvider,
): Promise<ReviewActionResult>;
```

Strict-JSON output, schema-validated, one retry on parse failure.
Fallback verdict is `accept` (treats unparseable review as a soft
accept rather than blocking the report).

System prompt outline:
- "You review one section of an analysis report."
- Lists `action.reviewCriteria` and tells the reviewer to score
  against each.
- Output schema: `{ verdict, accepted?, refine?, notes }`.
- "Refine ONLY when a specific concrete fix is needed. If the section
  is broadly OK, accept (optionally with light edits)."
- "Refine hints MUST be a single actionable sentence. Do not list
  multiple issues -- pick the most important one."

**Per-action loop driver** (in the same file):

```ts
export async function expandThenReview(
  action: PlannedAction,
  evidence: readonly PerSkillExecution[],
  request: string,
  localProvider: LLMProvider,
  cloudProvider: LLMProvider,
  opts?: { onProgress?: (step: 'expand1'|'review1'|'expand2'|'review2'|'final', payload: unknown) => void },
): Promise<{ markdown: string; rounds: 1 | 2; verdict: 'accept' | 'refine-then-accept' }>;
```

Algorithm:
1. `draft1 = expandAction(action, evidence, request, undefined, localProvider)`
2. `review1 = reviewAction(action, draft1, evidence, cloudProvider)`
3. If `review1.verdict === 'accept'`: return `{ markdown: review1.accepted?.markdown ?? draft1.markdown, rounds: 1, verdict: 'accept' }`
4. Else (refine):
   - `draft2 = expandAction(action, evidence, request, review1.refine!.hint, localProvider)`
   - `review2 = reviewAction(action, draft2, evidence, cloudProvider)`
   - If `review2.verdict === 'accept'`: return `{ ..., rounds: 2, verdict: 'refine-then-accept' }`
   - Else: return `{ markdown: review2.accepted?.markdown ?? draft2.markdown, rounds: 2, verdict: 'refine-then-accept' }` (binding accept; `notes` includes `'second-review-still-refine; accepting'`)

`onProgress` fires at each phase so the orchestrator can stream
liveStep updates ("Expanded section X (round 1)" / "Reviewed section X
(accept)" / etc.).

**Tests:** `agent/content-gen/__tests__/review-action.test.ts` +
`agent/content-gen/__tests__/expand-then-review.test.ts`
- accept on first review: 1 round, no second expand
- refine then accept: 2 rounds
- refine then refine: 2 rounds + binding accept + notes flag
- expand throws: surfaces as error
- review unparseable JSON: fallback accept

---

## Phase 4 -- Replace tier-based dispatch

**File:** `src/insrc/daemon/controllers/code-analyzer-orchestrator.ts`

Current `queueSynthesise` (`code-analyzer-orchestrator.ts:730`):
```ts
if (tier === 'S' || tier === 'M') {
  return this.queueSinglePassSynthesise(...);   // local-only
}
return this.runMultipassSynthesise(...);         // cloud-only multipass
```

Replace with a single new path:

```ts
private async queueSynthesise(state: TaskStateStore): Promise<Task[] | null> {
  state.set(K_PHASE, 'synthesising' as Phase);
  // ... pull ca / planned / accepted / tier from state ...

  const cloud = session.resolver.resolve('code-analyzer', 'plan');
  const local = session.ollamaProvider;       // explicit local; not via resolver
  const reviewer = session.resolver.resolve('code-analyzer', 'review');

  // Stage 1: plan (cloud)
  this.emitLiveStep('synthesise (plan)', 'planning report sections...\n');
  const plan = await planActions(
    {
      request:     ca.request,
      repo:        repoContextFromSummary(this._repoSummary!),
      executions:  accepted.map(a => ...toPerSkillExecution(a)),
      tier,
      maxActions:  ACTION_BUDGET_BY_TIER[tier],
    },
    cloud,
  );
  this.emitLiveStep('synthesise (plan)', `planned ${plan.actions.length} sections\n`);
  this.emitLiveStep('synthesise (plan)', '', /*done=*/true);

  if (plan.degraded || plan.actions.length === 0) {
    // Fallback: synthetic single-action plan
    plan.actions = [synthesiseFallbackAction(ca, accepted)];
  }

  // Stage 2+3: per-action expand+review
  const sections: { actionId: string; markdown: string }[] = [];
  for (const action of plan.actions) {
    const evidence = pickEvidence(action, accepted);
    const stepId = `synthesise (${action.id})`;
    this.emitLiveStep(stepId, `expanding "${action.title}"...\n`);
    const out = await expandThenReview(
      action,
      evidence,
      ca.request,
      local,
      reviewer,
      {
        onProgress: (phase, _) => this.emitLiveStep(stepId, `${phase}: ${action.id}\n`),
      },
    );
    this.emitLiveStep(stepId, `reviewed (${out.verdict}, ${out.rounds} round${out.rounds === 1 ? '' : 's'})\n`);
    this.emitLiveStep(stepId, '', true);
    sections.push({ actionId: action.id, markdown: out.markdown });
  }

  // Stage 4: stitch (no further LLM work)
  const markdown = stitchReport(plan.intentBrief, sections, this._parentListId);
  state.set(K_SYNTH_RESULT, markdown);
  await this.finalizeSynthesisedReport(state);
  return null;
}
```

Removed:
- `queueSinglePassSynthesise()` (tier S/M ceiling)
- The tier-based fork at line 737
- The single-provider `runMultipassSynthesise()` is reused only as the
  legacy fallback if the new path throws (and that's optional).

`ACTION_BUDGET_BY_TIER` table goes in
`agent/content-gen/plan-actions.ts` so both the helper and the
orchestrator agree on the cap.

**Stitching:** new helper in
`agent/content-gen/stitch-actions.ts`. Takes `intentBrief` + sections
in plan order; emits markdown with `## <title>` per section. Drill-
down footer is appended by the existing
`appendSyntheticDrillDown` helper.

---

## Phase 5 -- Wire to data-analyzer

`src/insrc/daemon/controllers/data-analyzer-orchestrator.ts` mirrors
the code-analyzer's synthesis layout. Apply the same Phase 4 swap:
- `data-analyzer/plan`, `data-analyzer/expand`, `data-analyzer/review`
  resolver step ids.
- Same `expandThenReview` driver (it's analyzer-agnostic).
- Same `ACTION_BUDGET_BY_TIER` table.
- Same fallback behaviour on degraded plan.

The data-analyzer's actions will cite `data.*` skill executions but
the helper code is identical.

---

## Phase 6 -- Streaming / progress

The orchestrator emits to the chat panel via `emitLiveStep` (see Phase
4 in conversation-flow-refinement.md). For this synthesis flow:

- One bubble for the **plan** stage (`synthesise (plan)`):
  `planning report sections...` → `planned N sections`
- One bubble per **action** (`synthesise (<action.id>)`):
  `expanding "<title>"...` → `expand1 done` → `review1: refine "..."`
  → `expand2 done` → `review2: accept` → `done`
- One short progress message at the top before stitch:
  `building final report...`

Brainstorm-equivalent: brainstorm uses one bubble per agent step
(seed/diverge/converge); we use one per planned action. Provides the
user with visible per-action progress without flooding.

---

## Phase 7 -- Tests

### Unit tests

- `plan-actions.test.ts`: happy path, over-cap clamp, degraded
  fallback, evidence reference dropping.
- `expand-action.test.ts`: happy path, truncation flag, refine hint
  inclusion.
- `review-action.test.ts`: accept verdict, refine verdict, parse
  failure → soft accept.
- `expand-then-review.test.ts`: 1-round accept, 2-round refine→accept,
  2-round refine→refine binding accept, abort signal mid-loop.

### Integration tests

- `code-analyzer-synthesis-three-stage.test.ts`: drive the
  orchestrator's `queueSynthesise` with a stubbed cloud + local
  provider pair and assert the final markdown contains all planned
  sections in order.
- `data-analyzer-synthesis-three-stage.test.ts`: same shape for
  data-analyzer.

### Regression

- The HDFS-Core multiturn test
  (`code-analyzer-multiturn.test.ts`) gets a new arm: the second turn
  ("describe HDFS Core" or "do a detailed analysis of HDFS Core")
  must produce a report whose `sections.length === plan.actions.length`
  (no skipped actions). Confirms the per-action loop completes.

---

## Provider config defaults

`config/defaults.json` (or the equivalent default-config layer):

```json
{
  "providers": {
    "code-analyzer": {
      "plan":   { "provider": "active-cloud", "model": "default" },
      "expand": { "provider": "ollama",       "model": "qwen3-coder" },
      "review": { "provider": "active-cloud", "model": "default" }
    },
    "data-analyzer": {
      "plan":   { "provider": "active-cloud", "model": "default" },
      "expand": { "provider": "ollama",       "model": "qwen3-coder" },
      "review": { "provider": "active-cloud", "model": "default" }
    }
  }
}
```

Users can override per-step from the Model Providers pane (existing
config mechanism). A user with no cloud provider configured will get
`plan` and `review` falling back to local — the reviewer will be the
same model as the expander, which is degenerate but matches the
"local-only" mode the user already implicitly accepted by not
configuring cloud.

---

## Migration / backwards compat

This change replaces `queueSinglePassSynthesise` and the
`runMultipassSynthesise` call site with the new three-stage flow.
Behavioural changes from the user's POV:

- Tier S/M now spends cloud tokens (plan + per-action review). For a
  2-action S report this is ~2 plan tokens + 2 review tokens =
  trivial cost; the user gets a real report instead of a
  4000-token-capped single Ollama dump.

- Tier L+ no longer drafts every section in the cloud. Total cloud
  spend per L report drops by 60-70% (rough estimate: 8 sections, each
  previously ~1500 cloud-output tokens; now each is ~300 review tokens
  + small plan share. Local Ollama eats the section drafts).

- Per-action refinement adds latency proportional to refine-rate. A
  100% refine rate doubles the section drafting time. Expected actual
  rate based on brainstorm-style observations: 15-25%.

- Existing checkpoints from older runs still resume via
  `runMultipassSynthesise` (kept as the legacy resume path). New runs
  always go through the new flow; old in-flight checkpoints don't
  retroactively switch.

---

## Sequencing recommendation

The phases are sequential — each one needs the previous helper to
land. Suggested order:

1. **Phase 1** (plan helper) — 2 days; structured JSON pass with
   schema validation, parallels `generateOutline`. Independently
   testable with stubbed cloud provider.
2. **Phase 2** (expand helper) — 1 day; thin wrapper over `complete()`
   with prompt assembly + truncation flag.
3. **Phase 3** (review helper + loop driver) — 2 days; structured
   JSON output + the 2-round refinement loop. Independently testable.
4. **Phase 4** (orchestrator swap for code-analyzer) — 2 days;
   removes the tier fork, plumbs three providers, adds streaming.
5. **Phase 5** (data-analyzer parity) — 1 day; mechanical mirror of
   Phase 4.
6. **Phase 6** (streaming polish) — folded into Phase 4/5.
7. **Phase 7** (regression suite) — 2 days; locks in the contract.

Total estimate: 9-10 days of focused work.

---

## Open questions

1. **Should `expandThenReview` run actions in parallel?** Brainstorm
   does NOT — it's sequential because each round depends on prior
   rounds. Our per-action loops are independent, so parallel is
   tempting (1 plan call + N×2 LLM calls per action, all parallelised
   via Promise.all). Trade-off: parallel hammers both providers; the
   chat panel's progress bubbles get noisy. **Recommendation:** start
   sequential (matches brainstorm's narrative); add `parallel: true`
   opt-in once the flow is stable.

2. **Should the planner see prior-turn context?** Phase 4 of
   conversation-flow-refinement landed `priorContext.facts` for the
   meta-skills pipeline. The plan stage should benefit too — e.g.
   "the previous report covered HDFS Core's modules; this turn asks
   for a deep-dive, so expand into substructure." Add
   `priorContextSummary` to `PlanActionsInput` (already in the
   interface above) and thread it from the orchestrator.

3. **Should `review` have access to prior actions in the same plan?**
   E.g. when reviewing "module-detail-hdfs", does the reviewer want
   to see the already-accepted "module-overview" so it can flag
   redundancy? **Recommendation:** no for v1 — keeps the reviewer
   prompt small and the per-action loops independent. Cross-section
   redundancy can be a Phase 8 follow-up.

4. **Token cost ceiling.** Should the orchestrator hard-stop when
   total cloud tokens spent on plan + reviews exceed a budget? Phase
   4 of conversation-flow-refinement set up artifact-spill budgets;
   reuse the same accounting? **Recommendation:** track and log for
   v1; gate in v2 if real users hit the ceiling.

---

## Cross-references

- `plans/conversation-flow-refinement.md` — Phase 4 wired prior-context
  facts into the meta-skills pipeline; Phase 4.5 of THIS plan would
  thread the same facts into the planner's prompt.
- `plans/analyzers/code-analyzer.md` — original analyzer design; this
  plan replaces section 5.C (multi-pass synthesis).
- `plans/brainstorm/*` — reference architecture for the
  decomposition+per-action pattern.
- `src/insrc/agent/tasks/brainstorm/` — implementation of the
  reference architecture.
- `src/insrc/agent/content-gen/index.ts:generateMultiPass` — the
  current single-provider multi-pass entry; this plan keeps it as a
  legacy path until we're confident the new flow is stable.
