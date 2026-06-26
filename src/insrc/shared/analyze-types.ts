/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cross-module structural types for the analyze framework.
 *
 * These shapes are CONSUMED by the Context Builder (this PR) and
 * PRODUCED by downstream modules that haven't been written yet:
 *   - ClassifiedIntent       -> produced by the classifier (next PR)
 *   - PlannedTask            -> produced by the Plan Builder
 *   - AnalyzeTaskTemplate    -> declared in the template registry
 *
 * Keeping the types here -- in shared/ rather than in any individual
 * module -- lets the Context Builder accept them by interface without
 * pulling in dependencies on modules that don't exist yet, and lets
 * each producer module tighten the type later (e.g. the classifier
 * will add validation predicates; the template registry will widen
 * the inputSchema field) without forcing the Context Builder to
 * re-import from a different path.
 *
 * See: design/analyze-framework.md
 */

/** Per-target dispatch key. Mirrors design/analyze-framework.md "Intent". */
export type AnalyzeTarget = 'code' | 'data' | 'infra' | 'generic';

/** Scope buckets (INVERTED depth policy -- XL is structural, XS is detailed). */
export type AnalyzeScope = 'XS' | 'S' | 'M' | 'L' | 'XL';

/** What the user pointed at. */
export interface AnalyzeScopeRef {
	readonly kind:
		| 'repo'
		| 'module'
		| 'file'
		| 'symbol'
		| 'connection'
		| 'manifest-dir'
		| 'workspace';
	readonly value: string;
}

/**
 * Classifier output. The Context Builder's run + task modes consume
 * this; the classifier itself produces it. Structural only -- the
 * classifier may add validation predicates (e.g. a `validate()` method
 * or a Zod schema) once it lands.
 */
export interface ClassifiedIntent {
	readonly target:    AnalyzeTarget;
	readonly scope:     AnalyzeScope;
	readonly focused:   boolean;
	readonly focus?:    string;
	readonly scopeRef:  AnalyzeScopeRef;
	readonly reasoning: string;
}

/**
 * Plan Builder output -- one entry per task in a flat-per-Plan list.
 * See design/analyze-plan-builder.md "Plan Task contract".
 *
 * `taskPath` is computed by the executor at scheduling time (not by
 * the planner), so it is optional at plan-emit time. The 15
 * invariants validator does NOT enforce taskPath.
 */
export interface PlannedTask {
	readonly taskId:    string;
	readonly taskPath?: string;
	readonly template:  string;
	readonly kind:      'leaf' | 'planner';
	readonly params:    Readonly<Record<string, unknown>>;
	readonly produces:  readonly string[];
	readonly consumes?: readonly string[];
	readonly rationale: string;
}

/**
 * The Plan Builder's top-level output -- one Plan in the recursive
 * Plan tree. Every Plan is flat (no nested tasks); recursion happens
 * by selecting a `kind: 'planner'` task whose execution spawns a
 * child Plan at runtime.
 *
 * See design/analyze-plan-builder.md "Plan Task contract".
 */
export interface PlanTask {
	readonly planId:          string;
	readonly parentTaskPath?: string;
	readonly goal:            string;
	readonly target:          AnalyzeTarget;
	readonly scope:           AnalyzeScope;
	readonly tasks:           readonly PlannedTask[];
	readonly reasoning:       string;
}

/**
 * Template registry entry. The Plan Builder picks tasks from a
 * catalog of these; the Context Builder uses the identifier fields
 * for task-mode bundle staging.
 *
 * The planner-relevant fields (`description`, `inputSchema`,
 * `produces`, `outputSchema`, `isAggregator`) are populated by the
 * template registry once it lands; per-template modules export these
 * directly. They are optional in the type so consumers that only
 * need identification (shaper task-mode) don't need to construct a
 * full template.
 */
export interface AnalyzeTaskTemplate {
	readonly id:       string;
	readonly target:   AnalyzeTarget;
	readonly family:   string;
	readonly kind:     'leaf' | 'planner';
	readonly revision: string;

	/** One-sentence human-readable summary the planner sees. */
	readonly description?: string;
	/** JSON Schema for the task's `params`. Planner emits params, validator runs ajv against this. */
	readonly inputSchema?: Readonly<Record<string, unknown>>;
	/** Names of outputs this task produces. Planner's `produces` must equal this set. */
	readonly produces?: readonly string[];
	/** JSON Schema for each output; consumed by aggregator + per-task validators. */
	readonly outputSchema?: Readonly<Record<string, unknown>>;
	/**
	 * Marks the per-target terminal aggregator (one per target). The
	 * Plan validator's "exactly one aggregator, must be last" rule
	 * dispatches on this flag.
	 */
	readonly isAggregator?: boolean;
}
