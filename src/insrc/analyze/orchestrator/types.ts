/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Orchestrator types -- inputs, outputs, persisted-run shape, stages.
 *
 * The orchestrator drives the full analyze pipeline end-to-end:
 *   classify -> buildRunBundle -> runRecursivePlanner -> runExecutor
 *
 * Each stage's failure surfaces as a typed `RunFailure` with a stable
 * `code` so the daemon RPC + the UI can dispatch without peeking at
 * exception messages. The persisted RunRecord captures the run's
 * lifecycle on disk at <runRoot>/run.json so resume + UI know where
 * the run is.
 */

import type {
	AnalyzeScopeRef,
	ClassifiedIntent,
} from '../../shared/analyze-types.js';

// ---------------------------------------------------------------------------
// Stage identifiers
// ---------------------------------------------------------------------------

/** Stage in the orchestrator pipeline. Used by RunRecord.stage and
 *  by failure codes to indicate where a run gave up. */
export type RunStage =
	| 'classify'
	| 'plan'
	| 'execute'
	| 'done';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface RunAnalyzeArgs {
	readonly runId:      string;
	readonly userPrompt: string;
	/** Starting scope ref -- usually workspace; the classifier may
	 *  refine to a more specific repo / module / connection ref. */
	readonly scopeRef:   AnalyzeScopeRef;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Tagged-union top-level result. */
export type RunAnalyzeResult =
	| RunAnalyzeOk
	| RunAnalyzeFail;

export interface RunAnalyzeOk {
	readonly ok:             true;
	readonly runId:          string;
	readonly intent:         ClassifiedIntent;
	readonly finalReport:    unknown;
	readonly tasksCompleted: number;
	readonly tasksFailed:    ReadonlyArray<{ taskId: string; reason: string }>;
	readonly durationMs:     number;
}

export interface RunAnalyzeFail {
	readonly ok:        false;
	readonly runId:     string;
	readonly stage:     RunStage;
	readonly error:     RunFailure;
	/** Intent is present iff the classify stage completed; otherwise undefined. */
	readonly intent?:   ClassifiedIntent | undefined;
	readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Failure shape
// ---------------------------------------------------------------------------

export interface RunFailure {
	readonly code:    RunErrorCode;
	readonly message: string;
	readonly data?:   Readonly<Record<string, unknown>>;
}

/**
 * Stable error codes the daemon RPC + the IDE dispatch on.
 *
 * Per-stage codes pass through verbatim from the underlying stage's
 * typed error (classifier / shaper / planner / executor). The
 * orchestrator wraps unrecognised errors as `internal-error`.
 */
export type RunErrorCode =
	// classifier
	| 'classifier-llm-unavailable'
	| 'classifier-schema-unrecoverable'
	| 'classifier-validation-exhausted'
	| 'classifier-prompt-missing'
	| 'scope-ref-unresolved'
	| 'scope-ref-kind-target-mismatch'
	| 'invalid-input'
	// run-bundle shaper (mirrors analyze-rpc.ts error codes)
	| 'scope-not-indexed'
	| 'shaper-llm-unavailable'
	| 'shaper-tool-loop-exhausted'
	| 'shaper-schema-unrecoverable'
	| 'shaper-prompt-missing'
	// planner
	| 'plan-builder-llm-unavailable'
	| 'plan-builder-schema-unrecoverable'
	| 'plan-builder-prompt-missing'
	| 'plan-invariant-failed'
	| 'max-plan-depth-exceeded'
	// executor
	| 'executor-aggregator-failed'
	// catch-all
	| 'internal-error';

// ---------------------------------------------------------------------------
// Persisted run record (<runRoot>/run.json)
// ---------------------------------------------------------------------------

/**
 * The run's lifecycle record on disk. Updated at each stage transition
 * + at the terminal end (ok / failed). Atomic write via tmp+rename.
 */
export interface RunRecord {
	readonly runId:        string;
	readonly createdAt:    string;
	readonly updatedAt:    string;
	readonly userPrompt:   string;
	readonly initialScopeRef: AnalyzeScopeRef;
	readonly stage:        RunStage;
	readonly status:       'in-progress' | 'ok' | 'failed';
	/** Filled in after the classifier stage completes. */
	readonly intent?:      ClassifiedIntent | undefined;
	/** Filled in after the executor stage completes. */
	readonly finalReport?: unknown;
	/** Filled in when status='failed'. */
	readonly error?:       RunFailure | undefined;
	readonly tasksCompleted?: number | undefined;
	readonly tasksFailed?:    ReadonlyArray<{ taskId: string; reason: string }> | undefined;
}
