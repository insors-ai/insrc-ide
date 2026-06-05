/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Section-flow orchestrator types
 * (planner-section-task-separation P2).
 *
 * The section-flow is the new top-level pipeline: Step 1 (Scope) ->
 * Step 2 (Investigation Plan) -> Step 3 (per-TODO section orchestrator,
 * landing in P3) -> Step 4 (final report assembler, landing in P4).
 *
 * This file holds the shared types; the step implementations live in
 * siblings. Both step modules are pure async functions so they can be
 * unit-tested without spinning up the AgentStep framework; the
 * orchestrator wraps them as framework steps in P5.
 */

import type { ScopeSize } from '../../shared/classify.js';
import type { AnalysisSubtype } from '../classify/scope.js';

// ---------------------------------------------------------------------------
// Context references
// ---------------------------------------------------------------------------

/**
 * A concrete pointer the planner should look at -- a file path, a
 * directory, a code identifier, or a free-form concept the user
 * mentioned. Distinguished from generic prose by both `kind` (so the
 * downstream planner picks the right tools) and `origin` (so it knows
 * whether the user explicitly named the ref vs we inferred it).
 */
export interface ContextRef {
	readonly kind:   'file' | 'dir' | 'symbol' | 'concept';
	readonly value:  string;
	readonly origin: 'user-mention' | 'inferred';
}

// ---------------------------------------------------------------------------
// Step 1 -- Scope
// ---------------------------------------------------------------------------

export interface ScopeStepResult {
	readonly scope:       ScopeSize;
	readonly subtype:     AnalysisSubtype;
	readonly contextRefs: readonly ContextRef[];
	/**
	 * True when the request is single-shot fast-path-eligible per Q4:
	 * one focused contextRef + S scope. Step 2 emits a single-TODO plan
	 * with a single-leaf section hint when this is set.
	 */
	readonly isTrivial:   boolean;
	readonly reasoning:   string;
	/** Free-form trace string for telemetry; never user-facing. */
	readonly fallback:    boolean;
}

// ---------------------------------------------------------------------------
// Step 2 -- Investigation plan
// ---------------------------------------------------------------------------

/**
 * One row in the flat investigation plan. Each TODO will typically
 * map to one section in the final report (Q1 -- the planner-section-
 * task-separation thesis).
 *
 * Identifiers are stable kebab-case strings the orchestrator threads
 * through working memory and the TodoList workbench rendering.
 */
export interface TodoSpec {
	readonly id:        string;
	readonly objective: string;
	/**
	 * `'initial'` covers everything in the original Step 2 emission.
	 * `'report-review-escalation'` covers TODOs that the report
	 * reviewer (Q7) appends mid-run to close a scope gap. The
	 * orchestrator stamps the origin badge at emit time so the
	 * TodoList renderer (Q8) can distinguish them.
	 */
	readonly origin:    'initial' | 'report-review-escalation';
}

export interface InvestigationPlanResult {
	readonly todos:     readonly TodoSpec[];
	readonly reasoning: string;
	/**
	 * True when the plan is the fast-path single-TODO emission
	 * (scopeResult.isTrivial). Lets the orchestrator skip per-TODO
	 * setup that doesn't apply to a one-leaf section tree.
	 */
	readonly isFastPath: boolean;
	/** Whether the planner needed a corrective retry to pass validation. */
	readonly retried:   boolean;
}

// ---------------------------------------------------------------------------
// Shared section-flow state (used by the eventual orchestrator in P5)
// ---------------------------------------------------------------------------

/**
 * Top-level state carried across the four steps. The orchestrator
 * checkpoint structure (Q9) writes this between steps so a daemon
 * restart can resume at the last successful step boundary.
 */
export interface SectionFlowState {
	readonly question: string;
	/** Intent id resolved upstream via the single-funnel `resolveIntent`. */
	readonly intent:   string;

	scope?:             ScopeStepResult            | undefined;
	investigationPlan?: InvestigationPlanResult    | undefined;

	/** Working-memory run id (per Q9; opaque to the user-facing TodoList). */
	workingMemoryRunId?: string                    | undefined;
	currentTodoIndex?:   number                    | undefined;
	completedTodoIds?:   readonly string[]         | undefined;

	finalReport?:       string                     | undefined;
}
