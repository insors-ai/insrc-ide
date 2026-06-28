/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Orchestrator -- the analyze pipeline's end-to-end driver.
 *
 * Flow:
 *   1. classify(userPrompt, scopeRef)               -> ClassifiedIntent
 *   2. shaperFor('run', intent.target)
 *        .buildRunBundle({intent}, {runId})         -> ContextBundle
 *   3. runRecursivePlanner({input, opts})           -> PlanTreeNode
 *   4. runExecutor({tree, intent, runId})           -> ExecutorResult
 *
 * Each stage transition patches <runRoot>/run.json so resume + the
 * IDE can observe progress. Typed errors from each stage map to
 * stable RunErrorCode values; the orchestrator never papers over an
 * underlying error -- it wraps + persists + returns a tagged-union
 * failure.
 *
 * Skipped intentionally in this revision (separate phases):
 *   - workspace warnings + clarify step (between classify + plan)
 *   - resume: if <runRoot>/run.json shows stage='done' or has a
 *     stale failure, the driver currently re-runs from scratch
 *   - analyze.run.start IPC (this driver is the in-process API;
 *     the RPC layer is one wrapper call away)
 */

import { getLogger } from '../../shared/logger.js';

import { classify } from '../classifier/index.js';
import {
	ClassifierLlmUnavailableError,
	ClassifierPromptMissingError,
	ClassifierSchemaUnrecoverable,
	ClassifierValidationExhausted,
} from '../classifier/driver.js';
import { shaperFor } from '../context/index.js';
import {
	ShaperLlmUnavailableError,
	ShaperPromptMissingError,
	ShaperSchemaUnrecoverable,
	ShaperToolLoopExhausted,
} from '../context/driver.js';
import { ScopeNotIndexedError } from '../context/invariants.js';
import {
	getTemplatesForTarget,
	MaxPlanDepthExceededError,
	PlanBuilderExhausted,
	PlanBuilderLlmUnavailableError,
	PlanBuilderPromptMissingError,
	PlanBuilderSchemaUnrecoverable,
	runRecursivePlanner,
} from '../planner/index.js';
import { runExecutor } from '../executor/index.js';

import { readRunRecord, writeRunRecord } from './persistence.js';
import type {
	RunAnalyzeArgs,
	RunAnalyzeResult,
	RunFailure,
	RunRecord,
	RunStage,
} from './types.js';
import type { ClassifiedIntent } from '../../shared/analyze-types.js';

const log = getLogger('analyze:orchestrator:driver');

// ---------------------------------------------------------------------------
// runAnalyze -- public entry point
// ---------------------------------------------------------------------------

export async function runAnalyze(args: RunAnalyzeArgs): Promise<RunAnalyzeResult> {
	const start = Date.now();
	const { runId, userPrompt, scopeRef: initialScopeRef } = args;

	// (resume) If <runRoot>/run.json shows a previously-completed run
	// (status='ok' + stage='done' + intent + finalReport all present),
	// short-circuit and return the cached result. The within-stage caches
	// (shaper bundle cache, planner cache, executor per-task cache)
	// already make individual re-runs cheap, but this whole-pipeline
	// short-circuit makes idempotent re-invocations near-instant.
	//
	// Stale records (status='failed' OR status='in-progress' from a
	// crashed run) intentionally do NOT short-circuit -- callers
	// re-invoking with the same runId after a failure want a retry,
	// and an interrupted run needs to redo whichever stage was running
	// when the daemon died. The initial-write below overwrites the
	// stale record.
	const cached = readRunRecord(runId);
	if (
		cached !== null
		&& cached.status === 'ok'
		&& cached.stage === 'done'
		&& cached.intent !== undefined
		&& cached.finalReport !== undefined
	) {
		log.info({ runId }, 'runAnalyze: resume cache hit; returning persisted RunAnalyzeOk');
		return {
			ok:             true,
			runId:          cached.runId,
			intent:         cached.intent,
			finalReport:    cached.finalReport,
			tasksCompleted: cached.tasksCompleted ?? 0,
			tasksFailed:    cached.tasksFailed    ?? [],
			durationMs:     0,
		};
	}

	// (0) Stamp the initial RunRecord so observers (IDE, resume) see
	//     the run exists even if stage 1 hangs.
	let record: RunRecord = {
		runId,
		createdAt:       nowIso(),
		updatedAt:       nowIso(),
		userPrompt,
		initialScopeRef,
		stage:           'classify',
		status:          'in-progress',
	};
	writeRunRecord(record);

	// ----- (1) Classify -----
	let intent: ClassifiedIntent;
	try {
		intent = await classify({
			input: { userPrompt, scopeRef: initialScopeRef },
			opts:  { runId },
		});
	} catch (err) {
		const failure = classifyClassifierError(err);
		record = patch(record, { stage: 'classify', status: 'failed', error: failure });
		writeRunRecord(record);
		log.warn({ runId, code: failure.code }, 'runAnalyze: classify failed');
		return failResult('classify', failure, undefined, start, runId);
	}
	record = patch(record, { stage: 'plan', intent });
	writeRunRecord(record);
	log.info({ runId, target: intent.target, scope: intent.scope }, 'runAnalyze: classified');

	// ----- (2) Build run-level context bundle -----
	let contextBundle;
	try {
		const shaper = shaperFor('run', intent.target);
		contextBundle = await shaper.buildRunBundle({ intent }, { runId });
	} catch (err) {
		const failure = classifyShaperError(err);
		record = patch(record, { stage: 'plan', status: 'failed', error: failure });
		writeRunRecord(record);
		log.warn({ runId, code: failure.code }, 'runAnalyze: bundle build failed');
		return failResult('plan', failure, intent, start, runId);
	}

	// ----- (3) Plan (recursive) -----
	let tree;
	try {
		tree = await runRecursivePlanner({
			input: {
				intent,
				contextBundle,
				catalog: getTemplatesForTarget(intent.target),
			},
			opts: { runId },
		});
	} catch (err) {
		const failure = classifyPlannerError(err);
		record = patch(record, { stage: 'plan', status: 'failed', error: failure });
		writeRunRecord(record);
		log.warn({ runId, code: failure.code }, 'runAnalyze: plan build failed');
		return failResult('plan', failure, intent, start, runId);
	}
	record = patch(record, { stage: 'execute' });
	writeRunRecord(record);

	// ----- (4) Execute -----
	const execResult = await runExecutor({ tree, intent, runId });
	const rootPlan = execResult.root;

	if (rootPlan.finalReport === undefined) {
		// Aggregator failed -- runExecutor doesn't throw, the failure
		// lives in tasksFailed. Surface as a typed orchestrator failure.
		const failure: RunFailure = {
			code:    'executor-aggregator-failed',
			message: 'Run executor completed but the aggregator produced no report.',
			data:    {
				tasksCompleted: rootPlan.tasksCompleted,
				tasksFailed:    rootPlan.tasksFailed,
			},
		};
		record = patch(record, {
			stage:          'execute',
			status:         'failed',
			error:          failure,
			tasksCompleted: rootPlan.tasksCompleted,
			tasksFailed:    rootPlan.tasksFailed,
		});
		writeRunRecord(record);
		log.warn({ runId, tasksFailed: rootPlan.tasksFailed.length }, 'runAnalyze: aggregator failed');
		return failResult('execute', failure, intent, start, runId);
	}

	// ----- (done) -----
	record = patch(record, {
		stage:          'done',
		status:         'ok',
		finalReport:    rootPlan.finalReport,
		tasksCompleted: rootPlan.tasksCompleted,
		tasksFailed:    rootPlan.tasksFailed,
	});
	writeRunRecord(record);
	const durationMs = Date.now() - start;
	log.info(
		{ runId, tasksCompleted: rootPlan.tasksCompleted, tasksFailed: rootPlan.tasksFailed.length, durationMs },
		'runAnalyze: ok',
	);

	return {
		ok:             true,
		runId,
		intent,
		finalReport:    rootPlan.finalReport,
		tasksCompleted: rootPlan.tasksCompleted,
		tasksFailed:    rootPlan.tasksFailed,
		durationMs,
	};
}

// ---------------------------------------------------------------------------
// Per-stage error classifiers
// ---------------------------------------------------------------------------

function classifyClassifierError(err: unknown): RunFailure {
	if (err instanceof ClassifierLlmUnavailableError)   return wrap('classifier-llm-unavailable',     err);
	if (err instanceof ClassifierSchemaUnrecoverable)   return wrap('classifier-schema-unrecoverable', err);
	if (err instanceof ClassifierValidationExhausted)   return wrap('classifier-validation-exhausted', err);
	if (err instanceof ClassifierPromptMissingError)    return wrap('classifier-prompt-missing',       err);
	// Scope-ref errors come from the classifier's intent-validator as
	// plain Error with stable messages; pattern-match.
	if (err instanceof Error) {
		if (/scope-ref-unresolved/.test(err.message))            return wrap('scope-ref-unresolved',            err);
		if (/scope-ref-kind-target-mismatch/.test(err.message))  return wrap('scope-ref-kind-target-mismatch',  err);
	}
	return wrap('internal-error', err);
}

function classifyShaperError(err: unknown): RunFailure {
	if (err instanceof ScopeNotIndexedError) {
		return {
			code:    'scope-not-indexed',
			message: err.message,
			data:    { scopePath: err.scopePath, registeredAs: err.registeredAs },
		};
	}
	if (err instanceof ShaperLlmUnavailableError) return wrap('shaper-llm-unavailable',     err);
	if (err instanceof ShaperToolLoopExhausted)   return wrap('shaper-tool-loop-exhausted', err);
	if (err instanceof ShaperSchemaUnrecoverable) return wrap('shaper-schema-unrecoverable', err);
	if (err instanceof ShaperPromptMissingError)  return wrap('shaper-prompt-missing',       err);
	return wrap('internal-error', err);
}

function classifyPlannerError(err: unknown): RunFailure {
	if (err instanceof MaxPlanDepthExceededError) {
		return {
			code:    'max-plan-depth-exceeded',
			message: err.message,
			data:    { currentDepth: err.currentDepth, rootScope: err.rootScope, cap: err.cap },
		};
	}
	if (err instanceof PlanBuilderExhausted) {
		return {
			code:    'plan-invariant-failed',
			message: err.message,
			data:    {
				lastFailure: {
					invariantId: err.lastFailure.invariantId,
					message:     err.lastFailure.message,
				},
				totalAttempts: err.attempts.length,
			},
		};
	}
	if (err instanceof PlanBuilderLlmUnavailableError) return wrap('plan-builder-llm-unavailable',     err);
	if (err instanceof PlanBuilderSchemaUnrecoverable) return wrap('plan-builder-schema-unrecoverable', err);
	if (err instanceof PlanBuilderPromptMissingError)  return wrap('plan-builder-prompt-missing',       err);
	return wrap('internal-error', err);
}

function wrap(code: RunFailure['code'], err: unknown): RunFailure {
	const message = err instanceof Error ? err.message : String(err);
	return { code, message };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function patch(prev: RunRecord, change: Partial<RunRecord>): RunRecord {
	return { ...prev, ...change, updatedAt: nowIso() };
}

function failResult(
	stage:    RunStage,
	failure:  RunFailure,
	intent:   ClassifiedIntent | undefined,
	start:    number,
	runId:    string,
): RunAnalyzeResult {
	const durationMs = Date.now() - start;
	return {
		ok:    false,
		runId,
		stage,
		error: failure,
		...(intent !== undefined ? { intent } : {}),
		durationMs,
	};
}

function nowIso(): string {
	return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

export const _classifyClassifierErrorForTest = classifyClassifierError;
export const _classifyShaperErrorForTest     = classifyShaperError;
export const _classifyPlannerErrorForTest    = classifyPlannerError;
