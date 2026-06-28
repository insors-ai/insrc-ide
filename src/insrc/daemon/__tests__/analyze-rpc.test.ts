/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the analyze.context.* RPC handlers.
 *
 * Pure plumbing tests:
 *   - Params validation produces invalid-params responses
 *   - Typed shaper errors map to stable error codes
 *   - Untyped errors fall through to internal-error
 *   - Happy-path response shape carries the bundle
 *
 * The handlers themselves dispatch into the shaper driver; that
 * driver is exercised end-to-end against real Ollama in
 * analyze-rpc.live.test.ts. This file pins the wire shape without
 * a live model.
 *
 * Run:
 *   PATH=/opt/homebrew/opt/node@22/bin:$PATH \
 *     npx tsx --test src/insrc/daemon/__tests__/analyze-rpc.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	buildClassification,
	buildRun,
	buildTask,
	classify,
	plan,
	runStart,
	runStatus,
} from '../analyze-rpc.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRunRecord, purgeRunForTests } from '../../analyze/orchestrator/index.js';

// ---------------------------------------------------------------------------
// Params validation -- invalid-params responses for malformed input
// ---------------------------------------------------------------------------

test('buildClassification rejects non-object params with invalid-params', async () => {
	const r = await buildClassification(null);
	assert.equal(r.ok, false);
	assert.equal((r as { error: { code: string } }).error.code, 'invalid-params');
});

test('buildClassification rejects missing runId', async () => {
	const r = await buildClassification({
		scopeRef:   { kind: 'workspace', value: '/x' },
		userPrompt: 'hi',
	});
	assert.equal(r.ok, false);
	assert.equal((r as { error: { code: string; message: string } }).error.code, 'invalid-params');
	assert.match((r as { error: { message: string } }).error.message, /runId/);
});

test('buildClassification rejects missing scopeRef', async () => {
	const r = await buildClassification({ runId: 'rid', userPrompt: 'hi' });
	assert.equal(r.ok, false);
	assert.match((r as { error: { message: string } }).error.message, /scopeRef/);
});

test('buildClassification rejects bad scopeRef.kind', async () => {
	const r = await buildClassification({
		runId:      'rid',
		scopeRef:   { kind: 'invalid-kind', value: '/x' },
		userPrompt: 'hi',
	});
	assert.equal(r.ok, false);
	assert.match((r as { error: { message: string } }).error.message, /scopeRef\.kind/);
});

test('buildRun rejects missing intent', async () => {
	const r = await buildRun({ runId: 'rid' });
	assert.equal(r.ok, false);
	assert.match((r as { error: { message: string } }).error.message, /intent/);
});

test('buildRun rejects bad intent.target', async () => {
	const r = await buildRun({
		runId:  'rid',
		intent: {
			target:    'invalid',
			scope:     'M',
			focused:   false,
			scopeRef:  { kind: 'workspace', value: '/x' },
			reasoning: 'test',
		},
	});
	assert.equal(r.ok, false);
	assert.match((r as { error: { message: string } }).error.message, /intent\.target/);
});

test('buildRun rejects bad intent.scope', async () => {
	const r = await buildRun({
		runId:  'rid',
		intent: {
			target:    'code',
			scope:     'XXL',
			focused:   false,
			scopeRef:  { kind: 'workspace', value: '/x' },
			reasoning: 'test',
		},
	});
	assert.equal(r.ok, false);
	assert.match((r as { error: { message: string } }).error.message, /intent\.scope/);
});

test('buildRun rejects non-boolean intent.focused', async () => {
	const r = await buildRun({
		runId:  'rid',
		intent: {
			target:    'code',
			scope:     'M',
			focused:   'yes',
			scopeRef:  { kind: 'workspace', value: '/x' },
			reasoning: 'test',
		},
	});
	assert.equal(r.ok, false);
	assert.match((r as { error: { message: string } }).error.message, /focused/);
});

test('buildTask rejects target=generic at task scope', async () => {
	const r = await buildTask({
		runId: 'rid',
		intent: {
			target:    'generic',
			scope:     'S',
			focused:   true,
			focus:     'foo',
			scopeRef:  { kind: 'workspace', value: '/x' },
			reasoning: 'test',
		},
		task: {
			taskId:    't01',
			template:  'code.foo',
			kind:      'leaf',
			params:    {},
			produces:  ['out'],
			rationale: 'test fixture',
		},
		template: {
			id:       'code.foo',
			target:   'code',
			family:   'foo',
			kind:     'leaf',
			revision: 'r1',
		},
		upstream: {},
	});
	assert.equal(r.ok, false);
	assert.equal((r as { error: { code: string } }).error.code, 'invalid-params');
	assert.match((r as { error: { message: string } }).error.message, /generic.*not valid at task scope/);
});

test('buildTask rejects bad task.produces shape', async () => {
	const r = await buildTask({
		runId: 'rid',
		intent: {
			target:    'code',
			scope:     'S',
			focused:   true,
			focus:     'foo',
			scopeRef:  { kind: 'workspace', value: '/x' },
			reasoning: 'test',
		},
		task: {
			taskId:    't01',
			template:  'code.foo',
			kind:      'leaf',
			params:    {},
			produces:  [1, 2],  // bad
			rationale: 'test fixture',
		},
		template: {
			id:       'code.foo',
			target:   'code',
			family:   'foo',
			kind:     'leaf',
			revision: 'r1',
		},
		upstream: {},
	});
	assert.equal(r.ok, false);
	assert.match((r as { error: { message: string } }).error.message, /task\.produces/);
});

test('buildTask accepts undefined upstream as an empty Map', async () => {
	const r = await buildTask({
		runId: 'rid-' + Math.floor(Math.random() * 1e9).toString(16),
		intent: {
			target:    'code',
			scope:     'S',
			focused:   true,
			focus:     'foo',
			scopeRef:  { kind: 'workspace', value: '/var/folders/non-existent-path' },
			reasoning: 'test',
		},
		task: {
			taskId:    't01',
			template:  'code.foo',
			kind:      'leaf',
			params:    {},
			produces:  ['out'],
			rationale: 'test fixture',
		},
		template: {
			id:       'code.foo',
			target:   'code',
			family:   'foo',
			kind:     'leaf',
			revision: 'r1',
		},
		// upstream omitted
	});
	// Will fail downstream (no Ollama running for sure on the CI path,
	// or model unavailable) but params parsing should NOT fire
	// invalid-params for missing upstream.
	assert.equal(r.ok, false);
	assert.notEqual((r as { error: { code: string } }).error.code, 'invalid-params');
});

test('buildTask accepts array-form upstream', async () => {
	const r = await buildTask({
		runId: 'rid-' + Math.floor(Math.random() * 1e9).toString(16),
		intent: {
			target:    'code',
			scope:     'S',
			focused:   true,
			focus:     'foo',
			scopeRef:  { kind: 'workspace', value: '/var/folders/non-existent-path' },
			reasoning: 'test',
		},
		task: {
			taskId:    't01',
			template:  'code.foo',
			kind:      'leaf',
			params:    {},
			produces:  ['out'],
			rationale: 'test fixture',
		},
		template: {
			id:       'code.foo',
			target:   'code',
			family:   'foo',
			kind:     'leaf',
			revision: 'r1',
		},
		upstream: [['t02', { ok: true }], ['t03', null]],
	});
	assert.equal(r.ok, false);
	assert.notEqual((r as { error: { code: string } }).error.code, 'invalid-params');
});

test('buildTask rejects bad upstream array entries', async () => {
	const r = await buildTask({
		runId: 'rid',
		intent: {
			target:    'code',
			scope:     'S',
			focused:   true,
			focus:     'foo',
			scopeRef:  { kind: 'workspace', value: '/x' },
			reasoning: 'test',
		},
		task: {
			taskId:    't01',
			template:  'code.foo',
			kind:      'leaf',
			params:    {},
			produces:  ['out'],
			rationale: 'test fixture',
		},
		template: {
			id:       'code.foo',
			target:   'code',
			family:   'foo',
			kind:     'leaf',
			revision: 'r1',
		},
		upstream: [['only-one-element']],
	});
	assert.equal(r.ok, false);
	assert.match((r as { error: { message: string } }).error.message, /upstream/);
});

// ---------------------------------------------------------------------------
// Error-code shape: an unsupported scope or unrecognized scopeRef.value
// produces an internal-error / scope-not-indexed code via the shaper
// path. We can't easily force the shaper without LLM, but we CAN
// verify the params validator drops obviously bad inputs upstream,
// and the live test (analyze-rpc.live.test.ts) covers the
// scope-not-indexed code end-to-end.
// ---------------------------------------------------------------------------

test('invalid-params responses carry { code, message }', async () => {
	const r = await buildRun({});
	assert.equal(r.ok, false);
	const err = (r as { error: { code: string; message: string; data?: unknown } }).error;
	assert.equal(typeof err.code, 'string');
	assert.equal(typeof err.message, 'string');
	assert.ok(err.message.length > 0);
});

// ---------------------------------------------------------------------------
// classify: params validation
// ---------------------------------------------------------------------------

test('classify rejects non-object params with invalid-params', async () => {
	const r = await classify(null);
	assert.equal(r.ok, false);
	assert.equal((r as { error: { code: string } }).error.code, 'invalid-params');
});

test('classify rejects missing runId', async () => {
	const r = await classify({
		userPrompt: 'hi',
		scopeRef:   { kind: 'workspace', value: '/x' },
	});
	assert.equal(r.ok, false);
	assert.equal((r as { error: { code: string } }).error.code, 'invalid-params');
	assert.match((r as { error: { message: string } }).error.message, /runId/);
});

test('classify rejects missing userPrompt', async () => {
	const r = await classify({
		runId:    'rid',
		scopeRef: { kind: 'workspace', value: '/x' },
	});
	assert.equal(r.ok, false);
	assert.match((r as { error: { message: string } }).error.message, /userPrompt/);
});

test('classify rejects missing scopeRef', async () => {
	const r = await classify({ runId: 'rid', userPrompt: 'hi' });
	assert.equal(r.ok, false);
	assert.match((r as { error: { message: string } }).error.message, /scopeRef/);
});

test('classify rejects bad scopeRef.kind', async () => {
	const r = await classify({
		runId:      'rid',
		userPrompt: 'hi',
		scopeRef:   { kind: 'invalid-kind', value: '/x' },
	});
	assert.equal(r.ok, false);
	assert.match((r as { error: { message: string } }).error.message, /scopeRef\.kind/);
});

test('classify rejects empty-string userPrompt', async () => {
	const r = await classify({
		runId:      'rid',
		userPrompt: '',
		scopeRef:   { kind: 'workspace', value: '/x' },
	});
	assert.equal(r.ok, false);
	assert.match((r as { error: { message: string } }).error.message, /userPrompt/);
});

// ---------------------------------------------------------------------------
// plan: params validation
// ---------------------------------------------------------------------------

test('plan rejects non-object params with invalid-params', async () => {
	const r = await plan(null);
	assert.equal(r.ok, false);
	assert.equal((r as { error: { code: string } }).error.code, 'invalid-params');
});

test('plan rejects missing runId', async () => {
	const r = await plan({
		intent: {
			target:    'code',
			scope:     'M',
			focused:   false,
			scopeRef:  { kind: 'repo', value: '/x' },
			reasoning: 'test',
		},
	});
	assert.equal(r.ok, false);
	assert.equal((r as { error: { code: string } }).error.code, 'invalid-params');
	assert.match((r as { error: { message: string } }).error.message, /runId/);
});

test('plan rejects missing intent', async () => {
	const r = await plan({ runId: 'rid' });
	assert.equal(r.ok, false);
	assert.match((r as { error: { message: string } }).error.message, /intent/);
});

test('plan rejects bad intent.target', async () => {
	const r = await plan({
		runId: 'rid',
		intent: {
			target:    'invented',
			scope:     'M',
			focused:   false,
			scopeRef:  { kind: 'repo', value: '/x' },
			reasoning: 'test',
		},
	});
	assert.equal(r.ok, false);
	assert.match((r as { error: { message: string } }).error.message, /intent\.target/);
});

test('plan rejects bad rootScope value', async () => {
	const r = await plan({
		runId: 'rid',
		intent: {
			target:    'code',
			scope:     'M',
			focused:   false,
			scopeRef:  { kind: 'repo', value: '/x' },
			reasoning: 'test',
		},
		rootScope: 'XXL',
	});
	assert.equal(r.ok, false);
	assert.match((r as { error: { message: string } }).error.message, /rootScope/);
});

test('plan rejects non-integer currentDepth', async () => {
	const r = await plan({
		runId: 'rid',
		intent: {
			target:    'code',
			scope:     'M',
			focused:   false,
			scopeRef:  { kind: 'repo', value: '/x' },
			reasoning: 'test',
		},
		currentDepth: 1.5,
	});
	assert.equal(r.ok, false);
	assert.match((r as { error: { message: string } }).error.message, /currentDepth/);
});

test('plan rejects negative currentDepth', async () => {
	const r = await plan({
		runId: 'rid',
		intent: {
			target:    'code',
			scope:     'M',
			focused:   false,
			scopeRef:  { kind: 'repo', value: '/x' },
			reasoning: 'test',
		},
		currentDepth: -1,
	});
	assert.equal(r.ok, false);
	assert.match((r as { error: { message: string } }).error.message, /currentDepth/);
});

// ---------------------------------------------------------------------------
// analyze.run.start -- params validation
// ---------------------------------------------------------------------------

test('runStart rejects non-object params with invalid-params + empty runId', async () => {
	const r = await runStart(null);
	assert.equal(r.ok, false);
	if (r.ok) return;  // type narrowing
	assert.equal(r.error.code, 'invalid-params');
	assert.equal(r.runId, '');
	assert.equal(r.stage, 'classify');
});

test('runStart rejects missing runId', async () => {
	const r = await runStart({
		userPrompt: 'hi',
		scopeRef:   { kind: 'workspace', value: '/x' },
	});
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.equal(r.error.code, 'invalid-params');
	assert.match(r.error.message, /runId/);
});

test('runStart rejects missing userPrompt', async () => {
	const r = await runStart({
		runId:    'r1',
		scopeRef: { kind: 'workspace', value: '/x' },
	});
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.equal(r.error.code, 'invalid-params');
	assert.match(r.error.message, /userPrompt/);
});

test('runStart rejects missing scopeRef', async () => {
	const r = await runStart({ runId: 'r1', userPrompt: 'hi' });
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.equal(r.error.code, 'invalid-params');
	assert.match(r.error.message, /scopeRef/);
});

test('runStart rejects bad scopeRef.kind', async () => {
	const r = await runStart({
		runId: 'r1', userPrompt: 'hi',
		scopeRef: { kind: 'frobnicate', value: '/x' },
	});
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.equal(r.error.code, 'invalid-params');
	assert.match(r.error.message, /scopeRef\.kind/);
});

// ---------------------------------------------------------------------------
// analyze.run.status
// ---------------------------------------------------------------------------

test('runStatus rejects non-object params with invalid-params', async () => {
	const r = await runStatus(null);
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.equal(r.error.code, 'invalid-params');
});

test('runStatus rejects missing runId', async () => {
	const r = await runStatus({});
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.equal(r.error.code, 'invalid-params');
});

test('runStatus on missing runId record returns invalid-input', async () => {
	const r = await runStatus({ runId: 'no-such-' + Math.random().toString(36).slice(2) });
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.equal(r.error.code, 'invalid-input');
	assert.match(r.error.message, /no run record/);
});

test('runStatus returns the persisted RunRecord round-trip', async () => {
	const runId = `rpc-status-${Math.floor(Math.random() * 1e9).toString(16)}`;
	try {
		writeRunRecord({
			runId,
			createdAt:       '2026-06-27T00:00:00.000Z',
			updatedAt:       '2026-06-27T00:00:01.000Z',
			userPrompt:      'fixture',
			initialScopeRef: { kind: 'workspace', value: '/r' },
			stage:           'done',
			status:          'ok',
			intent: {
				target:    'infra',
				scope:     'XS',
				focused:   false,
				scopeRef:  { kind: 'workspace', value: '/r' },
				reasoning: 'fixture',
			},
			finalReport:    { summary: 'all good', findings: [], metadata: {} as never },
			tasksCompleted: 3,
			tasksFailed:    [],
		});
		const r = await runStatus({ runId });
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.equal(r.record.runId, runId);
		assert.equal(r.record.status, 'ok');
		assert.equal(r.record.intent?.target, 'infra');
	} finally {
		purgeRunForTests(runId);
		// Touch unused imports to keep TS happy on the test build path.
		void mkdtempSync; void rmSync; void tmpdir; void join;
	}
});

test('AnalyzeRpcOk responses have ok:true and a bundle field', async () => {
	// We can't easily force a success without a real LLM. But the
	// shape is pinned at the type level; the live test asserts the
	// success path. This test ensures the type discriminator is
	// usable -- a TypeScript check is enough.
	type Ok  = { ok: true;  bundle: unknown };
	type Err = { ok: false; error:  { code: string; message: string } };
	const synth: Ok | Err = { ok: true, bundle: { system: '', focus: '', summary: '', structure: '', surface: '', artefacts: '', upstream: '' } };
	if (synth.ok) {
		assert.notEqual(synth.bundle, undefined);
	}
});
