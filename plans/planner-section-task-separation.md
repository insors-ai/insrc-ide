# Planner / Section / Task -- separation of concerns

**Status:** draft, in active design (2026-06-04)
**Owner:** subhagho@gmail.com
**Standing rule:** **a `Task` is a contextless execution unit. A `TODO` is a contextual unit of investigation that typically maps to one section. The investigation plan is a flat list of TODOs. Each TODO has its own task graph, working memory, review loop, and section output. Final report generation reads the working memory; it does not re-execute tasks.**

**Hold:** the user is running tests on the working-memory shape + content before we settle the open questions below. **Do not start implementation until the Qs are resolved.**

## Why

The P6 cutover (tree planner + executor) replaced the old flat
`PlannedAction[]` model with a typed skill tree. The intent was right --
make cross-domain alignment a structured, citable artifact instead of
drafter-invented prose. The implementation was wrong: we made
**one tree the whole report**.

Live INGRN test result: the planner emitted a single composition with
three leaves (sample-shape -> extract-fields -> compare), only the
last node had `emit: section`. The report came back as ONE section
showing the alignment table in raw JSON, missing data-inventory,
class definition, type compatibility, validator coverage, gaps,
recommendations -- everything the old flat planner used to produce.

Root cause: we conflated three layers.

1. **Investigation plan** -- "what TODOs (≈sections) does this report
   need?" The OUTER abstraction. Flat list.
2. **Section synthesis** -- HOW each TODO's evidence is gathered,
   reviewed, and turned into section markdown. Lives per-TODO.
3. **Task** -- the execution unit. Generic. Carries no section or
   TODO identity. The orchestrator schedules tasks; tasks know
   nothing about sections or reports.

The post-P6 tree planner emits **one tree per report** with sections
sprinkled inside it. That collapses (1) and (2): the structural
composition for ONE section ate the entire planning surface.

The fix: separate the three layers. Drive sections at the report
level; let each section run its own task graph + memory + review
loop independently.

## The flow

```
─────────────────────────────────────────────────────────────────────
 STEP 1: SCOPE
─────────────────────────────────────────────────────────────────────
   LLM call -> { scope: S|M|L|XL, subtype, contextHints }
   (essentially today's classify/scope.ts, possibly enriched
    with bootstrap-discovery output -- see Q4)

─────────────────────────────────────────────────────────────────────
 STEP 2: INVESTIGATION PLAN
─────────────────────────────────────────────────────────────────────
   LLM call -> { intentBrief, todos: TODO[] }
                  ↑ FLAT LIST; each TODO ≈ one section in the report
   TODO = { id, title, objective, reviewCriteria? }

─────────────────────────────────────────────────────────────────────
 STEP 3: PER-TODO ITERATION (sequential)
─────────────────────────────────────────────────────────────────────
   for each todo in todos:

     ┌─ memory.read(todo) -> build per-iteration memory context
     │   from the local working memory file (summary + detail
     │   entries from prior TODOs in this report)
     │
     ├─ Section planner -> emits a TASK GRAPH for this TODO
     │   LLM is instructed to produce proper nesting
     │   (multi-root and / or multi-branch -- see Q3)
     │
     ├─ Execute task graph
     │     for each root node in graph:
     │         execute all branches under that root
     │         ─ REVIEW with LLM
     │             may suggest FOLLOWUP TASK TREE
     │               → execute followup
     │               → REVIEW again
     │             cap to 3 cycles per root
     │         ─ generate findings → memory.append(todo, findings)
     │
     ├─ Section writer -> LLM writes section markdown from
     │   findings + memory context
     │
     ├─ REVIEW section output with LLM
     │   incorporate feedback (revision loop -- see Q5)
     │
     └─ memory.write(todo, { summary, detail, sectionMarkdown })

─────────────────────────────────────────────────────────────────────
 STEP 4: FINAL REPORT
─────────────────────────────────────────────────────────────────────
   Read full memory file (intentBrief + every TODO's summary +
                          detail + sectionMarkdown)
   Generate report (stitch + intro + conclusion, LLM-mediated)
   Review report with LLM
   Incorporate feedback
   Final review (sanity pass)
```

## Vocabulary (locked)

| Term | Meaning | Lifetime |
|---|---|---|
| **Scope** | size + subtype + context hints for the run | per-run, immutable after Step 1 |
| **Investigation plan** | the flat list of TODOs | per-run, immutable after Step 2 |
| **TODO** | one unit of investigation; typically one section | per-run |
| **Task graph** | the DAG/tree of executable units the section planner emits for ONE TODO | per-TODO iteration |
| **Task** | one contextless execution unit (skill call, LLM call, tool, ...) | scheduled by the orchestrator; reused across TODOs without state leakage |
| **Findings** | structured output of executing one root node of a task graph | written to memory per root |
| **Working memory** | local per-run file with summary + detail per TODO | persists across iterations within a run |
| **Section** | one rendered chunk of report markdown | written to memory per TODO |
| **Final report** | the stitched + LLM-reviewed output | one per run |

## Open questions

**All resolved 2026-06-04.** Phases P1-P6 are now unblocked; see
the Phases section below.

- Q1 RESOLVED (offline experiment locks the L1-L5 shape +
  lifetime + prompt rendering).
- Q1.1 RESOLVED in principle (incremental vs full shaping
  strategy; thresholds tuned in P1).
- Q2 RESOLVED (keep `PlannedTree`; fix the planner prompt +
  add a degenerate-shape validator rule).
- Q3 RESOLVED (Option B: multi-root via top-level composition;
  per-root sequential review with cap-3 followup).
- Q4 RESOLVED (delete bootstrap; new Step 1+2 covers the use
  case; clean up state-key constants).
- Q5 RESOLVED (bounded loop cap 3; three-verdict structured
  output with revise-major escape to orchestrator).
- Q6 RESOLVED (followup = small extension under root; scoped
  context; cap = 3 followup-execute+review cycles; hint
  mutation allowed).
- Q7 RESOLVED (cap 2 review cycles; whole-report rewrite; one
  revise-structural per report with bounded payload).
- Q8 RESOLVED (two-level TodoList visibility; TODOs +
  reviewable-root sub-items; followups in status text;
  escalations as notes; report-review TODOs flagged with
  origin).
- Q9 RESOLVED (per-TODO atomic for v1; restart-resume via
  currentTodoIndex; partial-report on unrecoverable failure;
  per-root upgrade path documented).
- Q10 RESOLVED (rip-and-replace at cutover; L2 fallback per
  TODO; dormant-modules-then-flip shipping for one-click
  revert).

### Q1 -- Working memory: shape, lifetime, and how the LLM consumes it

Smallest decision surface, biggest blast radius. Sub-questions:

- **Schema.** Per-TODO entry with `{ summary, detail }` -- yes, but:
  - Is `summary` an LLM-generated TL;DR of `detail`, or are both
    written by the LLM at the findings step?
  - Where does the section markdown live -- inside the memory entry
    or in a separate slot?
  - Where do findings (per root-node verdicts) live vs the
    aggregated section output?
- **Lifetime.**
  - One file per report run (ephemeral, deleted when the report
    completes)?
  - Persisted across sessions for the same workspace (so a
    follow-up `/data-analyze` next week can read prior reports'
    memory)?
  - Crash recovery: does mid-section state survive a daemon
    restart?
- **Prompt rendering.** When TODO N reads the memory, what does it
  see?
  - All prior TODOs in full?
  - Just the `summary` slots?
  - LLM-summarized-on-demand for the active TODO's objective?
- **Reuse.** Does this hook into the L2 substrate's
  `SubstrateMemory` (namespaces, TTL, pin/distill), or is it a new
  lighter per-report scratchpad?

**Status: RESOLVED on 2026-06-04 via offline experiment
(`scripts/test-memory-shape.ts` + outputs in
`/tmp/insrc-memory-experiment/qwen36-*`).**

**Finding: a local LLM CAN fill the L1-L5 memory shape from an
accumulated working-memory file, given the right call shape.**

Empirical results across 16 runs (12 GRN single-call + 4 Hadoop
chunked):
- Model: `qwen3.6:35b-a3b` (MoE A3B, ~3B active per token)
- 0 parse failures, 0 cap violations across all 16 runs
- GRN (13.5k mem, 32k numCtx, single-call): 22-51s per run,
  bit-identical determinism across trials (t1=t2=t3 token counts)
- Hadoop (82k mem, chunked 8 chunks): 2.5-5 min per run; all 5
  layers populated including `recent` and `semantic`
- Bundle quality verified: concrete class-name citations from
  source memory, no hallucinated content, prompt-relevant
  `semantic` field across continuation/drill-down/cross-reference/
  off-topic prompt kinds

**Decisions for the working-memory module (P1 input):**

- **Schema** -- per-TODO entry holds raw `detail` (markdown report
  text). The L1-L5 shape is NOT stored; it is **synthesized
  on-demand** at the start of each TODO iteration from the
  accumulated raw memory. No need for the LLM to write both
  `summary` and `detail` -- one structured artifact per TODO.
- **Section markdown** lives inside the TODO's `detail` slot; it
  IS the per-TODO report contribution.
- **Findings** (per root-node verdicts) live as a sibling slot on
  the TODO entry, not interleaved with the section markdown.

- **Lifetime** -- one working-memory directory per report run,
  ephemeral by default. Persisted only if the report completes
  successfully (keeps it for follow-up turns in the same session).
  Crash recovery: TODO-level atomic write of the entry on each
  iteration; mid-iteration crash loses only the in-flight TODO.

- **Prompt rendering** -- the orchestrator runs the
  shape-the-memory step before each TODO iteration:
  - If accumulated memory tokens <= `numCtx - response_budget -
    1500 (scaffold)`, single-call shape into L1-L5
  - Else, map-reduce chunked path with turn/TODO-boundary chunking
  - Result: an L1-L5 bundle the TODO planner consumes as its
    context input
  - **Hard pre-conditions for the local shaping call:**
    1. `think: false` field on Ollama request body (qwen3.x
       families) -- the `/no_think` prompt prefix is a no-op on
       qwen3.6
    2. Trailing schema position in the user prompt (per
       `feedback_prompt_structure` memory)
    3. `format: 'json'` to enforce parseable output
    4. Chunk on entry-file boundaries; sub-split entries that
       exceed `numCtx - 4000` tokens

- **Reuse vs new module** -- new lightweight per-report
  scratchpad. SubstrateMemory (L2) is overkill: we don't need
  pin/distill/TTL semantics; the working memory has a single
  read-and-shape consumer per TODO iteration.

Open follow-ups that DO NOT block Q1 closure:
- whether to bypass the project `OllamaProvider` or extend it
  with `disableThinking` in `CompletionOpts` (see auto-memory
  `qwen3_6_needs_think_false`). Decide during P1 implementation.
- map-reduce performance can be improved later via per-turn
  pre-summarization at write time; not required for v1.

### Q1.1 -- Incremental vs full memory shaping (cost control)

**Why this is its own decision.** Q1 proved the shape can be
built; this question is *how often* and *how much* of it we
rebuild per TODO. Naive answer (re-shape from scratch every TODO)
makes shaping the dominant cost of a multi-TODO report: at 3-5 min
per Hadoop-sized shaping run × 10 TODOs that's 30-50 min of pure
context-prep before any actual planning runs.

**Per-layer cost asymmetry (the lever to exploit):**

| Layer | Stability | Update strategy | Cost / TODO |
|---|---|---|---|
| `system` | Evergreen | Build once at report start; reuse for every TODO. | 1x per report (~5s) |
| `summary` | Append-mostly | Incremental: `prior_summary + new_TODO_findings -> new TL;DR` (small LLM call). | ~5-10s |
| `recent` | Tail-only | Deterministic slice of last K TODO findings + light LLM polish. | ~5s |
| `semantic` | Prompt-keyed | Expensive: relevance signal changes with every prompt. Rebuild required unless mitigated. | 30s-5min |
| `code` | Append-only | Concatenate new code artifacts; cap-truncate only if over budget. | <1s |

The `semantic` layer is the dominant cost because every TODO has
a different prompt and relevance is prompt-conditioned. Two
mitigations to design in:

1. **Per-TODO semantic-bullet cache (prompt-agnostic).** At the
   END of each TODO, write 5-10 prompt-agnostic "key facts" from
   its findings (~5s, one shot, runs as part of TODO cleanup).
   At the next TODO's shaping step, embed the new prompt and
   ANN-retrieve top-K bullets from the cache -- this seeds the
   new `semantic` layer with a light polish call instead of a
   full chunked reduce over all memory.

2. **Reuse-when-prompt-similar.** `resolveIntent` already
   classifies prompt relationships (`CONTINUATION`, `DRILL_DOWN`,
   `FOLLOWUP`, `RESPONSE_TO`, `NEW`, `TANGENT`, `COMPARE_WITH`,
   `CORRECTION`). For `CONTINUATION` and `DRILL_DOWN` against the
   immediately-prior TODO, reuse prior `semantic` and delta-add
   from the just-completed TODO's findings. Only do a fresh
   rebuild on `NEW`, `TANGENT`, `COMPARE_WITH`, and `CORRECTION`.

**Trigger rules:**

- **Hot path (default).** Incremental per-layer update on each
  TODO transition. Total per-TODO shaping budget ~10-30s when
  semantic-cache hits; ~1 min if semantic must be re-derived from
  scratch but memory is small (single-call regime).
- **Cold rebuild triggers (force full re-shape):**
  - Report start (no memory yet -- trivially full)
  - Memory growth > 50% since last cold rebuild (drift catch:
    incremental updates compound staleness in `system` / `summary`)
  - Orchestrator review-step flags inconsistency between `recent`
    and `summary` (signal that incremental drift has corrupted
    coherence)
  - User-initiated rebuild (e.g. `/replan`, force flag on
    re-entry)

**Open sub-decisions (not blocking; resolve during P1):**

- Where the semantic-bullet cache lives (LanceDB
  `working_memory_bullets` table vs in-memory per-run array vs
  per-TODO file). LanceDB gives ANN for free; in-memory is simpler
  but lost on crash; file-based is crash-safe but needs its own
  index.
- Exact thresholds: 50% growth, K=top-5/10/15 bullets,
  semantic-rebuild policy for `FOLLOWUP` (treat as continuation or
  rebuild?). Tune empirically during P1 once we have an
  end-to-end pipeline.
- Whether `recent` needs an LLM polish step at all, or whether
  deterministic concatenation of the last K TODO findings'
  prompt-agnostic summary fields is sufficient.

**Status: RESOLVED in principle on 2026-06-04. Concrete thresholds
+ cache backing store deferred to P1.**

### Q2 -- Task graph or task tree?

Today's `PlannedTree` is a strict tree: forward refs banned, wires
only to ancestors / earlier-siblings, no diamond shapes (a node
consumed by two parents is impossible).

- If we want a true DAG (one node consumed by multiple downstream
  consumers, useful when one discovery feeds two analysis branches):
  - validator must allow shared nodes
  - executor must topologically sort instead of depth-first walk
  - cycle detection at planning time
- If we want tree-with-richer-nesting (the live test's
  single-branch failure was a *prompt* problem, not a type-system
  one):
  - keep `PlannedTree` as-is
  - fix the planner prompt + worked example to demonstrate multi-root
    / multi-branch shapes

**Status: RESOLVED 2026-06-04. Keep `PlannedTree` as-is for
section-level planning; treat the live-test single-branch failure
as the prompt/example problem it actually is.**

**Rationale.** `PlannedNode.inputs` already supports
`{ source: 'node', nodeId, path }` -- any node can read any other
node's output by id. So data-flow DAG is already expressible
inside the tree topology; what tree-vs-DAG actually constrains is
execution order (depth-first parent-then-children) and the
structural rule "one parent per node." Promoting to a full DAG
buys almost nothing the `node`-binding doesn't already provide,
while it costs: cycle detection at plan time, topo-sort executor,
a harder-to-author recursive schema for the LLM (DAG schemas trip
up structured-output guards), and a more complex "root-node
review" rule (no clean roots in a DAG).

Crucially, the orchestrator's review pattern -- "for each root
node in the graph once all the branches have been executed,
review the output with the LLM" -- specifically depends on having
well-defined roots, which trees give you and DAGs don't.

**Decisions for the section-level planner (P-Sec input):**

- Keep `PlannedTree` shape unchanged. Section planner returns one
  `PlannedTree` per TODO. The tree has multi-root structure via
  the existing root-composition node (the LLM emits a top-level
  `composition` node with multiple `children`).
- Cross-branch reads stay on `inputs.{nodeId, path}`. Don't
  introduce a separate `reads:` field.
- Add validator rule: reject "degenerate" plans -- single-chain
  with zero siblings AND depth > 2 AND fewer than N total leaves
  (catch the live-test failure mode at plan time, route to one
  corrective retry).
- Fix the planner prompt + worked example to demonstrate
  multi-root / multi-branch shapes (this is the primary lever;
  the validator rule is a backstop). Details in Q3.

**Promote-to-DAG escape hatch.** If implementation surfaces a
concrete pattern where the tree topology + node-binding genuinely
can't express what we need, escalate via a new sub-question.
Don't pre-engineer the DAG.

### Q3 -- "Proper nesting" -- what shape does the section planner emit?

The live test produced `root → A → B → C` (single linear branch, one
emit:section terminal). User said the LLM failed to produce proper
nesting. Concrete shapes the planner could emit for ONE TODO (the
INGRN field-mapping TODO as the worked example):

- **Option A**: one root with multiple sibling branches; each branch
  is a leaf chain ending at a synthesizer
  ```
  root
   ├─ data-shape    (leaf)
   ├─ class-fields  (leaf)
   └─ compare       (leaf, consumes both)
  ```

- **Option B**: multiple roots, each independently reviewable
  ```
  root-discover (composition)
   ├─ data-shape
   └─ class-fields
  root-analyze (composition)
   └─ compare (consumes both)
  ```
  Each root gets its own review cycle (so two reviews, each with up
  to 3 followup cycles).

- **Option C**: depth-driven -- discovery sub-tree feeds an analysis
  sub-tree feeds synthesis at the top
  ```
  synthesize
   └─ analyze
       └─ discover (composition of two leaves)
  ```

The "per-root-node review" loop changes meaning per option. Need to
pick one as the canonical shape the prompt teaches.

**Status: RESOLVED 2026-06-04. Option B
(multi-root-via-top-level-composition).**

**Rationale.** Only Option B satisfies the orchestrator flow the
user specified: per-root review with optional followup cycle (cap
3 per root). Option A has one all-or-nothing review at the end;
Option C is structurally what the live test failure produced and
has zero per-component review.

**Encoding within the existing `PlannedTree` single-root
constraint.** The tree's `root: PlannedNode` is always a
`composition` node (`composition: 'sequence'` by default). Its
direct children are the "reviewable roots" the orchestrator
iterates over. Concrete shape the planner prompt teaches:

```
root (composition, sequence)
 ├─ discover    (composition, REVIEWABLE root #1, emit: finding)
 │   ├─ data-shape    (leaf)
 │   └─ class-fields  (leaf)
 ├─ analyze     (composition, REVIEWABLE root #2, emit: finding)
 │   └─ compare       (leaf; inputs.X reads discover.data-shape,
 │                            inputs.Y reads discover.class-fields)
 └─ synthesize  (composition, REVIEWABLE root #3, emit: section)
     └─ write-section (leaf; consumes analyze.compare)
```

**Execution semantics (per "no parallel LLM calls" rule):**
strictly sequential -- root #1 execute -> review -> maybe followup
(<=3 cycles) -> root #2 execute -> review -> ... -> final
section emit. analyze cannot start until discover's review pass
clears, because analyze reads from discover's outputs and a
followup cycle on discover might re-emit those outputs.

**Followup-cycle policy (resolved sub-question):**
Followup tasks are emitted only when the review verdict is
`incomplete` / `needs-followup`. A clean `accept` verdict
short-circuits to the next root. "Cap 3 cycles" is the per-root
upper bound on incomplete-review retries, NOT a baseline budget
spent on every root. Concretely:

  review -> accept   -> proceed to next root
  review -> followup -> execute followup -> review again
                        (cap 3 followup cycles per root; after
                         cap, force-accept with a "review
                         exhausted" annotation in the findings)
  review -> reject   -> fail the TODO with a structured error
                        (escalates to the TODO-level orchestrator)

**Decisions for the section-level planner prompt (P-Sec input):**

- Worked example demonstrates a 3-root top-level composition with
  2-3 levels of nesting per root. Not the 3-leaf single-branch
  example currently shipping.
- System prompt explicitly names the rule: "the top-level node
  MUST be a composition; each direct child is a reviewable root;
  prefer 2-5 reviewable roots covering discover / analyze /
  synthesize phases."
- Validator rule (the backstop from Q2): reject single-leaf-at-
  top-level or single-child top-level composition; emit a
  corrective-retry signal listing what's missing (e.g. "expected
  >=2 reviewable roots, got 1").
- `emit: section` is permitted ONLY on the final reviewable root
  (synthesize). Earlier roots use `emit: finding` so their
  outputs flow into working memory but don't compose the final
  section.

### Q4 -- Bootstrap pipeline disposition

Today `afterSkillsRoutingBootstrap` runs classify-question +
select-scope + 3 file dispatches *before* any planning happens.
Results land in `K_ACCEPTED` / `K_HISTORY` / `K_RAW_EXECUTIONS` --
which nothing in the new path reads.

- (a) **Pipe its discoveries into Step 1's scope context** so the
      investigation planner sees the actual data shape.
- (b) **Delete it.** Let the per-TODO section planner discover what
      it needs.

Recommendation: (b). Cleaner separation; bootstrap was a
pre-tree-planner crutch.

**Status: RESOLVED 2026-06-04. Delete `afterSkillsRoutingBootstrap`.**

**Rationale.** Three reasons the bootstrap must go:
1. `classify-question` is already covered by the
   `resolveIntent` single-funnel (per auto-memory
   `intent_classification_single_funnel`). Keeping a second
   classification path inside the orchestrator violates the
   funnel rule and risks drift between the two classifiers.
2. `select-scope` belongs in the new flow's **Step 1 (Scope)**,
   where the LLM decides scope WITH its planning context. Doing
   it twice is wasted compute.
3. The skills-pipeline results (`K_ACCEPTED` / `K_HISTORY` /
   `K_RAW_EXECUTIONS`) feed only the legacy synthesize step,
   which the tree planner already bypasses. ~11s of orphan
   compute per report.

**The fast-path tradeoff (explicit).** The bootstrap was
originally designed as a deterministic short-circuit for trivial
single-skill queries ("show me last week's sales") -- skip the
planner, run the skill, return. Deleting it adds one extra LLM
call to Step 1 (Scope) for those queries. Acceptable: ~5s
overhead vs the ~3 min total report cost, and the new flow's
Step 2 handles single-shot queries cleanly by emitting a
single-TODO plan with a single-leaf section tree.

**Decisions for P4 / migration:**

- Delete the `afterSkillsRoutingBootstrap` method on
  `data-analyzer-orchestrator.ts` (and the `case 'planning'` /
  legacy-fallback branches that route to it).
- Delete the state-key constants
  `K_ACCEPTED` / `K_HISTORY` / `K_RAW_EXECUTIONS` and remove
  their reads/writes. Don't leave dead state behind -- it
  encourages drift.
- Keep `runSkillsPipeline` itself (still used by
  `code-analyzer-orchestrator`). Only the bootstrap caller goes.
- New flow's Step 1 (Scope) is the sole entrypoint to the
  orchestrator. Step 2 (Investigation Plan) decides whether a
  single-TODO single-leaf plan is appropriate for fast-path
  queries.
- Resumable-session concern: no migration window required (no
  long-running in-flight reports at land time). If a session was
  mid-bootstrap when the rollout happens, treat it as cancelled
  and surface a one-line note in the report.

### Q5 -- Section review revision loop

The flow says "REVIEW section output with LLM, incorporate feedback."
Is that:
- One-shot (LLM reviews, returns edits, we apply, done)?
- Loop (review → revise → re-review until accept, capped at N cycles)?

If a loop, what's the cap? Reusing the 3-cycle cap from the per-root
review keeps the rule simple.

**Status: RESOLVED 2026-06-04. Bounded loop, cap 3, three-verdict
structured output with an escape hatch for structural failures.**

**Distinction from per-root review (Q3).** Per-root review catches
investigation gaps ("is the evidence for this branch complete?").
Section review catches presentation/coherence ("does the assembled
markdown read well, cover the TODO objective, cite findings
correctly?"). Both loops exist; they review different artifacts.

**Verdict structure (the review LLM must return one of three):**

```
review -> accept            -> save section to working memory, done
       -> revise-edits      -> LLM rewrites section, re-review
          (cap 3 cycles)       (counts toward the per-section cap)
       -> revise-major      -> ESCALATE to TODO orchestrator
                               (re-opens the section task tree;
                                does NOT consume a cycle of this loop)
```

**Why three verdicts, not two.**
- A plain "loop until accept or cap" treats "needs another
  sentence in the intro" and "the investigation missed half the
  question" as the same signal. Both eat cycles; only one is
  fixable by section regeneration.
- `revise-major` routes structural failures back to the TODO
  orchestrator, which can re-open the section task tree and add
  followup roots. Without this escape hatch, the loop churns on
  assembly that can't fix missing findings.
- `revise-edits` is the happy path -- most well-executed sections
  clear in 1 cycle.

**Cost ceiling per section:**
- Typical: 1 generation + 1 review (accept) = 2 calls.
- Worst case (cap 3): 1 generation + 3 x (1 review + 1 revise) =
  7 calls. After cap, force-accept with a "section review
  exhausted" annotation in the saved memory entry, so the final
  report-level review (Q7) can decide whether to escalate.
- `revise-major` adds the cost of re-opening the section task
  tree (one section planner call + per-root execution + per-root
  review). Worth the cost when the alternative is shipping an
  unfixable section.

**Decisions for the section orchestrator (P-Sec input):**

- Section review prompt MUST require the verdict enum in its
  structured output: `verdict: "accept" | "revise-edits" |
  "revise-major"`.
- `revise-edits` carries an `edits: string` field (natural-
  language description of what to change). The revise step
  re-renders the section with the previous section + the edits
  description.
- `revise-major` carries a `reason: string` and an optional
  `followup-roots: PlannedNode[]` suggestion. The orchestrator
  treats the latter as a hint, not a binding instruction; the
  section planner re-validates.
- The 3-cycle cap is per-section, distinct from the per-root
  3-cycle cap. A worst-case TODO with N=3 roots could in theory
  consume `3 (per-root) x N (roots) + 3 (per-section)` = 12
  review cycles. Acceptable upper bound; emit a metric so we can
  tune later if reports drift toward the cap.

### Q6 -- Followup task tree shape

When the per-root reviewer says "you need more evidence here," it
returns a **followup task tree**. Constraints:

- Is the followup a fresh task graph (could itself have multiple
  roots), or always a small extension under the existing root (a
  single new branch)?
- Does the followup see the current root's findings, or only the
  reviewer's hint?
- Does the 3-cycle cap count followup cycles only, or any review
  cycle including the initial one?

**Status: RESOLVED 2026-06-04.**

**Sub-Q6a -- Shape: small extension, not fresh task graph.**

The followup is one composition node with 1-3 leaf children,
appended under the existing reviewable root. Not a fresh
top-level task tree. If the gap genuinely needs structural
reorganization, the reviewer returns `revise-major` (per Q5)
and escalates to the orchestrator for a fresh sub-tree. This
keeps the followup mechanism narrow and prevents the
orchestrator from needing recursion-into-followup-roots logic.

**Sub-Q6b -- Context: reviewer hint + current root's findings +
TODO objective. Nothing else.**

Explicitly INCLUDED in the followup's prompt:
- the reviewer's hint (what gap to close)
- the current root's findings (so it doesn't re-discover known facts)
- the TODO objective (so it stays scoped)

Explicitly NOT included:
- other roots' findings in the same TODO (independent
  investigations; coupling invites scope creep)
- full working memory (the per-TODO memory bundle already covers
  cross-TODO context upstream, when the section planner runs)

Followup findings AUGMENT the root's findings -- they go in the
same slot, not a separate one. The reviewer's next pass sees the
merged set.

**Sub-Q6c -- Cycle counting: 3 followup-execute+review cycles
after the initial review.**

One cycle = one (followup-execute + re-review) pair, per the
user's flow sketch. Concretely:

```
review root execution                              (initial -- not a cycle)
 +- accept   -> done
 +- followup -> execute followup -> re-review      (cycle 1)
                 +- accept   -> done
                 +- followup -> execute -> re-review (cycle 2)
                                  ... (cycle 3 same pattern)
                                  at cap, force-accept with
                                  `review-exhausted` annotation
                                  in the findings
```

Up to **4 total reviews per root** in the absolute worst case
(1 initial + 3 followup re-reviews). The `review-exhausted`
annotation lets the section-review (Q5) detect under-evidenced
sections downstream.

**Sub-Q6d -- Hint mutation between cycles: ALLOWED.**

The reviewer may emit a different hint in cycle N than it did in
cycle N-1 (e.g., "need table Y schema" in cycle 1, then "now need
table Z schema" in cycle 2 after seeing Y). The cap is the
protection against runaway investigation; forbidding mutation
would force the reviewer to dump everything into the first hint
or escalate to `revise-major`. Letting hints evolve is cheaper
and more honest about what reviewers actually need to do.

**Decisions for the orchestrator / reviewer prompts (P-Sec input):**

- Reviewer's structured output schema includes:
  `verdict: "accept" | "followup" | "revise-major"`,
  `followup?: { hint: string; suggested_leaves?: PlannedNode[] }`.
- `suggested_leaves` is advisory; the planner re-validates the
  proposed composition node against PlannedTree constraints
  before execution.
- Findings carry a `cycles_consumed: number` and an
  `exhausted: boolean` flag so downstream consumers (section
  review, final report review) can detect the cap-hit path.
- A `revise-major` from per-root review re-opens the SECTION task
  tree (re-plans new roots), distinct from `revise-major` at
  section review (Q5) which re-opens the TODO orchestrator.
  Document this distinction in the orchestrator prompt to prevent
  the LLM from emitting the wrong escape signal.

### Q7 -- Final report review loop

Step 4 says "review report with LLM, incorporate feedback, final
review."

- "Incorporate feedback" -- LLM rewrites the report, or human-style
  diff/patch application?
- "Final review" -- the LLM's second pass after incorporating, or a
  sanity-check that returns a verdict only?
- Loop or one-shot? Cap?

**Status: RESOLVED 2026-06-04. Cap 2 review cycles; whole-report
LLM rewrite for revise-edits; one revise-structural permitted per
report.**

**Distinction from section review (Q5).** Section review's escape
hatch (`revise-major`) routes to the TODO orchestrator. The final
review has **no orchestrator level above it** -- structural
problems mean re-opening sections or the investigation plan.
That's expensive, so we cap it tightly.

**Loop shape (matches the user's "review, incorporate feedback,
final review" wording literally):**

```
generate report from working memory
review #1                     verdict:
                                accept | revise-edits | revise-structural
 +- accept            -> ship
 +- revise-edits      -> LLM rewrites whole report -> review #2 (final)
 +- revise-structural -> expensive path: re-run section reviews for
                          contradicting sections OR add 1-2 new TODOs to
                          investigation plan (cap 1 per report)
                          -> re-generate report -> review #2 (final)
review #2 (final)             verdict: same enum as #1
 +- accept                  -> ship
 +- revise-edits or
    revise-structural       -> force-accept with
                               `report-review-exhausted` annotation
                               surfaced as a tail block in the shipped
                               report
```

**Sub-Q7a -- Incorporate feedback: whole-report LLM rewrite, not
diff/patch.**

Structured edit-application is brittle; whole rewrite is simpler.
Most edit-class fixes touch intro / conclusion / transitions
which are short. If section-level patching becomes a real cost
issue post-v1, we can add it as an optimization without changing
the verdict structure.

**Sub-Q7b -- Final review = real iteration, not pure
sanity-check.**

Review #2 returns the same verdict enum as review #1 (so it can
demand changes the first reviewer missed), but its decision
space is terminal -- anything other than `accept` triggers
force-accept-with-annotation rather than another revise cycle.
This gives the final review real teeth without unbounded looping.

**Sub-Q7c -- Loop with cap 2 reviews max, 1 revise in between.**

Tighter than section review's cap 3 because each cycle is more
expensive (whole-report rewrite) and most issues should already
be caught by section-level review. The final review is a safety
net, not a primary quality mechanism.

**Cost ceiling per report:**
- Typical (accept on review #1): 1 review call.
- Revise-edits path: 1 review + 1 rewrite + 1 review = 3 calls.
- Revise-structural path: 1 review + (section re-reviews or
  TODO addition) + 1 rewrite + 1 review = 3 calls + variable
  structural cost.

**Decisions for the report orchestrator (P-Final input):**

- Report reviewer's structured output schema:
  `verdict: "accept" | "revise-edits" | "revise-structural"`,
  `edits?: string`,
  `structural?: { kind: "section-contradiction" | "scope-gap";
                  sections?: string[];
                  proposed_todos?: TodoSpec[] }`.
- `revise-structural` carries one of two payloads:
  - `section-contradiction` with the IDs of conflicting sections
    -> orchestrator re-opens just those sections' review (Q5
    pattern with re-run, NOT new section task tree).
  - `scope-gap` with at most 2 new TODO proposals -> orchestrator
    appends them to the investigation plan, runs them, regenerates
    the report. Hard cap 2 new TODOs per structural-revise; if
    more are proposed, truncate and annotate the rejection.
- The `report-review-exhausted` annotation surfaces in the
  shipped report as a tail "review notes" block so users see
  unresolved concerns rather than silent shipment.

### Q8 -- TodoList integration

Each TODO in the investigation plan is a natural fit for one
TodoList item in the workbench (pending → in-progress while its
task-graph runs → complete on section finalization). Followup task
trees -- visible as sub-items? Or hidden internal compute?

**Status: RESOLVED 2026-06-04. Two-level visibility:
investigation TODOs as items, reviewable-roots as sub-items,
followups hidden in status text, escalations surfaced as notes.**

**Concrete shape the user sees in the workbench:**

```
investigation TODO #1: "Analyze GRN field mappings"   [in-progress]
  +- discover     [complete]
  +- analyze      [in-progress (followup cycle 2/3)]   <- cycle in status text
  +- synthesize   [pending]

investigation TODO #2: "Audit timestamp validation"   [pending]

investigation TODO #3: "Cross-reference tax fields"   [escalated]
  Note: section review returned revise-major -> re-opening section tree

investigation TODO #4: "+ scope gap: missing API surface"   [pending]
  Origin: report review escalation (Q7 revise-structural)
```

**Granularity rationale (per row class):**

- **Investigation TODOs as top items.** Matches the user's
  mental model that each TODO will typically map to one section
  in the output. 1:1 with the investigation plan.
- **Reviewable roots as sub-items.** Reviewable roots
  (discover/analyze/synthesize per Q3) are semantically
  meaningful phases. Without sub-items, a multi-minute TODO
  looks hung -- Hadoop sections take 5+ min and the user needs
  intra-TODO progress signal.
- **Followups hidden as separate items, surfaced in parent
  root's status text** (e.g., `analyze [in-progress (followup
  cycle 2/3)]`). Followups are remediation, not first-class
  work. Exposing them as items invites the user to ask "why did
  this happen?" -- a question they shouldn't have to think
  about. Status text communicates "still working" without
  inviting interrogation.
- **Escalations visible as one-line status notes on the affected
  TODO.** When `revise-major` (Q5) or `revise-structural` (Q7)
  fires, the user SHOULD see that. Silent re-runs make the
  system feel non-deterministic; the note preserves auditability.
- **TODOs added by Q7 revise-structural** appear partway through
  the run as new first-class items, flagged with their origin
  (e.g., a `+ scope gap` prefix or origin badge) so the user
  knows they came from the final review, not the initial plan.

**Wire-up against the existing TodoList types:**

`src/insrc/db/todos.ts` already has `pending` / `in-progress` /
`complete` states. We need to add:

- A `subItems: TodoSubItem[]` field on `TodoItem` (or a sibling
  structure keyed by parent TodoItem id, if subItems would
  pollute the existing schema's downstream consumers).
- A `note?: string` field for the escalation message.
- An `origin?: 'initial' | 'report-review-escalation'` flag
  distinguishing initial-plan TODOs from escalation-added ones.
- Sub-item states match parent states (`pending` /
  `in-progress` / `complete`). Sub-item status text is free-form
  to carry the followup-cycle counter.

**Decisions for P8 (the TodoList integration phase):**

- The orchestrator emits TodoList updates at:
  - Investigation plan land time (top-level items created)
  - Each reviewable-root transition (`pending` ->
    `in-progress` -> `complete`)
  - Followup cycle start / completion (parent root's status
    text updated; NOT a new sub-item)
  - Escalation events (parent TODO gets a `note`)
  - Report-review-escalation TODO additions (new top-level item
    appended with `origin: 'report-review-escalation'`)
- Sub-item updates are NOT individual workbench notifications;
  the TODO-level row updates carry them. This avoids a UI
  storm during long sections.
- Followups are deliberately NOT recorded as sub-items even
  retrospectively (don't show in the post-completion view of a
  TODO). The followup record lives in the findings annotation
  (`cycles_consumed`, `exhausted` from Q6) instead, surfaceable
  via report-level review notes when relevant.

### Q9 -- Crash recovery

Working memory persists; the orchestrator's state machine already
checkpoints. Granularity question:

- Per-TODO atomic? (restart re-runs the current TODO from scratch)
- Per-root-node? (restart resumes from the last completed root in
  the current TODO)
- Per-task? (restart resumes from the last completed leaf)

Tighter granularity = less wasted compute on crash but more
checkpoint storage + more orchestrator state. Recommend per-TODO
atomic for v1; tighten later if a long TODO + restart becomes a
real pain point.

**Status: RESOLVED 2026-06-04. Per-TODO atomic for v1; upgrade
path to per-root documented; restart-resume semantics specified.**

**Cost analysis (the reason v1 stays simple):**

| Granularity | Worst-case crash loss | Implementation cost |
|---|---|---|
| Per-TODO atomic | 5-10 min (whole TODO re-runs) | Trivial -- already at framework step boundary |
| Per-reviewable-root | 1-2 min (current root re-runs) | Modest -- split Step 3 into N steps, one per root |
| Per-task (leaf) | 10-30s | Heavy -- checkpoint mid-followup, complex executor state |

Per-TODO atomic is the right v1 choice because:
- Crashes are rare in this system (daemon is stable; main risk
  is OOM, which the per-Q caps already protect against).
- Re-running is cheap given determinism -- temperature=0 + warm
  KV cache means a re-run of a TODO often takes 50-70% of the
  original time.
- Framework already supports it -- each AgentStep is already an
  atomic checkpoint boundary.
- The upgrade to per-root is mechanical if real users complain.

**Concrete checkpoint semantics:**

- Working memory entries are written atomically per TODO
  completion (never half-written -- aligned with Q1's lifetime
  decision).
- Mid-TODO crash -> restart loses the in-flight TODO's work, all
  prior TODOs preserved.
- Checkpoint structure includes `currentTodoIndex` +
  `completedTodoIds[]`; restart resumes by re-running TODO at
  `currentTodoIndex` from scratch.

**What does NOT need crash-recovery work:**

- In-flight LLM calls (Ollama has no resume protocol; just retry).
- Per-root review state mid-cycle (folded into the per-TODO
  restart).
- Followup cycle counters mid-cycle (followups are remediation;
  re-running the parent root is the right behavior).

**Failure classification at restart:**

- **Recoverable** (process crash / kill / OS restart):
  orchestrator resumes from last completed TODO.
- **Unrecoverable** (schema violation that can't be retried,
  OOM repeat-loop, working-memory corruption): run terminates
  with a structured error, leaves prior TODOs' contributions in
  place, surfaces to the user as a partial report with a
  "terminated early" notice in the tail block.

**Upgrade path to per-root (when/if needed):**

Mechanical change, no breaking semantics:
1. Wrap the existing Step 3 (per-TODO body) as a sub-orchestrator
   that emits a framework step per reviewable root.
2. Each sub-step is a framework step -> automatic checkpoint.
3. Add `currentRootIndex` to the per-TODO state.
4. Working-memory write moves from "TODO complete" to "all roots
   complete" -- same moment, no semantic change.

**Decisions for P9 / orchestrator wiring:**

- `currentTodoIndex` + `completedTodoIds: string[]` on the
  orchestrator state.
- Atomic write of the working-memory TODO entry happens AFTER
  Q5's section-review-accept (or force-accept), before
  advancing the TODO counter.
- If a session is recovered mid-Step-4 (final report review),
  re-run Step 4 from scratch -- the final report assembly is
  cheap relative to TODOs.
- Surface restart events to the chat-stream as a `system` event
  ("resumed at TODO 4/7") so the user knows the run was
  interrupted, even when the partial-report tail-block isn't
  triggered.

### Q10 -- Migration strategy

Same precedent as P6 / P10 / P14: clean rip-and-replace; the L2
fallback (today's `<owner>.answer-question`) provides the per-TODO
safety net (a TODO whose task graph fails reverts to an L2
single-skill invocation for that section).

**Status: RESOLVED 2026-06-04. Rip-and-replace at cutover; L2
fallback per TODO as the runtime safety net; dormant-modules-then-
flip shipping order for one-click rollback.**

**Cutover model: rip-and-replace, no preemptive feature flag.**

Precedent: P6 (tree planner), P10 (intent funnel) -- both
rip-and-replace. Rationale:
- The current path is shipping degraded output (1-section
  reports from the live test).
- Feature flags create dual-maintenance burden, and L2 fallback
  already gives us runtime safety.
- A feature flag is a 5-line addition at cutover time if
  burn-in concerns surface; no need to design for it upfront.

**What gets ripped at cutover:**

- `afterSkillsRoutingBootstrap` + `case 'planning'` route (Q4).
- `K_ACCEPTED` / `K_HISTORY` / `K_RAW_EXECUTIONS` constants and
  all reads/writes (Q4).
- The single-`PlannedTree`-per-report orchestration path (the
  P6 implementation that emitted 1 section).
- The legacy synthesize step that read K_ACCEPTED.

**What's preserved (no churn):**

- `PlannedTree` types and validator (Q2; validator gets the new
  degenerate-shape rule).
- The plan-tree-runner (executes the trees per-root).
- L2 fallback skill (`<owner>.answer-question`) -- promoted from
  default-path-fallback to safety-net-only role.
- Working memory module is new (Q1 designed it as a fresh
  per-report scratchpad, NOT a SubstrateMemory hookup).
- TodoList integration types (Q8 adds fields; doesn't break
  the existing schema).

**Per-TODO L2 safety net (the runtime floor):**

When a TODO's section task tree fails irrecoverably -- defined
as:
- Section planner emits invalid `PlannedTree` after the
  corrective retry (Q2's validator rule).
- Section review (Q5) hits `revise-structural` and the
  orchestrator's re-opened section tree ALSO fails.
- Per-root review (Q6) exhausts `revise-major` escapes that the
  orchestrator can't satisfy.

...the orchestrator falls back to a single L2 `answer-question`
call for that TODO:
- Input: the working-memory bundle + the TODO's objective.
- Output: one section's markdown via one LLM call.
- TODO finding records `fallback: 'L2'`, surfaced in TodoList
  notes (per Q8 escalation visibility).

This is the floor. Quality is degraded (no per-root review, no
investigation depth), but the run **always completes**. A report
that fully falls back is structurally identical to today's P6
output -- we never regress below current behavior.

**Rollback strategy (git revert as the operational rollback):**

Since we delete the old code at cutover, rollback is `git revert`
of the cutover commit. To keep that revert clean:
- All new modules (P1-Pn) land BEFORE the cutover commit,
  dormant (not wired into the orchestrator path).
- The cutover commit is a small single-file change in
  `data-analyzer-orchestrator.ts` that swaps the old call site
  for the new orchestrator entrypoint, plus the deletion of the
  now-orphaned old methods.
- Revert of that single commit restores the old behavior
  immediately (the new modules become dead code, ignored, and
  can be cleaned up in a follow-up commit).

**Shipping order (atomic phases; final cutover is one commit):**

Q1-Q9 are interlinked; the phases below must all land before the
cutover commit, but each is independently testable while dormant.

1. **P1**: Working memory module + shape-the-memory step
   (depends on Q1, Q1.1).
2. **P2**: Step 1 (Scope) + Step 2 (Investigation Plan) steps
   (depends on Q4).
3. **P3**: Section orchestrator + section planner prompt fix +
   section review (Q5) + L2 fallback wiring (depends on P1, Q2,
   Q3, Q5, Q6, Q10).
4. **P4**: Final report assembler + report review (depends on
   P1, P2, P3, Q7).
5. **P5**: Cutover commit -- swap orchestrator entrypoint,
   delete old methods + constants per Q4. Single small commit;
   trivially revertable.
6. **P6**: TodoList integration extensions (Q8). Can land
   alongside P5 or as the immediately-following commit.

## Phases

All phases land DORMANT (not wired into the orchestrator path)
ahead of the cutover commit, per Q10. The cutover commit (P5) is
the single small change that swaps the orchestrator entrypoint
and deletes the old methods -- revert of that commit is the
operational rollback.

### P1 -- Working memory module + shape-the-memory step

**Depends on:** Q1, Q1.1.

**Deliverables:**
- New module under `src/insrc/agent/working-memory/` (lightweight
  per-report scratchpad; NOT a SubstrateMemory hookup).
- Types: `WorkingMemory`, `WorkingMemoryEntry` (one per
  completed TODO, holding `detail: string` markdown +
  `findings: { perRoot, cycles_consumed, exhausted, fallback? }`).
- Atomic on-disk persistence per TODO completion (Q9).
- Shape-the-memory step (`shapeMemory`): given the accumulated
  working-memory dir + the current TODO's objective, returns an
  L1-L5 bundle. Implements both single-call and chunked
  (map-reduce) paths per Q1's `numCtx - response - 1500`
  threshold and turn/entry-boundary chunking.
- Incremental update path per Q1.1: per-layer strategy (`system`
  evergreen pass-through; `summary` incremental LLM call;
  `recent` deterministic slice + light LLM polish (skippable);
  `semantic` incremental LLM call against prior+new+next
  objective; `code` deterministic concat + cap-truncate).
  Cold-rebuild triggers wired (memory growth >= 50%, user
  request, orchestrator-flagged inconsistency, first-TODO).
- Provider plumbing: extend `OllamaProvider` CompletionOpts with
  `disableThinking?: boolean` (per auto-memory
  `qwen3_6_needs_think_false`), un-gated from tool presence.
  Memory-shape calls pass `disableThinking: true`.

**Delivered in P1.e:**
- Per-TODO semantic-bullet cache (LanceDB table
  `working_memory_bullets`). 5-10 prompt-agnostic facts per
  completed TODO, embedded via the local Ollama embedding model,
  ANN-retrieved at the next shaping step. Cache scope is per-
  report-run; orchestrator owns lifecycle (delete on run
  completion / failure).
- `extractBullets()` LLM call (prompt-agnostic key facts
  extraction; clamped 5-10 bullets per TODO; degrades to []
  on parse failure rather than failing the TODO transition).
- `BulletCache` interface on `IncrementalUpdateOpts`. When set
  AND `provider.embed()` returns a non-empty vector, the
  updater queries the cache instead of running the LLM-based
  `updateSemantic`. Cloud providers (which return [] from
  `embed()` per CLAUDE.md) fall back to the LLM path silently.

**Acceptance:**
- Unit tests for chunked path on a Hadoop-sized fixture (parity
  with `scripts/test-memory-shape.ts` output: 8 chunks, all 5
  layers populated, no parse failures).
- Per-layer incremental update preserves bundle quality across 5
  simulated TODO completions on a GRN-sized fixture.
- Cold-rebuild trigger fires at 50% growth threshold; verify via
  unit test.

### P2 -- Step 1 (Scope) + Step 2 (Investigation Plan)

**Depends on:** Q4 (Step 1 absorbs the deleted bootstrap's
scope detection).

**Deliverables:**
- Step 1 `scopeStep`: LLM call that produces
  `{ scope, contextRefs[] }`. Replaces the bootstrap's
  `select-scope` work. Routes intent through `resolveIntent`
  (single funnel).
- Step 2 `investigationPlanStep`: LLM call that produces a flat
  `TODOSpec[]`. Each TODO has `id`, `objective`, optional
  `origin: 'initial'`. Validator rule: 1-12 TODOs; reject
  duplicates by objective similarity.
- Single-shot escape: if Step 1 marks the request as trivial,
  Step 2 emits a single-TODO plan with a single-leaf section
  hint (per Q4 fast-path tradeoff).

**Acceptance:**
- Unit tests: simple data-analyzer questions yield 1-3 TODOs;
  the Hadoop comprehensive question yields 5-8 TODOs.
- The single-shot path completes in under 30s for a trivial
  query (no per-TODO overhead beyond the L2-equivalent call).

### P3 -- Section orchestrator (per-TODO body)

**Depends on:** P1, Q2, Q3, Q5, Q6, Q10.

**Deliverables:**
- `sectionPlannerStep`: per-TODO LLM call producing a
  `PlannedTree` shaped per Q3 (top-level composition with N
  reviewable-root children; `emit: section` ONLY on the final
  reviewable root). Worked example in the prompt MUST show
  multi-root structure (fixes the live-test single-branch
  failure).
- Validator addition in `plan-tree.ts`: reject degenerate
  shapes (single-child top-level composition, single-leaf top
  level, depth > 2 with zero siblings AND fewer than N leaves
  per Q2). Corrective retry on validation failure.
- Per-root execution loop wrapping `plan-tree-runner`:
  reviewable-root iterator, sequential per "no parallel LLM
  calls" rule. Each root: execute -> review -> maybe followup
  (cap 3 per Q6).
- Per-root review step: structured-output verdict
  `accept | followup | revise-major`. Followup payload =
  hint + suggested leaves (advisory; planner re-validates).
- Followup execution: small extension composition under the
  current root (Q6 sub-Q6a); see only reviewer hint + root's
  findings + TODO objective (Q6 sub-Q6b); cap = 3 followup
  cycles, force-accept with `cycles_consumed` + `exhausted` on
  cap hit; hint mutation allowed (Q6 sub-Q6d).
- Section assembly step: renders the per-root findings into
  section markdown using the `emit: section` root's output.
- Section review loop (Q5): cap 2 cycles (review +
  revise-edits + final review = at most 3 calls typical);
  three-verdict structured output;
  `revise-major` escapes back to the orchestrator (re-opens
  the section task tree, distinct from `revise-major` at the
  report level).
- L2 fallback wiring: if section tree fails irrecoverably per
  Q10's conditions, invoke `<owner>.answer-question` with the
  working-memory bundle + TODO objective; mark entry
  `fallback: 'L2'`.

**Acceptance:**
- Unit tests for the per-root loop: accept-on-first-pass;
  followup-then-accept; followup cap hit (force-accept with
  exhausted=true); revise-major escape re-plans the section
  tree.
- Validator rejects the live-test single-branch shape;
  corrective retry produces a multi-root tree.
- L2 fallback path triggered by an injected planner failure
  produces a non-empty section.

### P4 -- Final report assembler + review

**Depends on:** P1, P2, P3, Q7.

**Deliverables:**
- `assembleReportStep`: reads all completed
  `WorkingMemoryEntry.detail` markdown blocks and assembles
  them into a coherent report (intro + sections +
  conclusion). LLM call.
- Report review step: structured-output verdict
  `accept | revise-edits | revise-structural`. Cap 2 review
  cycles per Q7.
- `revise-edits` path: whole-report LLM rewrite, then final
  review.
- `revise-structural` path: ONE permitted per report; carries
  `section-contradiction` (re-runs Q5 review for named
  sections) OR `scope-gap` (appends at most 2 new TODOs to the
  investigation plan; orchestrator runs them; report
  regenerates).
- Force-accept with `report-review-exhausted` annotation in a
  tail block on cap hit.

**Acceptance:**
- Unit tests: accept-on-first-pass; revise-edits cycle;
  revise-structural with section-contradiction; revise-
  structural with scope-gap adding TODOs.
- End-to-end test (mock LLM): full pipeline P2 -> P3 -> P4
  produces a multi-section report with a non-trivial intro
  and conclusion.

### P5 -- Cutover commit (rip-and-replace)

**Depends on:** P1, P2, P3, P4.

**The cutover commit (small, atomic, trivially revertable):**

- In `daemon/controllers/data-analyzer-orchestrator.ts`:
  - Swap the existing call site for the new orchestrator
    entrypoint (a single function that runs Step 1 -> Step 2
    -> per-TODO loop calling P3 -> P4).
  - Delete `afterSkillsRoutingBootstrap`.
  - Delete `K_ACCEPTED`, `K_HISTORY`, `K_RAW_EXECUTIONS`
    constants + all reads/writes.
  - Delete the `case 'planning'` route and the legacy
    synthesize step.
- In `tasks/data-analyzer/state.ts`: remove the deleted state
  keys.

**Rollback:** `git revert <cutover-commit>` restores the old
path; new modules become dormant dead code, cleaned up later.

### P6 -- TodoList integration extensions

**Depends on:** Q8. Can land alongside P5 or as the immediately-
following commit.

**Deliverables:**
- In `src/insrc/db/todos.ts`: add `subItems`,
  `note?: string`, `origin?: 'initial' | 'report-review-
  escalation'` fields on `TodoItem`.
- Orchestrator emits TodoList updates per Q8 wire-up rules:
  investigation plan land; reviewable-root transitions;
  followup-cycle status text updates; escalation notes;
  report-review-escalation TODO additions.
- Workbench renderer (vscode-insrc side) renders the
  two-level structure: TODOs as items, reviewable roots as
  sub-items, status text for followup cycle counts,
  escalation notes inline.

**Acceptance:**
- A Hadoop-sized run shows reviewable-root sub-items
  transitioning through `pending` -> `in-progress` ->
  `complete`.
- Followup cycle status text appears during multi-cycle
  followup execution.
- A test injection of `revise-major` shows the escalation
  note on the affected TODO.
- A test injection of `scope-gap` adds a TODO with the origin
  badge mid-run.

### P7 -- Live acceptance test

**Depends on:** P1-P6 landed.

**Acceptance criteria (the full end-to-end signal):**
- INGRN field-mapping question: 5-7 sections produced,
  mixing structured (compare) with narrative (overview /
  gaps / recommendations).
- Each section's `WorkingMemoryEntry.detail` is a coherent
  markdown block with concrete citations from the prior
  turns.
- Final report has a coherent intro + conclusion stitched
  from the memory bundle (not a verbatim concat).
- Hadoop comprehensive question: report completes within 30
  min wall-clock with `qwen3.6:35b-a3b` as the local
  shaping model.
- Crash-and-resume test: kill the daemon mid-Step-3 on a
  GRN run; restart resumes at the in-flight TODO,
  preserves prior TODOs' contributions, final report
  ships.

### P8 -- Cleanup (after burn-in)

**Depends on:** P5 landed + at least 1 week of clean runs.

- Remove the dormant new-module exports that the orchestrator
  doesn't reach (if any were left in P5).
- Remove any temporary diagnostic logging added during P3 /
  P4 burn-in.
- Update CLAUDE.md to reflect the new orchestrator shape
  (replace the bootstrap mention; document the working-memory
  module location).

## What this is NOT

- **Not a return to the old `PlannedAction[]` model.** That model
  conflated section + execution-strategy. We're separating them.
- **Not a deletion of the tree planner / executor / compare skill.**
  Those become the section-planner backend (Q2 decides whether the
  shape stays tree or grows to DAG).
- **Not a redesign of `Task`.** `Task` stays a contextless execution
  unit. TODOs live above it; tasks remain below.
- **Not autonomy.** Outer planner + per-TODO task graphs are visible
  in logs; the TodoList surface shows progress. User can interrupt
  any review loop.
