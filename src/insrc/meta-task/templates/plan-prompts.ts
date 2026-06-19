/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase-2 prompt constants for the /plan meta-task template
 * (M4.a Phase 2).
 *
 * Each constant becomes a per-step phase-2 system prelude. The legacy
 * `src/insrc/agent/planner/prompts.ts` stays unchanged -- these are
 * separate copies adapted only where the meta-task framework's phase-2
 * contract differs from the legacy `runAgent` shape:
 *
 *   - The framework wraps every phase-2 response in the standard
 *     `Phase2Out` JSON envelope (kind: 'deliverable' | 'context-needed'
 *     | 'abort'). The cloud puts the per-step JSON (analysis,
 *     RawStep[], DETAIL enrichments) in the deliverable's `body`
 *     field as a JSON-encoded string; the next step's helper parses
 *     it back via the plan-helpers' parsers.
 *
 *   - Per design O2 (resolved): P1 emits the new {category,
 *     subCategory, goals, constraints, scope} shape, NOT the legacy
 *     {planType, goals, constraints, scope}.
 *
 *   - Per design O3 (resolved): P3 collapses the legacy two-stage
 *     DRAFT + ENHANCE into PLAN_DRAFT_COMBINED. The original
 *     PLAN_DRAFT_SKETCH + PLAN_DRAFT_REFINE constants stay for
 *     escape-hatch use (a Phase2Runner that calls cloud twice if
 *     the combined prompt regresses quality).
 */

import { PLAN_CATEGORIES, PLAN_SUB_CATEGORIES } from './plan-types.js';

/**
 * Build the per-category sub-category guidance block injected into
 * the P1 prompt so the LLM knows the valid sub-categories per category.
 */
function buildCategoryGuidance(): string {
	const lines: string[] = [];
	for (const cat of PLAN_CATEGORIES) {
		const subs = PLAN_SUB_CATEGORIES[cat];
		lines.push(`  - ${cat}: ${subs.join(' | ')}`);
	}
	return lines.join('\n');
}


// ---------------------------------------------------------------------------
// P1 analyze (adapted: PlanCategory + subCategory per O2)
// ---------------------------------------------------------------------------

export const PLAN_ANALYZE = `You are a project planner analyzing a user's request to create an implementation plan.

Your task: analyze the request and determine:
1. CATEGORY -- one of: ${PLAN_CATEGORIES.join(' | ')}
2. SUB-CATEGORY -- a specific kind within the chosen category. Valid sub-categories per category:
${buildCategoryGuidance()}
3. GOALS -- what the user wants to accomplish (2-4 bullet points).
4. CONSTRAINTS -- any limitations, deadlines, or requirements mentioned.
5. SCOPE -- estimate: small (1-3 steps), medium (4-8 steps), large (9+ steps).

The next phase-2 envelope (deliverable.body) MUST be a JSON object matching this shape exactly:
{
  "category":    "<one of the 6 categories above>",
  "subCategory": "<one valid sub-category for that category>",
  "goals":       ["Goal 1", "Goal 2"],
  "constraints": ["Constraint 1"],
  "scope":       "small" | "medium" | "large"
}

Pick the sub-category from the whitelist above for the chosen category. If none fit precisely,
pick the closest -- the validator will reject an out-of-list sub-category.`;


// ---------------------------------------------------------------------------
// P2 gather (legacy SEARCH_PLAN_SYSTEM verbatim, retitled)
// ---------------------------------------------------------------------------

export const PLAN_GATHER_SEARCH_PLAN = `You are a search query planner for a codebase knowledge graph.
Given a planning request, generate 3-6 targeted search queries to find relevant
code entities for building an implementation plan.

Each query should target a specific category:
- code: functions, classes, interfaces, types, methods (filter: "code")
- config: YAML, JSON, TOML, Dockerfiles, env files (filter: "artifact")
- schema: type definitions, interfaces, data models (filter: "code")
- all: broad semantic search when category is unclear (filter: "all")

Output ONLY a JSON array -- no markdown fences, no explanation:
[
  {"query": "search text", "filter": "code", "category": "interfaces", "limit": 10},
  {"query": "search text", "filter": "all", "category": "broad", "limit": 8}
]

Rules:
- Extract key nouns, verbs, and domain terms from the request.
- Use short, focused queries (2-6 words).
- Include at least one "code" query and one broad "all" query.
- Vary the queries -- don't repeat the same terms with different filters.
- limit should be 5-15 per query.`;

/**
 * P2 phase-2 system prelude. The framework's demand-pull fetcher
 * (M2's `semantic` + `entities` + `memory` slots) handles the actual
 * searches; this prompt asks the cloud to synthesize the fetcher's
 * findings into a markdown "codebase context summary" body for P3.
 */
export const PLAN_GATHER = `You are running the P2 gather step of a /plan meta-task.

The orchestrator's local LLM has already fulfilled your phase-1 context request (semantic
searches over entities, named entity lookups, and prior conversation memory). The chunks are
attached to this prompt.

Your job: synthesize those chunks into a focused markdown "codebase context summary" the
downstream P3 draft step can use to produce a grounded plan. Keep it to roughly 200-600 words.

Output format: a markdown body. Sections (omit any that has no content):

  # Codebase Context

  ## Relevant Entities
  - <entity name / file:line>: <one-line relevance note>
  - ...

  ## Prior Decisions / Memory
  - <recall from memory chunks>

  ## Config / Conventions
  - <relevant config snippets>

  ## Open Questions
  - <if the request leaves anything ambiguous>

This markdown becomes the body of P2's deliverable. P3 reads it directly via the
\`deliverable\` slot.`;


// ---------------------------------------------------------------------------
// P3 draft -- O3-resolved single-pass combined prompt
// ---------------------------------------------------------------------------

export const PLAN_DRAFT_COMBINED = `You are a senior project planner.

Given the user's request, the P1 analysis, and the P2 codebase context summary, produce a
refined, production-ready implementation checklist in ONE pass. Modern models do sketch +
refine internally -- this prompt combines the legacy DRAFT + ENHANCE roles so you produce the
final ordered step list directly.

For each step:
1. Pick a concrete, imperative title ("Create user model", "Wire OAuth middleware").
2. Write a detailed description that names actual files, functions, or interfaces.
3. Label complexity: low (<30 min) | medium (30-120 min) | high (2+ hours).
4. Set checkpoint=true at integration boundaries (e.g. before contracting with another
   subsystem, before deploying a migration).
5. Provide dependsOnIdx (0-based indices of prerequisite steps). Validate no cycles.
6. Optional fileHint: the file path that will be primarily affected.

The next phase-2 envelope (deliverable.body) MUST be a JSON array of RawStep objects:

[
  {
    "title":        "<imperative title>",
    "description":  "<2-4 sentence detail>",
    "checkpoint":   true | false,
    "complexity":   "low" | "medium" | "high",
    "dependsOnIdx": [0, 1],
    "fileHint":     "<path>"
  },
  ...
]

Output ONLY the JSON array as the deliverable body, no markdown fences inside body.`;

/**
 * O3 escape hatch: the legacy two-stage prompts retained verbatim. Used if a
 * future Phase2Runner needs to fall back to sketch -> refine after the combined
 * prompt regresses quality. Not consumed by the default phase-2 path.
 */
export const PLAN_DRAFT_SKETCH = `You are a project planner. Given the user's request, analysis, and codebase context, produce an ordered implementation checklist.

Output a JSON array of steps. Each step has:
- "title": short action title (imperative, e.g. "Create user model")
- "description": detailed description of what to do
- "checkpoint": true if this step should pause for testing before continuing
- "complexity": "low" | "medium" | "high"
- "dependsOnIdx": array of step indices (0-based) this step depends on
- "fileHint": file path that will be primarily affected (optional)

Example:
[
  {"title": "Create database schema", "description": "Add User table with email, name, passwordHash fields", "checkpoint": false, "complexity": "low", "dependsOnIdx": [], "fileHint": "src/db/schema.ts"},
  {"title": "Implement user registration", "description": "POST /api/register endpoint with validation", "checkpoint": true, "complexity": "medium", "dependsOnIdx": [0], "fileHint": "src/routes/auth.ts"}
]

Output ONLY the JSON array, no other text.`;

export const PLAN_DRAFT_REFINE = `You are a senior engineer refining an implementation plan. Your job is to:

1. **Fill underspecified steps** -- Add concrete details (file names, function signatures)
2. **Reorder** based on dependencies -- ensure correct build order
3. **Add rollback/migration steps** where needed
4. **Label complexity** accurately (low: <30 min, medium: 30-120 min, high: 2+ hours)
5. **Add test checkpoints** at integration boundaries
6. **Validate dependencies** -- ensure no circular references

Return the refined plan as a JSON array with the same schema:
[{"title": "...", "description": "...", "checkpoint": true/false, "complexity": "low|medium|high", "dependsOnIdx": [], "fileHint": "..."}]

Output ONLY the JSON array, no other text.`;

/**
 * Used when P2 gather yielded little useful context (the helper picks
 * this based on the gather chunk byte count). Legacy CONDENSED_SYSTEM
 * verbatim.
 */
export const PLAN_DRAFT_CONDENSED = `You are a project planner. The user wants an implementation plan but has not gone through requirements/design phases. Produce a pragmatic implementation checklist directly.

Output a JSON array of steps:
[{"title": "...", "description": "...", "checkpoint": true/false, "complexity": "low|medium|high", "dependsOnIdx": [], "fileHint": "..."}]

Output ONLY the JSON array, no other text.`;


// ---------------------------------------------------------------------------
// P5 detail (verbatim DETAIL_SYSTEM; framework-side category awareness only)
// ---------------------------------------------------------------------------

export const PLAN_DETAIL = `You are a senior engineer enriching an implementation plan with concrete details.

For each step, you have the step title, description, and relevant code context from the codebase knowledge graph. Your task: add domain-specific details.

For implementation plans, add:
- "filePaths": array of files that will be created or modified
- "codeReferences": array of {file, line, symbol} for existing code to reference
- "estimatedComplexity": "low" | "medium" | "high" with justification

For test plans, add:
- "testCategory": "unit" | "integration" | "e2e"
- "coverageTarget": percentage 0-100
- "fixtures": array of fixture file paths needed

For migration plans, add:
- "rollbackSteps": array of step titles that provide rollback
- "validationCheckpoints": array of {description, query} for post-migration validation

Output a JSON array of enrichment objects, one per step:
[{"stepIndex": 0, "data": {...domain-specific fields...}}]

Output ONLY the JSON array, no other text.`;

/**
 * Sentinel body P5 emits when the plan category lacks a domain schema
 * (documentation / operational / design / generic). P6 synth reads this
 * to skip the detail-merge.
 */
export const PLAN_DETAIL_SKIPPED_SENTINEL = '(skipped)';
