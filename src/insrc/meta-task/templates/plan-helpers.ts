/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Helpers for the /plan meta-task template (M4.a Phase 2).
 *
 * Ports the private helpers from the legacy `src/insrc/agent/planner/steps.ts`
 * file's bottom half so the new template doesn't reach into the legacy
 * module's internals. The legacy file stays unmodified per the design
 * non-goal; helpers are duplicated here, not re-exported.
 *
 * Adapted for the M4.a contract:
 *   - `buildPlan` accepts the new `PlanCategory` instead of the legacy
 *     `InferredPlanType` (which was a less-strict union). Category drives
 *     the plan's `description` field for now; sub-category isn't surfaced
 *     in the legacy Plan shape (P5/P6 read it from the P1 deliverable
 *     directly when category-specific enrichment is needed).
 *   - `validateAnalysisShape` is new -- enforces the closed-enum
 *     PlanCategory + per-category sub-category whitelist from
 *     design O2 (resolved). The default phase-2 path's framework-wide
 *     `Phase2Out` validator only enforces the envelope shape; the
 *     per-step body validation is the template's job.
 */

import { generateId } from '../../agent/planner/utils.js';
import type { Plan, Step } from './plan-types.js';
import {
	PLAN_CATEGORIES,
	type PlanAnalysis,
	type PlanCategory,
	isPlanCategory,
	isValidSubCategory,
} from './plan-types.js';


// ---------------------------------------------------------------------------
// RawStep -- the cloud LLM's per-step output shape (P3 draft + P5 detail
// references via stepIndex). Matches the legacy planner's contract verbatim
// so prompts can be reused.
// ---------------------------------------------------------------------------

export interface RawStep {
	readonly title:        string;
	readonly description:  string;
	readonly checkpoint?:  boolean | undefined;
	readonly complexity?:  string | undefined;
	readonly dependsOnIdx?: readonly number[] | undefined;
	readonly fileHint?:    string | undefined;
}


// ---------------------------------------------------------------------------
// Parsing helpers (ported from legacy steps.ts)
// ---------------------------------------------------------------------------

/**
 * Pull a JSON array of `RawStep` out of the cloud LLM's response. Handles:
 *   - Plain JSON arrays
 *   - JSON wrapped in ``` or ```json fences
 *   - JSON embedded in surrounding markdown text
 *
 * Falls back to a single-step plan with the raw text as the description if
 * parsing fails (matches legacy behaviour).
 */
export function parseStepsJson(text: string): RawStep[] {
	let jsonStr = text.trim();

	// Strip markdown code fences.
	const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fenceMatch) {
		jsonStr = fenceMatch[1]!.trim();
	}

	// Find JSON array within the remaining string.
	const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
	if (arrayMatch) {
		jsonStr = arrayMatch[0]!;
	}

	try {
		const parsed = JSON.parse(jsonStr) as unknown;
		if (!Array.isArray(parsed)) { return []; }
		return parsed.filter(
			(item): item is RawStep =>
				typeof item === 'object' && item !== null && 'title' in item,
		);
	} catch {
		return [{
			title:        'Implementation',
			description:  text.slice(0, 500),
			checkpoint:   false,
			complexity:   'medium',
			dependsOnIdx: [],
		}];
	}
}

/**
 * Extract a JSON object / array from a possibly-noisy cloud response. Used
 * by P1 analyze + P5 detail before parsing.
 */
export function extractJson(text: string): string {
	const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fenceMatch) { return fenceMatch[1]!.trim(); }

	const objMatch = text.match(/\{[\s\S]*\}/);
	if (objMatch) { return objMatch[0]!; }

	const arrMatch = text.match(/\[[\s\S]*\]/);
	if (arrMatch) { return arrMatch[0]!; }

	return text;
}


// ---------------------------------------------------------------------------
// P1 analysis shape validator (new for M4.a)
// ---------------------------------------------------------------------------

export type AnalysisValidation =
	| { readonly ok: true;  readonly value: PlanAnalysis }
	| { readonly ok: false; readonly errors: readonly string[] };

/**
 * Validate the P1 analyze deliverable body against the closed-enum
 * PlanCategory + sub-category whitelist (design O2 resolved). The cloud
 * LLM is prompted to emit the exact shape; this rejects schema drift.
 */
export function validateAnalysisShape(raw: unknown): AnalysisValidation {
	const errors: string[] = [];
	if (typeof raw !== 'object' || raw === null) {
		return { ok: false, errors: ['analysis must be an object'] };
	}
	const r = raw as Record<string, unknown>;

	if (!isPlanCategory(r['category'])) {
		errors.push(`category: must be one of ${PLAN_CATEGORIES.join(' | ')}; got ${JSON.stringify(r['category'])}`);
	}
	if (typeof r['subCategory'] !== 'string' || r['subCategory'].length === 0) {
		errors.push('subCategory: required non-empty string');
	}
	if (errors.length === 0) {
		// We know category is a PlanCategory now.
		const cat = r['category'] as PlanCategory;
		const sub = r['subCategory'] as string;
		if (!isValidSubCategory(cat, sub)) {
			errors.push(`subCategory '${sub}' not valid for category '${cat}'`);
		}
	}
	if (!Array.isArray(r['goals']) || r['goals'].some(g => typeof g !== 'string')) {
		errors.push('goals: required string[]');
	}
	if (!Array.isArray(r['constraints']) || r['constraints'].some(c => typeof c !== 'string')) {
		errors.push('constraints: required string[]');
	}
	if (typeof r['scope'] !== 'string' || r['scope'].length === 0) {
		errors.push('scope: required non-empty string');
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}
	return {
		ok:    true,
		value: {
			category:    r['category'] as PlanCategory,
			subCategory: r['subCategory'] as string,
			goals:       (r['goals']       as string[]).slice(),
			constraints: (r['constraints'] as string[]).slice(),
			scope:       r['scope']        as string,
		},
	};
}


// ---------------------------------------------------------------------------
// buildPlan -- ported from legacy steps.ts, adapted to PlanCategory
// ---------------------------------------------------------------------------

/**
 * Build a typed `Plan` from a `RawStep[]` array. Step ids are deterministic
 * within the plan (uuid per step); cross-step `dependsOnIdx` references are
 * resolved to step ids; self-dependencies and out-of-range indices are
 * silently dropped (matches legacy behaviour).
 */
export function buildPlan(
	repoPath: string,
	title:    string,
	rawSteps: readonly RawStep[],
	category: PlanCategory,
): Plan {
	const now    = new Date().toISOString();
	const planId = generateId();
	const stepIds = rawSteps.map(() => generateId());

	const steps: Step[] = rawSteps.map((raw, idx) => ({
		id:    stepIds[idx]!,
		title: raw.title,
		description: raw.description,
		status: 'pending' as const,
		dependencies: (raw.dependsOnIdx ?? [])
			.filter(i => i >= 0 && i < stepIds.length && i !== idx)
			.map(i => stepIds[i]!),
		...(raw.fileHint ? { notes: `File: ${raw.fileHint}` } : {}),
		metadata: { createdAt: now, updatedAt: now },
	}));

	return {
		id:          planId,
		repoPath,
		title:       title.slice(0, 200),
		description: `${category} plan`,
		status:      'active',
		steps,
		metadata:    { createdAt: now, updatedAt: now },
	};
}
