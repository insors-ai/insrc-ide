/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Plan Builder types -- inputs, outputs, options, errors.
 *
 * See: design/analyze-plan-builder.md "Plan Task contract"
 *      design/analyze-plan-builder.md "Invariants the validator enforces"
 */

import type {
	AnalyzeTaskTemplate,
	ClassifiedIntent,
	PlanTask,
	PlannedTask,
} from '../../shared/analyze-types.js';
import type { AnalyzeContextBundle } from '../context/types.js';

/**
 * The Plan Builder's input. The Plan Builder runs after the
 * classifier + the run-level context shaper -- it consumes both
 * outputs.
 */
export interface PlanBuilderInput {
	readonly intent:        ClassifiedIntent;
	readonly contextBundle: AnalyzeContextBundle;
	/**
	 * The catalog of templates the planner may pick from. The
	 * planner validator's INV-3 / INV-4 / INV-5 / INV-6 / INV-8 /
	 * INV-12 dispatch on these.
	 */
	readonly catalog:       readonly AnalyzeTaskTemplate[];
	/**
	 * Optional parent-task path. Present iff this Plan is being
	 * built for a planner-template task in a parent Plan. The Plan
	 * Builder stamps this into `PlanTask.parentTaskPath`; the LLM
	 * does NOT emit it (INV-15).
	 */
	readonly parentTaskPath?: string;
	/**
	 * Current depth in the Plan tree (0 = root). The Plan Builder
	 * uses this against the root Run's `maxPlanDepth` config to
	 * decide whether to refuse a recursive invocation.
	 */
	readonly currentDepth?: number;
}

/** Plan Builder per-invocation options. */
export interface PlanBuilderOpts {
	readonly runId: string;
	/** Force-skip cache reads. Tests only. */
	readonly bypassCache?: boolean;
}

/**
 * Tagged-union response, mirroring AnalyzeRpcResponse so the
 * daemon RPC can pass it through verbatim.
 */
export type PlanBuilderResponse =
	| { readonly ok: true;  readonly plan: PlanTask }
	| { readonly ok: false; readonly error: PlanBuilderErrorPayload };

export interface PlanBuilderErrorPayload {
	readonly code:    PlanBuilderErrorCode;
	readonly message: string;
	readonly data?:   Readonly<Record<string, unknown>>;
}

/**
 * Stable error codes the orchestrator + IDE dispatch on. Invariant
 * codes (INV-XX) are NOT direct error codes -- the wrapper
 * `plan-invariant-failed` carries the invariant id in `data`.
 */
export type PlanBuilderErrorCode =
	| 'invalid-input'
	| 'plan-builder-llm-unavailable'
	| 'plan-builder-schema-unrecoverable'
	| 'plan-builder-exhausted'
	| 'plan-builder-prompt-missing'
	| 'max-plan-depth-exceeded'
	| 'internal-error';

/** Re-exports so consumers don't double-import. */
export type {
	AnalyzeTaskTemplate,
	ClassifiedIntent,
	PlanTask,
	PlannedTask,
} from '../../shared/analyze-types.js';
