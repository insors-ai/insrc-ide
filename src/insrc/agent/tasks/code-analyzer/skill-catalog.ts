/**
 * Skill catalog for the code-analyzer's tool-loop section writer
 * (Phase F.1 of plans/intent-funnel-followups.md).
 *
 * The new architecture replaces the pre-cooked
 * "classify-question -> select-scope -> execute skills" pipeline
 * with a single tool-calling loop where the LOCAL LLM picks
 * which skills to call, when, and with what args. The catalog
 * lists every skill the LLM may invoke via `skill_invoke`; the
 * model's chain-of-thought drives the picks instead of an
 * upstream cloud LLM.
 *
 * Catalog filtering mirrors the legacy
 * `code.meta.classify-question:buildCatalog` (skill-id grammar +
 * repo-capability checks) -- same denylist, same precondition
 * checks. The difference is the consumer: instead of a cloud
 * skill picker producing a candidate JSON, the catalog renders
 * into the section-writer's system prompt and the LLM picks
 * skill IDs directly as `skill_invoke` arguments.
 *
 * EXCLUDED from the catalog:
 *   - meta family (`code.meta.classify-question`,
 *     `code.meta.select-scope`) -- scaffolding for the OLD
 *     pipeline; the tool-loop owns picking + arg-filling itself.
 *   - synthesis family (`code.synth.*`) -- output renderers; the
 *     section writer's LLM produces the markdown directly via
 *     its final text turn.
 *   - cross-owner skills with `cross-owner-allowed: false`.
 */

import type { Skill } from '../../../daemon/skills/types.js';
import { listSkillsByOwner } from '../../../daemon/skills/registry.js';

/**
 * Catalog summaries serve SELECTION only (which skill is relevant for
 * this section). The CALLING contract -- arg names, types, required
 * flags -- comes from the mandatory `skill_describe` step. Keep
 * summaries short: a one-clause verb-phrase is enough to pick a
 * skill, and trimming saves ~15 tokens per skill from the system
 * prompt which is re-sent on every iteration of the tool loop.
 */
const CATALOG_SUMMARY_MAX = 60;

export interface CatalogEntry {
	readonly id:      string;
	readonly family:  string;
	readonly summary: string;
}

export interface AnalyzerRepoContext {
	/** Detected ORM identifiers (e.g. `['sqlalchemy']`). Empty for repos with no ORM detected. */
	readonly detectedOrms?:  readonly string[] | undefined;
	/** Migration tool detected (e.g. `'alembic'`). Empty when no migration manifest was found. */
	readonly migrationTool?: string | undefined;
}

/**
 * Build the analyzer's skill catalog filtered to skills the LLM
 * may invoke via `skill_invoke`. Returns entries sorted by family
 * then id for stable prompts.
 */
export function buildAnalyzerSkillCatalog(repo: AnalyzerRepoContext): readonly CatalogEntry[] {
	const detectedOrms  = repo.detectedOrms  ?? [];
	const migrationTool = repo.migrationTool;
	const out: CatalogEntry[] = [];

	// listSkillsByOwner('code-analyzer') -- the analyzer's own skills.
	// Shared skills can be added later if cross-owner skills emerge.
	for (const skill of listSkillsByOwner('code-analyzer')) {
		// EXCLUDE the meta scaffolding -- tool loop replaces it.
		if (skill.family === 'meta') continue;
		// EXCLUDE synthesis renderers -- LLM produces markdown directly.
		if (skill.family === 'synthesis') continue;
		// Repo-capability gates (same as legacy classify-question's filter).
		if (!matchesRepoCapability(skill, detectedOrms, migrationTool)) continue;

		out.push({
			id:      skill.id,
			family:  skill.family,
			summary: truncate(skill.description, CATALOG_SUMMARY_MAX),
		});
	}
	out.sort((a, b) =>
		a.family !== b.family ? a.family.localeCompare(b.family) : a.id.localeCompare(b.id),
	);
	return out;
}

/**
 * Render the catalog as a Markdown block for the section-writer's
 * system prompt.
 *
 * Format:
 *   ## Available skills (call via `skill_invoke({ skillId, args })`)
 *   ### source-introspection
 *   - `code.source.repo.describe`     -- High-level repo summary: file/entity counts, ...
 *   - `code.source.module.describe`   -- Summarise a module (filesystem directory)...
 *   ### quality-profile
 *   - `code.quality.complexity`       -- Compute cyclomatic complexity for every function/method...
 *   ...
 */
export function formatAnalyzerSkillCatalog(catalog: readonly CatalogEntry[]): string {
	if (catalog.length === 0) {
		return '## Available skills\n(no skills available for this repo)';
	}
	const lines: string[] = [
		'## Available skills',
		'You MUST call `skill_describe({ id: <skillId> })` BEFORE `skill_invoke({ skillId, args })` for that skill.',
		'The tool loop rejects undescribed invocations. Describe-once-per-skill-per-section is enough.',
		'',
	];

	let currentFamily = '';
	for (const e of catalog) {
		if (e.family !== currentFamily) {
			if (currentFamily !== '') lines.push('');
			lines.push(`### ${e.family}`);
			currentFamily = e.family;
		}
		const padded = e.id.padEnd(34);
		lines.push(`- \`${padded}\` -- ${e.summary}`);
	}
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers (copied from code.meta.classify-question -- same precondition logic)
// ---------------------------------------------------------------------------

function matchesRepoCapability(
	skill: Skill,
	detectedOrms: readonly string[],
	migrationTool: string | undefined,
): boolean {
	if (skill.id.startsWith('code.orm.')       && detectedOrms.length === 0)                            return false;
	if (skill.id.startsWith('code.migration.') && (migrationTool === undefined || migrationTool.length === 0)) return false;
	return true;
}

function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…';
}
