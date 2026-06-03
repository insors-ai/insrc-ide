# Skill-tree planner architecture

**Status:** design (2026-06-03)
**Owner:** subhagho@gmail.com
**Standing rule:** **the planner is a program writer, not a section enumerator. Its output is a typed skill tree whose nodes declare their inputs (literal, ancestor-output, session-context) and whose edges are the dispatch order. The orchestrator is a tree executor; the LLM never invents skill arguments or cross-domain alignments at runtime.**

## Why

Today's flat `PlannedAction[]` model collapses three distinct concerns into one fuzzy step:

1. **Decomposition** -- "what sections does this report need?"
2. **Dispatch** -- "what skills produce evidence for each section?"
3. **Composition** -- "how do those skills' outputs combine into the section's answer?"

The planner only emits the first. Concerns 2 and 3 happen inside the L2 `answer-question` skill as classify -> select-scope -> dispatch -> draft, where the LLM picks skills *and* invents how their outputs relate. The cross-category INGRN run made the symptom obvious:

- `code.class.extract-fields` returned 21 INGRN fields with types
- `data.source.file.sample-shape` returned 10 JSON top-level keys with types
- The drafter had both ledger entries in front of it and produced **internally contradictory sections**: Section 2 lists 12 INGRN fields (some "Inferred"), Section 3 marks 9 of those same fields as "(unmapped)", Section 4 invents `grn_status` as a string enum

The two skills are orthogonal producers. The bridge between them lives only in the drafter's prose, and the drafter has no structural guarantee that two sections agree on the same fact.

**Bridge skills don't fix this.** Adding `compare.json-vs-pydantic-class` as a sibling that runs after the two source skills works for that one alignment, but it's a band-aid: every new cross-domain alignment needs a new sibling. The deeper fix is to make the planner express the call graph directly.

## The shape of the change

Replace `PlannedAction[]` with a typed `PlannedNode` tree. Each node is either a **leaf** (one skill call) or a **composition** (children execute in declared order, outputs visible to siblings/parent). Inputs to each node are declared with a small wiring DSL: `{ source: 'node' | 'literal' | 'question' | 'context', ... }`. The orchestrator walks the tree, builds the input context bag from resolved ancestors, calls the skill, stores the output, and continues.

### Types

```ts
interface PlannedTree {
  readonly intentBrief: string;
  readonly root:        PlannedNode;
}

interface PlannedNode {
  readonly id:        string;        // kebab-case, deduped, stable
  readonly title:     string;        // user-facing when emit='section'
  readonly objective: string;        // documentation + observability

  // Mutually exclusive: a node is either a leaf or a composition.
  readonly kind:        'leaf' | 'composition';
  readonly skill?:      SkillId;        // leaf only
  readonly children?:   readonly PlannedNode[];   // composition only
  readonly composition?: 'sequence' | 'parallel'; // default sequence

  // Wiring map keyed by the skill's inputSchema property names.
  // Composition nodes pass `inputs` to all children whose skills declare
  // the matching argument names (named-by-convention auto-wiring is
  // intentionally NOT supported -- every wire is explicit).
  readonly inputs: Record<string, InputBinding>;

  // What happens to this node's output once it resolves:
  //   - 'section': becomes one section of the final report; `title`
  //                rendered as a level-2 heading; `render` controls the
  //                body shape.
  //   - 'intermediate': output kept in the context bag for downstream
  //                     wiring; not surfaced in the report.
  //   - 'discard': output not retained beyond child resolution (use for
  //                expensive intermediates that only feed one consumer).
  readonly emit: 'section' | 'intermediate' | 'discard';

  // Section-only.
  readonly render?: { kind: 'auto'; } | { kind: 'template'; template: string; };
}

type InputBinding =
  | { readonly source: 'node';     readonly nodeId: string; readonly path: string; }
  | { readonly source: 'literal';  readonly value:  unknown; }
  | { readonly source: 'question'; readonly extract: string; }   // regex
  | { readonly source: 'context';  readonly key:    string; };   // session-derived
```

### Concrete example: the INGRN report

```yaml
intentBrief: "Map JSON test fixtures to the INGRN pydantic class."
root:
  id: report-root
  kind: composition
  composition: parallel        # the three branches are independent
  inputs: {}
  emit: discard
  children:
    - id: data-inventory
      kind: leaf
      skill: data.source.file.describe
      emit: section
      title: "JSON Test Data Files & Shape"
      inputs:
        connectionId: { source: context, key: primaryConnection }

    - id: extract-class
      kind: leaf
      skill: code.class.extract-fields
      emit: section
      title: "INGRN Pydantic Class Definition"
      inputs:
        className: { source: question, extract: "INGRN" }
        language:  { source: literal,  value: python }
        repoPath:  { source: context,  key: codeRepoPath }

    - id: align
      kind: composition
      composition: sequence
      emit: section
      title: "INGRN ↔ JSON Field Mapping"
      inputs: {}
      children:
        - id: align-sample
          kind: leaf
          skill: data.source.file.sample-shape
          emit: intermediate
          inputs:
            connectionId: { source: context, key: primaryConnection }
        - id: align-compute
          kind: leaf
          skill: shared.compare.fields-vs-shape
          emit: section
          inputs:
            # Explicit wires -- the orchestrator resolves these before
            # calling shared.compare.fields-vs-shape.
            classFields: { source: node, nodeId: extract-class, path: "fields" }
            dataShape:   { source: node, nodeId: align-sample,  path: "columns" }
```

Three independent top-level branches; one of them (`align`) has its own internal sequence (sample-shape -> compare) that wires the compare skill's `classFields` arg from `extract-class.fields` and its `dataShape` arg from `align-sample.columns`. The compare skill computes the alignment in **code**. The drafter never invents `grn_status: enum` because the compare skill's output literally says `grn_status: { jsonType: 'BIGINT', classType: 'int', match: 'type-match' }`.

### Cross-cutting changes

1. **Skill catalog enrichment.** Each skill's `outputs` schema must be structurally introspectable so the planner can validate `path` references. Today `outputs` is a free-form JSON schema; we keep that but compute a flattened `outputPaths: string[]` cache at registration time.

2. **Planner prompt redesign.** The planner stops emitting prose sections and starts emitting a typed tree. The system prompt becomes a teaching prompt about wiring (here are the available skills, here's their input/output shape, here's the wiring DSL). The "few-shot" examples become small concrete trees.

3. **Orchestrator becomes a tree executor.** Replace the per-action `for` loop with a topological walker that:
   - Resolves each node's `inputs` against the context bag (ancestor outputs + session context).
   - Calls the skill via `runSkill(skillId, resolvedInputs, deps)` (the existing L1 invocation path; no L2 wrapper).
   - Stores `output.value` in the context bag under `nodeId`.
   - Emits sections to the stitcher in `emit === 'section'` order (depth-first by default).

4. **The L2 `answer-question` skill becomes a fallback leaf**, not the primary engine. When the planner emits a leaf with `skill: code.answer-question`, it's saying "this sub-question is genuinely open-ended; defer dispatch to the L2 layer's runtime classify+select+draft." That's a graceful escape hatch for free-form questions; it's not the default.

### What this subsumes

- **P1-P5 cross-category dispatch:** the tree replaces `requiredCategories` + materializer + select-scope cross-owner widening. Cross-category is just two skills from different owners wired together.
- **Bridge skills:** still useful as leaf-node implementations (e.g. `shared.compare.fields-vs-shape`), but no longer a special architectural concept -- they're just skills the planner knows how to compose.
- **Per-section L2 dispatch:** retained as a fallback leaf, demoted from the default path.

### What this does NOT change

- L1 skill implementations stay as-is. The contract `(input, ctx) -> SkillResult` is unchanged.
- The skill registry, owner/family taxonomy, and L1 invocation runtime (`runSkill`) are unchanged.
- The orchestrator's higher-level concerns (intent classification, scope sizing, ephemeral connection registration, report writing, IDE streaming) are unchanged.

## Phases

### P1 -- Schema + validator (no behavior change)

1. Add `PlannedTree` / `PlannedNode` / `InputBinding` types to `agent/content-gen/plan-tree.ts`.
2. JSON schema + `validatePlannedTree` with cycle detection, duplicate-id check, leaf-vs-composition exclusivity, wire-source validation.
3. Unit tests on validator: malformed trees rejected with clear messages.

### P2 -- Skill catalog enrichment

1. Augment `Skill` registry entries with `outputPaths: string[]` computed from each skill's output schema at registration time (e.g. `code.class.extract-fields` exposes `fields`, `fields[].name`, `fields[].type`, etc.).
2. Add `getSkillOutputPaths(skillId): string[]` helper.
3. Validator uses these to reject wires whose `path` doesn't exist on the source skill's output.

### P3 -- Tree executor

1. New module `daemon/controllers/tree-executor.ts`:
   - `executeTree(tree, ctx) -> { sections, intermediates }`
   - Topological walk; sequence/parallel composition semantics; input resolution from context bag; skill invocation via existing `runSkill`.
2. Output stitcher (`stitchTreeSections`) that walks emit='section' nodes depth-first and renders the report.
3. Per-node IDE streaming events (`tree-node-start`, `tree-node-complete`, `tree-node-failed`).

### P4 -- Planner prompt redesign

1. New planner system prompt teaching the wiring DSL with 2-3 worked examples (single-leaf, parallel-leaves, compose-then-align).
2. Catalog rendering: every skill listed with its input schema AND outputPaths so the LLM can wire correctly.
3. `submit_tree` tool replaces `submit_plan`. Validator runs server-side; on failure, the LLM gets the typed error message and a retry.
4. The new planner output `degraded: true` path falls back to a single-leaf tree pointing at `<owner>.answer-question` for the whole question (i.e. today's L2 dispatch becomes the safety net).

### P5 -- Seed composition skills

1. `shared.compare.fields-vs-shape` -- align an extracted class field list with a data file's column shape; emit a structured alignment table.
2. `shared.compare.rdbms-table-vs-class` -- same idea for RDBMS schemas.
3. `shared.lineage.class-to-data-driver` -- trace how a pydantic class's outputs flow into data writes (links code skills + data skills).
4. These are pure-code aligners (no LLM); their outputs are citable artifacts.

### P6 -- Orchestrator cutover

1. Replace the per-action loop in `data-analyzer-orchestrator.ts` + `code-analyzer-orchestrator.ts` with `executeTree(plan.root, ...)`.
2. Delete `agent/content-gen/plan-actions.ts` and `agent/content-gen/plan-actions-interactive.ts` (replaced by `plan-tree.ts`).
3. Delete `agent/content-gen/category-materializer.ts` orchestrator hook (the tree's `context` resolver handles `codeRepoPath` / `primaryConnection` via session-context bindings).
4. L2 `answer-question` skills retained as fallback leaves only; their classify/select-scope internals stay registered.

### P7 -- Live test + ship

1. Re-run the INGRN report. Expect the tree to be visible in the log; per-node outputs traceable; alignment section grounded in `shared.compare.fields-vs-shape`'s structured output (not LLM-invented).
2. Acceptance: pick a fact from the report, verify it traces back via `nodeId.path` references to a real ledger entry from a specific node.
3. Commit + push.

## Open questions

Listed for resolution before the relevant phase ships; do NOT defer.

1. ~~Wire validation depth.~~ **DECIDED 2026-06-03: strict plan-time validation.** Every wire's `nodeId` (exists in tree, not a cycle, not the wiring node itself) and `path` (resolves against the source skill's registered `outputPaths`) checked before any skill runs. Bad trees rejected with a typed message; planner LLM gets one retry to fix. Requires P2's outputPaths catalog to be accurate -- a skill that omits or mis-declares outputPaths blocks valid wires until fixed. Cost: ~1ms validation pass per tree; benefit: zero wasted dispatch on malformed trees.

2. ~~Free-form fallback granularity.~~ **DECIDED 2026-06-03: per-leaf.** Any leaf in the tree may be an L2 skill (`code.answer-question` / `data.answer-question`) with a focused sub-question, and the planner can mix structured-composition leaves with L2 leaves within one tree (even within one section subtree). Planner system prompt teaches: "prefer composition; reach for L2 only when the sub-question is genuinely open-ended (qualitative explanation, pattern summary, free-form synthesis)." A 100%-L2-leaves tree is the degraded-fallback shape when the planner truly can't decompose.

3. ~~Tree size cap.~~ **DECIDED 2026-06-03: hard caps.** Schema rejects trees with leaf-count > 32, depth > 4, or any composition with > 8 children. Matches the existing flat-plan ceiling and bounds depth (most useful patterns are 2-3: root → section → leaves) and branching. If a real workload trips these, the fix is a design conversation, not a quiet relaxation.

4. ~~Parallel composition semantics.~~ **DECIDED 2026-06-03: advisory only.** `composition: 'parallel'` declares planner intent ("these children have no ordering dependency") but the executor runs them sequentially today, honoring CLAUDE.md's no-parallel-LLM rule. The structural information is preserved so a future executor can opportunistically parallelize pure-compute leaves without changing the tree shape or planner contract.

5. ~~Streaming output.~~ **DECIDED 2026-06-03: stitch order.** Sections stream in the order they'll appear in the final report (depth-first walk of `emit: 'section'` nodes). A node whose body resolves early but whose stitch position comes later waits its turn. Matches today's UX exactly; no IDE changes required. Practical effect is identical to "completion order" today since parallel is advisory-only (Q4). If real parallelism lands later, this is the only knob to revisit.

6. ~~Catalog token cost.~~ **DECIDED 2026-06-03: pre-filter LLM call.** Two-stage planning:
   - **Stage 1 (lightweight, ~1-line catalog):** classify-style call asks "given this question, which 8-12 skills are relevant?" — returns a candidate skill id list.
   - **Stage 2 (focused, full schemas):** the actual tree-planning call sees full input schemas + outputPaths only for the candidate list.

   Consolidates the architectural pattern today's L2 `classify-question` already uses — moves it up to the planner level so it filters once for the whole plan instead of once per L2 dispatch. Two LLM calls per plan instead of one, but each has a tighter context and the marginal cost is bounded.

   *Note: Stage 1 is conceptually identical to today's `code.meta.classify-question` / `data.meta.classify-question` — those skills survive as the implementation of Stage 1, just consumed by the planner instead of by L2 `answer-question`. P4 (planner prompt redesign) absorbs this.*

7. ~~L2 `answer-question` retention.~~ **DECIDED 2026-06-03: permanent fallback.** L2 stays as a first-class leaf option indefinitely. Truly open-ended sub-questions (qualitative explanation, pattern summary, free-form synthesis) are a legitimate use case where LLM-driven dispatch is the right answer; forcing the planner to compose every question would be regressive. The architecture has a stable two-tier shape: structured composition via the tree (default), L2 dispatch via per-leaf fallback (escape hatch).

8. ~~Backwards compat / kill-switch.~~ **DECIDED 2026-06-03: clean rip-and-replace.** P6 deletes `plan-actions.ts`, `plan-actions-interactive.ts`, and the orchestrators' per-action loops in one commit; the tree executor replaces them. Follows the same pattern as the P10 (code L2) and P14 (data L2) cutovers. The L2 fallback leaf provides the per-leaf safety net for sub-questions the planner can't structurally decompose; the architecture itself doesn't need a flag.

## What this is NOT

- **Not a graph DSL.** Nodes have a tree parent; sibling-to-sibling wiring is via shared parent context, not arbitrary edges. Keeps validation tractable.
- **Not a workflow engine.** No retries, no conditionals, no loops in the tree itself. Skills can have internal logic for those; the tree is acyclic + deterministic.
- **Not a replacement for L1 skills.** L1 skills keep doing what they do. The change is at the *coordination* layer.
- **Not autonomous.** The planner emits the tree, the user sees it (live in the IDE, persisted in the report), the orchestrator executes it deterministically. No mid-execution LLM decisions except inside leaf L2 skills.
