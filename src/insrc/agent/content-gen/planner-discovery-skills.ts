/**
 * Planner-discovery skill catalog.
 *
 * Plan 4 of plans/code-analyzer-planner-discovery-loop.md: the
 * cloud planner runs as a tool-using agent over a curated subset
 * of the existing skill catalog. This module defines that subset.
 *
 * Six existing + three new skills give the planner the surface it
 * needs to discover what's actually in the repo before committing
 * to a section plan:
 *
 *   STRUCTURAL DISCOVERY (6 existing):
 *     - code.source.repo.describe     -- top-level repo summary
 *     - code.source.module.describe   -- walk into a module / dir
 *     - code.source.file.describe     -- read a specific file's
 *                                        entities + body (file-read
 *                                        fallback ships READMEs)
 *     - code.entity.summary           -- read an entity body
 *     - code.entity.locate-by-name    -- find a specific named entity
 *     - code.entity.search-by-vector  -- semantic search for concepts
 *
 *   ADDITIONAL DISCOVERY (3 new, Plan 4 Phase 1):
 *     - code.source.grep              -- literal-pattern search
 *     - code.repo.git-status          -- files changed vs a ref
 *     - code.repo.git-recent          -- files in recent commits
 *
 * The planner's `submit_plan` termination pseudo-tool is defined
 * separately (it's not a regular skill -- the tool-loop substrate
 * intercepts it as a typed-terminal signal).
 *
 * No `planner_*` namespace -- all entries are real skill ids in
 * the existing catalog, so any per-skill arg-rename rule, schema
 * fix, or telemetry instrumentation applies uniformly to the
 * planner and to the per-section flow.
 */

/**
 * Skill ids the planner discovery flow exposes to the cloud
 * planner. Order is preserved when generating the tool catalog
 * shown to the LLM.
 */
export const PLANNER_DISCOVERY_SKILL_IDS: readonly string[] = Object.freeze([
	// Structural discovery (broadest first; the planner usually starts
	// with repo.describe or module.describe and narrows down).
	'code.source.repo.describe',
	'code.source.module.describe',
	'code.source.file.describe',
	'code.entity.summary',
	'code.entity.locate-by-name',
	'code.entity.search-by-vector',

	// Additional discovery (new in Plan 4).
	'code.source.grep',
	'code.repo.git-status',
	'code.repo.git-recent',
]);
