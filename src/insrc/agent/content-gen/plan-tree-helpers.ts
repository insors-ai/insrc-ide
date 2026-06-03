/**
 * Helpers wiring the skill-tree planner + executor into an analyzer
 * orchestrator (P6 of plans/planner-skill-tree.md).
 *
 *   - `buildCatalogFromRegistry`  -- enumerate the registry, pick the
 *                                     owners + families the planner may
 *                                     compose, hydrate inputs / outputPaths.
 *   - `buildDataAnalyzerFallbackTree` / `buildCodeAnalyzerFallbackTree`
 *                                  -- typed single-leaf trees pointing at
 *                                     the L2 `<owner>.answer-question`
 *                                     skill for the degraded-planning
 *                                     escape hatch.
 *   - `renderTreeReport`           -- stitch the executor's outputs into
 *                                     a final markdown report.
 *
 * These helpers stay decoupled from the controller/session machinery:
 * the orchestrator passes in the registry-shaped data + the user
 * request, the helpers return ready-to-use objects.
 */

import { listSkills } from '../../daemon/skills/index.js';
import { getSkillOutputPaths } from '../../daemon/skills/registry.js';
import { stitchTreeSections, type TreeExecutionResult } from '../../daemon/skills/tree/executor.js';
import {
	validatePlannedTree,
	type PlannedTree,
} from './plan-tree.js';
import type { CatalogSkill } from './plan-tree-runner.js';
import type { Skill, SkillOwner } from '../../daemon/skills/types.js';

// ---------------------------------------------------------------------------
// Catalog: registry -> CatalogSkill[]
// ---------------------------------------------------------------------------

export interface CatalogBuildOpts {
	/** Owners whose skills are eligible for the planner's pool. */
	readonly owners: readonly SkillOwner[];
	/**
	 * When true, include the L2 `<owner>.answer-question` skills as
	 * candidates the planner can pick as fallback leaves. Default true.
	 */
	readonly includeL2Fallback?: boolean | undefined;
	/**
	 * When provided, drop skills whose `connection-family` preconditions
	 * don't match any roster family. Used by the data side to skip,
	 * e.g., rdbms-family skills when only file connections exist.
	 */
	readonly rosterFamilies?: ReadonlySet<string> | undefined;
}

export function buildCatalogFromRegistry(opts: CatalogBuildOpts): readonly CatalogSkill[] {
	const ownerSet = new Set(opts.owners);
	const includeL2 = opts.includeL2Fallback ?? true;
	const out: CatalogSkill[] = [];
	for (const skill of listSkills()) {
		if (!ownerSet.has(skill.owner)) continue;
		// Drop the meta skills -- they're internal classify/select-scope
		// machinery the L2 fallback uses, never composable by the planner.
		if (skill.family === 'meta' && !isL2AnswerQuestion(skill)) continue;
		// Drop the L2 answer-question skills unless explicitly included.
		if (isL2AnswerQuestion(skill) && !includeL2) continue;
		// Connection-family filter (data side).
		if (opts.rosterFamilies !== undefined && !matchesRosterFamilies(skill, opts.rosterFamilies)) continue;

		out.push({
			id:          skill.id,
			description: skill.description,
			family:      skill.family,
			owner:       skill.owner,
			inputs:      skill.inputs,
			outputPaths: getSkillOutputPaths(skill.id),
		});
	}
	return out;
}

function isL2AnswerQuestion(skill: Skill): boolean {
	return skill.id === 'data.answer-question' || skill.id === 'code.answer-question';
}

function matchesRosterFamilies(skill: Skill, rosterFamilies: ReadonlySet<string>): boolean {
	const fams = (skill.preconditions ?? [])
		.filter((p): p is Extract<typeof p, { kind: 'connection-family' }> => p.kind === 'connection-family')
		.flatMap(p => [...p.families]);
	if (fams.length === 0) return true;                        // no constraint -> any roster works
	return fams.some(f => rosterFamilies.has(f));
}

// ---------------------------------------------------------------------------
// Fallback trees -- single L2 leaf for degraded planning
// ---------------------------------------------------------------------------

export interface DataFallbackOpts {
	readonly request:           string;
	readonly connections:       readonly Readonly<Record<string, unknown>>[];
	readonly priorContext?:     Readonly<Record<string, unknown>> | undefined;
}

export function buildDataAnalyzerFallbackTree(opts: DataFallbackOpts): PlannedTree {
	const tree = {
		intentBrief: 'Fallback: L2 data dispatcher (planner could not compose a tree).',
		root: {
			id:        'fallback',
			title:     'Analysis (fallback)',
			objective: 'Single L2 dispatch over the full user question; the planner failed to decompose into a typed tree.',
			kind:      'leaf' as const,
			skill:     'data.answer-question',
			emit:      'section' as const,
			inputs: {
				question:    { source: 'literal' as const, value: opts.request },
				connections: { source: 'literal' as const, value: opts.connections },
				...(opts.priorContext !== undefined
					? { priorContext: { source: 'literal' as const, value: opts.priorContext } }
					: {}),
			},
		},
	};
	const validated = validatePlannedTree(tree);
	if (typeof validated === 'string') {
		throw new Error(`buildDataAnalyzerFallbackTree: produced an invalid tree: ${validated}`);
	}
	return validated;
}

export interface CodeFallbackOpts {
	readonly request:        string;
	readonly activeRepoPath: string;
	readonly scopeTier:      'S' | 'M' | 'L' | 'XL';
	readonly repoMeta?:      Readonly<Record<string, unknown>> | undefined;
}

export function buildCodeAnalyzerFallbackTree(opts: CodeFallbackOpts): PlannedTree {
	const tree = {
		intentBrief: 'Fallback: L2 code dispatcher (planner could not compose a tree).',
		root: {
			id:        'fallback',
			title:     'Analysis (fallback)',
			objective: 'Single L2 dispatch over the full user question; the planner failed to decompose into a typed tree.',
			kind:      'leaf' as const,
			skill:     'code.answer-question',
			emit:      'section' as const,
			inputs: {
				question:       { source: 'literal' as const, value: opts.request },
				activeRepoPath: { source: 'literal' as const, value: opts.activeRepoPath },
				scopeTier:      { source: 'literal' as const, value: opts.scopeTier },
				...(opts.repoMeta !== undefined
					? { repoMeta: { source: 'literal' as const, value: opts.repoMeta } }
					: {}),
			},
		},
	};
	const validated = validatePlannedTree(tree);
	if (typeof validated === 'string') {
		throw new Error(`buildCodeAnalyzerFallbackTree: produced an invalid tree: ${validated}`);
	}
	return validated;
}

// ---------------------------------------------------------------------------
// Report rendering -- stitched sections + report-level wrapper
// ---------------------------------------------------------------------------

export interface TreeReportInput {
	readonly tree:    PlannedTree;
	readonly result:  TreeExecutionResult;
	/** Headline (typically the user request, rendered as a prefix paragraph). */
	readonly headline: string;
	/**
	 * Optional drill-down block appended at the tail (today's analyzers
	 * emit a "Drill down" placeholder when the planner didn't propose
	 * follow-ups; preserved for UX continuity).
	 */
	readonly drillDownNote?: string | undefined;
}

export function renderTreeReport(input: TreeReportInput): string {
	const stitched = stitchTreeSections(input.tree, input.result);
	const lines: string[] = [];

	lines.push(input.headline.trim());
	lines.push('');

	for (const section of stitched.sections) {
		lines.push(`## ${section.title}`);
		lines.push('');
		const body = section.markdown.trimEnd();
		lines.push(body.length > 0 ? body : '*(empty section)*');
		lines.push('');
	}

	if (stitched.notes.length > 0) {
		lines.push('---');
		lines.push('');
		lines.push('**Planner notes:**');
		for (const n of stitched.notes) lines.push(`- ${n}`);
		lines.push('');
	}

	if (input.drillDownNote !== undefined && input.drillDownNote.length > 0) {
		lines.push('## Drill down');
		lines.push('');
		lines.push(input.drillDownNote);
	}

	return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}
