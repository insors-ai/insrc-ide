# Planner cross-category skill awareness

**Status:** draft (2026-06-03)
**Owner:** subhagho@gmail.com
**Standing rule:** **the root planner of each analyzer (`planActions`) is the single source of truth for which skill categories an action needs. Downstream dispatch (L2 `answer-question` -> `classify-question` -> `select-scope`) respects that decision; it never widens or narrows the candidate pool on its own.**

## Why

Today the `/data-analyze` planner produces actions like *"INGRN Pydantic Class Fields & Validation Rules"* and the L2 skill correctly says "I don't have it" because the data-analyzer's skill pool is owner-filtered to `data-analyzer` and the connection roster only contains the JSON directory. The pydantic class lives in a Python source repo that `code-analyzer` knows how to read, but the data-side dispatch can't reach it.

Symptom from run `ca9731cb...`: the JSON-shape sections were 4/4 grounded, but every section that named the INGRN class included a "Gap: INGRN Class Definition Not Available" paragraph -- the report is honest but incomplete by construction.

Root cause: **no cross-category bridge.** The category seed already exists (every skill carries an `owner` field), but the planner emits no category requirement and the meta `classify-question` skills prefilter the catalog hard by `owner === self`:

```
src/insrc/daemon/skills/built-ins/code.meta.classify-question.ts:200:  if (skill.owner !== 'code-analyzer') continue;
src/insrc/daemon/skills/built-ins/data.meta.classify-question.ts:248:  if (skill.owner !== 'data-analyzer')   continue;
```

## The shape of the change

This is **one new field on the planner output** and the threading required to make it load-bearing. Not a new layer, not a new orchestrator.

### Planner output enrichment

`PlannedAction` gains a single field:

```ts
readonly requiredCategories: readonly SkillCategory[];   // e.g. ['data'] or ['data', 'code']
```

where `SkillCategory` is just the existing skill `owner` namespace promoted to a shared union (`'code-analyzer' | 'data-analyzer' | ...`). The planner's *own* analyzer is always implicitly included; `requiredCategories` lists the **additional** categories needed.

The planner system prompt gets one new rule + a category catalog injected by the orchestrator:

```
Available skill categories (with one-line capability hint):
  - data: read CSV/JSON/Parquet files, profile data quality, sample rdbms tables
  - code: read source files, find callers/callees, summarize entities

Per action, decide which OTHER categories (beyond your own) the section
needs. Default to none. Add a category only when the section's objective
inherently requires it -- e.g. "compare X to a pydantic class definition"
needs `code`; "show how this Java class's outputs match downstream CSV"
needs `data` from the code side.
```

The planner already runs on the cloud model with the full user prompt + summary context; deciding category requirements is a natural fit for that step. **No second LLM call.**

### Orchestrator pre-action hook

Before dispatching each action, the orchestrator looks at `requiredCategories` and, for any category not currently provisioned, runs a one-shot **category-resource materializer**:

```ts
type CategoryResourceMaterializer = (input: {
  request: string;
  action:  PlannedAction;
  session: Session;
}) => Promise<CategoryResource | { skipped: string }>;
```

- `code` materializer: resolve a repo path. Strategy: regex/LLM-extract class/module names from `action.objective + action.title`, search the active VSCode workspace folder list, then fall back to the dependency-closure registry. If multiple candidates, the materializer picks the highest-confidence one and logs the others as notes (no user prompt; the planner already chose to commit to this category).
- `data` materializer (called from the code side): extract path hints from the action; register as an ephemeral file connection (same path as the existing `/data-analyze` autodetect in `data-analyzer-orchestrator.ts:registerEphemeralConnectionFromPrompt`).

Materializer results are cached per-run keyed by `category` so two actions needing `code` don't both re-resolve.

### L2 skill: thread categories into invocationContext

`runAnswerQuestionAction` (data side) and `runAnswerQuestionSection` (code side) already pass an `invocationContext` to `runL2Skill`. Add one field:

```ts
invocationContext: {
  ...existing,
  requiredCategories: action.requiredCategories,    // including self
}
```

### classify-question + select-scope: widen the owner filter

The two meta skills currently hardcode the prefilter. Replace it with a `requiredOwners` set passed in via input:

```ts
const ALLOWED_OWNERS: Set<string> = input.allowedOwners ?? new Set([OWNER_ID]);
for (const skill of catalog) {
  if (!ALLOWED_OWNERS.has(skill.owner)) continue;
  ...
}
```

`answer-question` populates `allowedOwners` from `invocationContext.requiredCategories` (default = own owner only, preserving today's behavior).

The catalog rendering for the LLM stays per-section-scoped; widening the *allowed* set just lets more candidates survive the prefilter. The `goal` field already disambiguates which skill the model picked.

## Phases

### P1 -- Types + planner output (mechanical)

1. Add `SkillCategory` union to `src/insrc/daemon/skills/types.ts` (export). Today `owner` is `string`; tighten to the union with a fallback `(string & {})` escape hatch so existing string literals continue to compile.
2. Add `requiredCategories: readonly SkillCategory[]` to `PlannedAction` in `src/insrc/agent/content-gen/plan-actions.ts` + `PLAN_ACTIONS_SCHEMA` in `src/insrc/agent/content-gen/schema.ts`. Default to `[]` in the validator when the LLM omits it (no migration breakage).
3. Add `availableCategories?: { category: SkillCategory; capabilityHint: string }[]` to `PlanActionsInput`. When provided, the system prompt renders the catalog block + the category-decision rule.

### P2 -- Wire the orchestrators to populate availableCategories

1. `code-analyzer-orchestrator.ts` planner call site: pass `availableCategories: [{ category: 'data', capabilityHint: 'read CSV/JSON/Parquet files; profile data quality' }]` (only categories OTHER than self).
2. `data-analyzer-orchestrator.ts` planner call site: pass `availableCategories: [{ category: 'code', capabilityHint: 'read source files; find callers/callees; summarize class entities' }]`.
3. Both orchestrators stamp `requiredCategories: action.requiredCategories ?? []` into each `PlannedAction` before the dispatch loop (no-op if the planner already returned them).

### P3 -- Category-resource materializer

1. New module `src/insrc/agent/content-gen/category-materializer.ts`:
   - `CategoryResourceMaterializer` type
   - `materializeCode(input)` -- resolves a repo path from action title/objective + workspace folders
   - `materializeData(input)` -- registers an ephemeral file connection (reuse `data-analyzer-orchestrator.registerEphemeralConnectionFromPrompt` logic; extract to a shared helper)
2. Orchestrator hook: before each action's dispatch, iterate `action.requiredCategories`; for each category not in the current resource cache, run its materializer. Cache results per-run.
3. On materializer `skipped`, the orchestrator logs a note and removes that category from the action's effective `requiredCategories` -- the L2 skill will then NOT widen the owner filter, and the section will honestly say "the X source was not resolvable" instead of fabricating.

### P4 -- Thread requiredCategories through L2 dispatch

1. Add `requiredCategories?: readonly SkillCategory[]` to `L2InvocationContext` in `src/insrc/daemon/skills/l2/runtime.ts` (or wherever the type lives).
2. `runAnswerQuestionAction` (data) + `runAnswerQuestionSection` (code) populate it from the PlannedAction.
3. Inside `data.answer-question` and `code.answer-question`, pass `allowedOwners: new Set(['<self>', ...invocationContext.requiredCategories])` into the `classify-question` and `select-scope` calls.

### P5 -- classify-question + select-scope widen the prefilter

1. Add `allowedOwners?: string[]` to the four meta skills' inputSchema (`code.meta.classify-question`, `code.meta.select-scope`, `data.meta.classify-question`, `data.meta.select-scope`).
2. Replace the hardcoded `if (skill.owner !== <X>) continue;` checks with `if (!ALLOWED.has(skill.owner)) continue;` where `ALLOWED = new Set(input.allowedOwners ?? [<self>])`.
3. Confirm the rendered catalog still groups by category so the LLM can see which candidate belongs to which side (just a heading per owner group in the prompt rendering).

### P6 -- Test + ship

1. Unit test the validator: `requiredCategories` round-trips through `validatePlan`; missing field defaults to `[]`; invalid values fail with a clear message.
2. Unit test the meta-skill prefilter: with `allowedOwners=['data-analyzer','code-analyzer']` the catalog includes both owners; default behavior unchanged when omitted.
3. Live test: re-run the INGRN report. Expect the *"INGRN Pydantic Class Fields"* and *"JSON-to-INGRN Field Mapping"* actions to come back with `requiredCategories: ['code']`, the materializer to resolve `insors-extraction`, and `code.entity.summary` / `code.source.file.read` to appear in the per-action dispatched list with actual class field facts (not inferred-from-JSON facts).
4. Commit, push, restart `~/.insrc/daemon`.

## What this is NOT

- **Not a meta-planner above the orchestrators.** Each analyzer's existing planner stays; the change is one extra output field + threading.
- **Not a unification of the connection model.** Code side's `activeRepoPath` and data side's `ConnectionSummary[]` stay separate; the category-resource materializer is a thin adapter per category, not a polymorphic roster.
- **Not autonomy.** The planner's decision is logged and the user can see in the per-action log which categories were widened. No silent cross-side calls.

## Open questions

1. ~~Does the `code` materializer need user confirmation when it picks a repo path?~~ **DECIDED 2026-06-03: prompt only on ambiguity.** 0 candidates -> skip the category with a logged note (the L2 skill will then honestly say "X source was not resolvable"); 1 candidate -> auto-pick; 2+ candidates -> raise a `ctx.gate()` in the orchestrator and let the user choose. Requires the materializer to return a typed `Resolved | Ambiguous | NotFound` result instead of a single value, and the orchestrator to handle the `Ambiguous` case via the existing gate mechanism (same surface as Pair/Delegate gates).
2. ~~Should `requiredCategories` be visible in the final report header?~~ **DECIDED 2026-06-03: no visible marker.** The citation paths themselves (e.g. `insors_extraction/models/in_grn.py` vs `test/integration/data/BB/GRN/grn_data.json`) make the source domain obvious to the reader. The L2 skill's existing confidence/notes footer surfaces grounding issues when they occur. No new rendering surface required.
3. ~~Cap on cross-category breadth?~~ **DECIDED 2026-06-03: no cap.** Trust the planner. The classify-question/select-scope token cost scales with the catalog rendered, not with `requiredCategories.length` directly, so the runaway-cost concern is bounded. If a runaway plan shows up in practice, revisit then.
