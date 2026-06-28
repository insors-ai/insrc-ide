/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Orchestrator unit tests.
 *
 * Two halves:
 *   1. Error-classifier mapping: every typed stage error -> the
 *      expected RunErrorCode. Drives the pattern-match map that
 *      keeps wire codes stable.
 *   2. Persistence round-trip: writeRunRecord + readRunRecord +
 *      purgeRunForTests.
 *
 * End-to-end runAnalyze is tested in orchestrator-e2e.test.ts
 * (gated INSRC_LIVE_TESTS=1 because it touches LMDB sandbox +
 * real Ollama via the underlying shapers/classifier).
 *
 * Run:
 *   npx tsx --test src/insrc/analyze/orchestrator/__tests__/orchestrator.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import {
	_classifyClassifierErrorForTest,
	_classifyPlannerErrorForTest,
	_classifyShaperErrorForTest,
} from '../driver.js';
import {
	purgeRunForTests,
	readRunRecord,
	runRecordPathFor,
	writeRunRecord,
} from '../persistence.js';

import {
	ClassifierLlmUnavailableError,
	ClassifierPromptMissingError,
	ClassifierSchemaUnrecoverable,
	ClassifierValidationExhausted,
} from '../../classifier/driver.js';
import {
	ShaperLlmUnavailableError,
	ShaperPromptMissingError,
	ShaperSchemaUnrecoverable,
	ShaperToolLoopExhausted,
} from '../../context/driver.js';
import { ScopeNotIndexedError } from '../../context/invariants.js';
import {
	MaxPlanDepthExceededError,
	PlanBuilderExhausted,
	PlanBuilderLlmUnavailableError,
	PlanBuilderPromptMissingError,
	PlanBuilderSchemaUnrecoverable,
} from '../../planner/index.js';

import type { RunRecord } from '../types.js';

// ---------------------------------------------------------------------------
// Classifier error mapping
// ---------------------------------------------------------------------------

test('classifyClassifierError: typed errors map to stable codes', () => {
	const cases: Array<[Error, string]> = [
		[new ClassifierLlmUnavailableError('down'),                   'classifier-llm-unavailable'],
		[new ClassifierSchemaUnrecoverable(['mismatch']),             'classifier-schema-unrecoverable'],
		[new ClassifierValidationExhausted([], []),                   'classifier-validation-exhausted'],
		[new ClassifierPromptMissingError('/p'),                      'classifier-prompt-missing'],
	];
	for (const [err, expected] of cases) {
		const failure = _classifyClassifierErrorForTest(err);
		assert.equal(failure.code, expected,
			`${err.constructor.name} should map to ${expected}, got ${failure.code}`);
	}
});

test('classifyClassifierError: scope-ref pattern in plain Error message', () => {
	const a = _classifyClassifierErrorForTest(new Error('scope-ref-unresolved: foo'));
	assert.equal(a.code, 'scope-ref-unresolved');
	const b = _classifyClassifierErrorForTest(new Error('scope-ref-kind-target-mismatch: bar'));
	assert.equal(b.code, 'scope-ref-kind-target-mismatch');
});

test('classifyClassifierError: unrecognized error -> internal-error', () => {
	const failure = _classifyClassifierErrorForTest(new Error('totally unknown'));
	assert.equal(failure.code, 'internal-error');
	assert.match(failure.message, /totally unknown/);
});

test('classifyClassifierError: non-Error throws are stringified into internal-error', () => {
	const failure = _classifyClassifierErrorForTest('a string somehow thrown');
	assert.equal(failure.code, 'internal-error');
	assert.match(failure.message, /a string somehow thrown/);
});

// ---------------------------------------------------------------------------
// Shaper error mapping
// ---------------------------------------------------------------------------

test('classifyShaperError: ScopeNotIndexedError populates data', () => {
	const err = new ScopeNotIndexedError('/r/unindexed', undefined);
	const failure = _classifyShaperErrorForTest(err);
	assert.equal(failure.code, 'scope-not-indexed');
	assert.equal(failure.data?.['scopePath'], '/r/unindexed');
});

test('classifyShaperError: typed shaper errors map to stable codes', () => {
	const cases: Array<[Error, string]> = [
		[new ShaperLlmUnavailableError('down'),               'shaper-llm-unavailable'],
		[new ShaperToolLoopExhausted('exhausted'),            'shaper-tool-loop-exhausted'],
		[new ShaperSchemaUnrecoverable(3, ['bad schema']),    'shaper-schema-unrecoverable'],
		[new ShaperPromptMissingError('/p'),                  'shaper-prompt-missing'],
	];
	for (const [err, expected] of cases) {
		const failure = _classifyShaperErrorForTest(err);
		assert.equal(failure.code, expected,
			`${err.constructor.name} should map to ${expected}, got ${failure.code}`);
	}
});

test('classifyShaperError: unrecognized error -> internal-error', () => {
	const failure = _classifyShaperErrorForTest(new Error('unknown shaper failure'));
	assert.equal(failure.code, 'internal-error');
});

// ---------------------------------------------------------------------------
// Planner error mapping
// ---------------------------------------------------------------------------

test('classifyPlannerError: MaxPlanDepthExceededError populates data', () => {
	const err = new MaxPlanDepthExceededError(5, 'XS', 2);
	const failure = _classifyPlannerErrorForTest(err);
	assert.equal(failure.code, 'max-plan-depth-exceeded');
	assert.equal(failure.data?.['currentDepth'], 5);
	assert.equal(failure.data?.['rootScope'],    'XS');
	assert.equal(failure.data?.['cap'],          2);
});

test('classifyPlannerError: PlanBuilderExhausted -> plan-invariant-failed with lastFailure', () => {
	const fakeFailure = { invariantId: 'INV-9', message: 'cycle detected' };
	const err = new PlanBuilderExhausted([], [fakeFailure as never]);
	const failure = _classifyPlannerErrorForTest(err);
	assert.equal(failure.code, 'plan-invariant-failed');
	const lastFailure = failure.data?.['lastFailure'] as { invariantId: string; message: string };
	assert.equal(lastFailure?.invariantId, 'INV-9');
	assert.equal(lastFailure?.message,     'cycle detected');
	assert.equal(failure.data?.['totalAttempts'], 0);
});

test('classifyPlannerError: typed planner errors map to stable codes', () => {
	const cases: Array<[Error, string]> = [
		[new PlanBuilderLlmUnavailableError('down'),                'plan-builder-llm-unavailable'],
		[new PlanBuilderSchemaUnrecoverable(['mismatch']),          'plan-builder-schema-unrecoverable'],
		[new PlanBuilderPromptMissingError('/p'),                   'plan-builder-prompt-missing'],
	];
	for (const [err, expected] of cases) {
		const failure = _classifyPlannerErrorForTest(err);
		assert.equal(failure.code, expected,
			`${err.constructor.name} should map to ${expected}, got ${failure.code}`);
	}
});

test('classifyPlannerError: unrecognized error -> internal-error', () => {
	const failure = _classifyPlannerErrorForTest(new Error('unknown planner failure'));
	assert.equal(failure.code, 'internal-error');
});

// ---------------------------------------------------------------------------
// Persistence round-trip
// ---------------------------------------------------------------------------

test('writeRunRecord + readRunRecord: round-trip preserves the record', () => {
	const runId = `orch-test-${Math.floor(Math.random() * 1e9).toString(16)}`;
	const record: RunRecord = {
		runId,
		createdAt:       '2026-06-27T00:00:00.000Z',
		updatedAt:       '2026-06-27T00:00:00.000Z',
		userPrompt:      'explain the auth flow',
		initialScopeRef: { kind: 'workspace', value: '/r' },
		stage:           'classify',
		status:          'in-progress',
	};

	try {
		const path = writeRunRecord(record);
		assert.ok(existsSync(path));
		assert.equal(path, runRecordPathFor(runId));

		const read = readRunRecord(runId);
		assert.deepEqual(read, record);
	} finally {
		purgeRunForTests(runId);
	}
});

test('readRunRecord: miss returns null', () => {
	assert.equal(readRunRecord('does-not-exist-' + Math.random().toString(36).slice(2)), null);
});

test('runRecordPathFor: lands under ~/.insrc/analyze/<runId>/run.json', () => {
	const path = runRecordPathFor('rid-x');
	assert.match(path, /[/\\]analyze[/\\]rid-x[/\\]run\.json$/);
});

test('purgeRunForTests on a missing slot is a silent no-op', () => {
	assert.doesNotThrow(() => purgeRunForTests('nope-' + Math.random().toString(36).slice(2)));
});

// ---------------------------------------------------------------------------
// Resume -- short-circuit on status='ok'/stage='done' cached records
// ---------------------------------------------------------------------------

import { runAnalyze } from '../driver.js';
import type { ClassifiedIntent } from '../../../shared/analyze-types.js';

test('resume: status=ok + stage=done -> cached RunAnalyzeOk returned without re-running', async () => {
	const runId = `resume-ok-${Math.floor(Math.random() * 1e9).toString(16)}`;
	const cachedIntent: ClassifiedIntent = {
		target:    'infra',
		scope:     'XS',
		focused:   false,
		scopeRef:  { kind: 'workspace', value: '/r' },
		reasoning: 'cached resume test fixture',
	};
	const cachedReport = { summary: 'cached summary', findings: [], metadata: {} as never };

	try {
		writeRunRecord({
			runId,
			createdAt:       '2026-06-27T00:00:00.000Z',
			updatedAt:       '2026-06-27T00:00:05.000Z',
			userPrompt:      'cached prompt',
			initialScopeRef: { kind: 'workspace', value: '/r' },
			stage:           'done',
			status:          'ok',
			intent:          cachedIntent,
			finalReport:     cachedReport,
			tasksCompleted:  4,
			tasksFailed:     [],
		});

		// runAnalyze must NOT touch the LLM stack here -- if it does,
		// it'll throw (no provider configured for the test process). The
		// short-circuit returns immediately.
		const t0 = Date.now();
		const result = await runAnalyze({
			runId,
			userPrompt: 'this should be ignored on resume',
			scopeRef:   { kind: 'workspace', value: '/r' },
		});
		const ms = Date.now() - t0;

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.runId, runId);
		assert.deepEqual(result.intent, cachedIntent);
		assert.deepEqual(result.finalReport, cachedReport);
		assert.equal(result.tasksCompleted, 4);
		assert.equal(result.durationMs, 0,
			'cached resume returns durationMs=0 (no time spent this call)');
		assert.ok(ms < 100, `resume short-circuit should be <100ms; got ${ms}ms`);
	} finally {
		purgeRunForTests(runId);
	}
});

test('resume: status=failed -> NOT short-circuited (would re-run)', async () => {
	// We verify "not short-circuited" indirectly: write a failed
	// record, then check the resume guard rejects it. We can't
	// actually call runAnalyze() without the LLM stack here -- but
	// we can test the underlying readRunRecord and assert the resume
	// predicate (status='ok' AND stage='done' AND intent AND finalReport)
	// would NOT match a failed record.
	const runId = `resume-failed-${Math.floor(Math.random() * 1e9).toString(16)}`;
	try {
		writeRunRecord({
			runId,
			createdAt:       '2026-06-27T00:00:00.000Z',
			updatedAt:       '2026-06-27T00:00:05.000Z',
			userPrompt:      'failed prompt',
			initialScopeRef: { kind: 'workspace', value: '/r' },
			stage:           'plan',
			status:          'failed',
			error:           { code: 'plan-invariant-failed', message: 'INV-3 failed' },
		});

		const r = await import('../persistence.js').then(m => m.readRunRecord(runId));
		assert.ok(r);
		// Resume guard: only matches ok+done+intent+finalReport.
		const wouldShortCircuit = r!.status === 'ok'
			&& r!.stage === 'done'
			&& r!.intent !== undefined
			&& r!.finalReport !== undefined;
		assert.equal(wouldShortCircuit, false,
			'failed records must NOT short-circuit');
	} finally {
		purgeRunForTests(runId);
	}
});

test('resume: status=in-progress -> NOT short-circuited (stale record from crash)', async () => {
	const runId = `resume-inprog-${Math.floor(Math.random() * 1e9).toString(16)}`;
	try {
		writeRunRecord({
			runId,
			createdAt:       '2026-06-27T00:00:00.000Z',
			updatedAt:       '2026-06-27T00:00:05.000Z',
			userPrompt:      'crashed prompt',
			initialScopeRef: { kind: 'workspace', value: '/r' },
			stage:           'plan',
			status:          'in-progress',
		});
		const r = await import('../persistence.js').then(m => m.readRunRecord(runId));
		assert.ok(r);
		const wouldShortCircuit = r!.status === 'ok'
			&& r!.stage === 'done'
			&& r!.intent !== undefined
			&& r!.finalReport !== undefined;
		assert.equal(wouldShortCircuit, false,
			'in-progress (stale) records must NOT short-circuit');
	} finally {
		purgeRunForTests(runId);
	}
});

test('resume: missing run.json -> NOT short-circuited (cold cache)', () => {
	// readRunRecord miss -> null -> guard skips the short-circuit
	// path entirely. Smoke-tested via the predicate logic.
	const guard = (record: null | { status: string; stage: string; intent?: unknown; finalReport?: unknown }): boolean =>
		record !== null
		&& record.status === 'ok'
		&& record.stage === 'done'
		&& record.intent !== undefined
		&& record.finalReport !== undefined;
	assert.equal(guard(null), false);
});
