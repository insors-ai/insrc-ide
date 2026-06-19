/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Type surface for the /plan meta-task template (M4.a Phase 2).
 *
 * The legacy `src/insrc/agent/planner/types.ts` stays the canonical
 * source of truth for `Plan<T>` / `Step<T>` / status enums. This file
 * re-exports those shapes so consumers (the template internals, future
 * M4.b call sites) have ONE import path going forward and the legacy
 * directory stays untouched until M4.b deletes it.
 *
 * Adds the new `PlanCategory` closed-enum taxonomy from
 * design/meta-task-plan.html §9 O2 (resolved). The top-level category
 * is a hard enum the cloud LLM must emit; sub-category is freeform but
 * validated client-side against a per-category whitelist.
 */

// ---------------------------------------------------------------------------
// Re-exports (legacy)
// ---------------------------------------------------------------------------

export type {
	Plan,
	Step,
	StepStatus,
	PlanStatus,
	PlanMetadata,
	StatusTransition,
	ImplementationStepData,
	TestStepData,
	MigrationStepData,
	ImplementationPlan,
	TestPlan,
	MigrationPlan,
	ProgressSummary,
} from '../../agent/planner/types.js';


// ---------------------------------------------------------------------------
// New: two-level plan taxonomy (design O2 resolved)
// ---------------------------------------------------------------------------

/**
 * Closed-enum top-level plan category. The cloud LLM's P1 analyze output
 * MUST emit one of these values; an unknown category is a schema-level
 * rejection (no `other` escape hatch -- if classification consistently
 * misfires for a real use-case, add a 7th category here rather than hide
 * it under `other`).
 */
export type PlanCategory =
	| 'implementation'
	| 'migration'
	| 'test'
	| 'documentation'
	| 'operational'
	| 'design';

export const PLAN_CATEGORIES: readonly PlanCategory[] = [
	'implementation',
	'migration',
	'test',
	'documentation',
	'operational',
	'design',
] as const;

/**
 * Per-category sub-category whitelist. The cloud LLM may emit a freeform
 * sub-category; the template's helpers validate against this map and
 * reject mismatches. New sub-categories land here when they emerge from
 * real usage.
 */
export const PLAN_SUB_CATEGORIES: Readonly<Record<PlanCategory, readonly string[]>> = {
	implementation: ['new-feature', 'bugfix', 'refactor', 'integration', 'performance'],
	migration:      ['data-migration', 'platform-migration', 'framework-upgrade', 'language-port'],
	test:           ['unit', 'integration', 'e2e', 'regression-suite'],
	documentation:  ['api-docs', 'runbook', 'architecture-doc', 'adr'],
	operational:    ['deployment', 'incident-response', 'monitoring', 'cleanup'],
	design:         ['system-design', 'api-design', 'ux-design', 'database-schema'],
};

export function isPlanCategory(s: unknown): s is PlanCategory {
	return typeof s === 'string' && (PLAN_CATEGORIES as readonly string[]).includes(s);
}

export function isValidSubCategory(category: PlanCategory, sub: string): boolean {
	return PLAN_SUB_CATEGORIES[category].includes(sub);
}

/**
 * Shape the P1 analyze step's deliverable body is required to JSON-parse
 * into. The cloud LLM is prompted to emit JSON matching this shape; the
 * template's `validateAnalysisShape` helper enforces it before any
 * downstream step reads from the deliverable.
 */
export interface PlanAnalysis {
	readonly category:    PlanCategory;
	readonly subCategory: string;
	readonly goals:       readonly string[];
	readonly constraints: readonly string[];
	readonly scope:       string;
}
