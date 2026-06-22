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
 * Structural only; the Plan Builder will own the validator that
 * enforces the 15 invariants (see design/analyze-plan-builder.md).
 */
export interface PlannedTask {
	readonly taskId:             string;
	readonly template:           string;
	readonly params:             Readonly<Record<string, unknown>>;
	readonly outputs:            readonly string[];
	readonly dependsOnOutputs?:  readonly string[];
}

/**
 * Template registry entry -- structural only. The real template
 * registry will widen this with `kind`, `preconditions`,
 * `crossTargetDependencies`, `inputSchema`, `outputSchema`,
 * `prompt` fields per design/analyze-framework.md "Template
 * definition". The Context Builder only needs the identifier
 * fields for task-mode bundle staging.
 */
export interface AnalyzeTaskTemplate {
	readonly id:       string;
	readonly target:   AnalyzeTarget;
	readonly family:   string;
	readonly kind:     'leaf' | 'planner';
	readonly revision: string;
}
