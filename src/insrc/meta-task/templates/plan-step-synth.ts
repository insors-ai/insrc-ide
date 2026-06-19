/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * P6 synth -- deterministic Phase2Runner for the /plan meta-task
 * template (M4.a Phase 3).
 *
 * No cloud LLM call. Assembles the final `Plan<T>` from the prior
 * steps' deliverables and emits round-trippable markdown via the
 * legacy `toMarkdown` serializer. This IS the template's deliverable
 * contract per design §5: the synthesis body is what consumers
 * (Delegate, CLI, future external integrations) parse back via
 * `fromMarkdown`.
 *
 *   - Reads P1 analyze (category + sub-category + scope) so the plan's
 *     `description` reflects the real category.
 *   - Reads P3 draft -- the validated step list. Re-runs through
 *     `parseStepsJson` + `buildPlan` to produce typed Steps.
 *   - Reads P5 detail and merges its enrichments per stepIndex into
 *     `step.data`. Skips the merge when the body equals the
 *     `(skipped)` sentinel (generic plans whose category lacks a
 *     domain schema).
 *   - Falls back to `'implementation'` category when P1's analysis is
 *     missing or unparseable -- the orchestrator's prior steps should
 *     prevent this, but a defensive default lets the synth still
 *     produce a usable plan rather than aborting the meta-task.
 */

import { toMarkdown } from '../../agent/planner/markdown.js';
import type { Phase2Runner } from '../types.js';
import { buildPlan, extractJson, parseStepsJson, validateAnalysisShape } from './plan-helpers.js';
import { PLAN_DETAIL_SKIPPED_SENTINEL } from './plan-prompts.js';
import type { PlanCategory } from './plan-types.js';


const P1_ANALYZE_STEP_INDEX = 1;
const P3_DRAFT_STEP_INDEX   = 3;
const P5_DETAIL_STEP_INDEX  = 5;


interface DetailEnrichment {
	readonly stepIndex: number;
	readonly data:      unknown;
}


/**
 * Parse P1 analyze body -> { category, subCategory, ... }. On failure
 * returns `'implementation'` as a defensive default.
 */
function extractCategoryFromP1(p1Body: string | undefined): PlanCategory {
	if (p1Body === undefined) { return 'implementation'; }
	const jsonStr = extractJson(p1Body);
	try {
		const parsed = JSON.parse(jsonStr) as unknown;
		const v = validateAnalysisShape(parsed);
		if (v.ok) { return v.value.category; }
	} catch { /* swallow */ }
	return 'implementation';
}


function extractTitleFromP1(p1Body: string | undefined, fallback: string): string {
	if (p1Body === undefined) { return fallback; }
	const jsonStr = extractJson(p1Body);
	try {
		const parsed = JSON.parse(jsonStr) as unknown;
		const v = validateAnalysisShape(parsed);
		if (v.ok && v.value.goals.length > 0) {
			// Use the first goal as a friendly title fallback for the plan header.
			return v.value.goals[0]!;
		}
	} catch { /* swallow */ }
	return fallback;
}


/**
 * Parse P5 detail body -> per-step enrichments. Returns null when P5
 * emitted the skip sentinel; returns [] when the body is malformed
 * (treated as "no enrichments").
 */
function parseDetailEnrichments(p5Body: string | undefined): readonly DetailEnrichment[] | null {
	if (p5Body === undefined) { return []; }
	if (p5Body.trim() === PLAN_DETAIL_SKIPPED_SENTINEL) { return null; }

	const jsonStr = extractJson(p5Body);
	try {
		const parsed = JSON.parse(jsonStr) as unknown;
		if (!Array.isArray(parsed)) { return []; }
		return parsed.filter(
			(e): e is DetailEnrichment =>
				typeof e === 'object' && e !== null
				&& typeof (e as { stepIndex?: unknown }).stepIndex === 'number',
		);
	} catch {
		return [];
	}
}


export const planSynthRunner: Phase2Runner = async (ctx) => {
	const draftBody = ctx.deliverables.get(P3_DRAFT_STEP_INDEX);
	if (draftBody === undefined) {
		return {
			kind:       'abort',
			resolution: 'user-required',
			reason:     `P6 synth: missing P3 draft deliverable at stepIndex ${P3_DRAFT_STEP_INDEX} -- orchestrator state corrupt`,
		};
	}

	const rawSteps = parseStepsJson(draftBody);
	if (rawSteps.length === 0) {
		return {
			kind:       'abort',
			resolution: 'plan-revisable',
			reason:     'P6 synth: P3 draft produced zero steps',
			hint:       'Re-run /plan with a sharper intent or split into smaller plans.',
		};
	}

	const p1Body   = ctx.deliverables.get(P1_ANALYZE_STEP_INDEX);
	const p5Body   = ctx.deliverables.get(P5_DETAIL_STEP_INDEX);
	const category = extractCategoryFromP1(p1Body);
	const title    = extractTitleFromP1(p1Body, 'Plan');

	// Build the typed Plan.
	const plan = buildPlan(ctx.stepDesc.providerBinding ?? '<workspace>', title, rawSteps, category);

	// Merge P5 enrichments. The legacy planner stored enrichment under
	// `step.data` keyed by stepIndex; we mirror that here.
	const enrichments = parseDetailEnrichments(p5Body);
	if (enrichments !== null) {
		// Mutable in-place merge -- the Plan we just built isn't shared.
		for (const e of enrichments) {
			const idx = e.stepIndex;
			if (idx >= 0 && idx < plan.steps.length) {
				(plan.steps[idx] as { data?: unknown }).data = e.data;
			}
		}
	}

	// Serialize. toMarkdown produces YAML frontmatter + checklist body; the
	// result IS the round-trippable deliverable contract per design §5.
	const markdown = toMarkdown(plan);
	return { kind: 'deliverable', body: markdown };
};
