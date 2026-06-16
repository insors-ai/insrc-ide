/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Schema validator tests. Round-trip every valid shape; reject every malformed
 * shape the production schema is supposed to catch.
 *
 * The validators feed retry prompts back to the cloud LLM, so error messages
 * matter. We assert they reference the offending path / field by name.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	validateContextChunk,
	validateContextRequest,
	validatePhase1Ask,
	validatePhase1Result,
	validatePhase2Out,
} from '../schema.js';


// ---------------------------------------------------------------------------
// ContextRequest -- per-kind shape validation.
// ---------------------------------------------------------------------------

test('ContextRequest entities: at least one filter required', () => {
	const bad  = validateContextRequest({ kind: 'entities' });
	assert.equal(bad.ok, false);
	if (!bad.ok) {
		assert.ok(bad.errors.some(e => /unbounded query rejected/.test(e)));
	}
	const good = validateContextRequest({ kind: 'entities', names: ['Foo'] });
	assert.equal(good.ok, true);
});

test('ContextRequest files: requires non-empty globs', () => {
	const r1 = validateContextRequest({ kind: 'files', globs: [] });
	assert.equal(r1.ok, false);
	const r2 = validateContextRequest({ kind: 'files', globs: ['src/**/*.ts'] });
	assert.equal(r2.ok, true);
});

test('ContextRequest semantic: rejects bad topK + over', () => {
	const r1 = validateContextRequest({ kind: 'semantic', query: 'x', topK: -1 });
	assert.equal(r1.ok, false);
	const r2 = validateContextRequest({ kind: 'semantic', query: 'x', over: ['bogus'] });
	assert.equal(r2.ok, false);
	const r3 = validateContextRequest({ kind: 'semantic', query: 'x', topK: 5, over: ['entities'] });
	assert.equal(r3.ok, true);
});

test('ContextRequest graph: requires valid op + targets', () => {
	const r1 = validateContextRequest({ kind: 'graph', op: 'invalid', targets: ['id1'] });
	assert.equal(r1.ok, false);
	const r2 = validateContextRequest({ kind: 'graph', op: 'callers', targets: [] });
	assert.equal(r2.ok, false);
	const r3 = validateContextRequest({ kind: 'graph', op: 'callers', targets: ['id1'] });
	assert.equal(r3.ok, true);
});

test('ContextRequest deliverable: rejects missing specId', () => {
	const bad  = validateContextRequest({ kind: 'deliverable' });
	assert.equal(bad.ok, false);
	const good = validateContextRequest({ kind: 'deliverable', specId: 'spec-abc' });
	assert.equal(good.ok, true);
});

test('ContextRequest rejects unknown kind', () => {
	const r = validateContextRequest({ kind: 'invented' });
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.ok(r.errors[0]!.includes("'invented'"));
	}
});

test('ContextRequest rejects non-object', () => {
	const r = validateContextRequest('not an object');
	assert.equal(r.ok, false);
});


// ---------------------------------------------------------------------------
// Phase1Ask -- sufficient / context-needed with non-empty requests.
// ---------------------------------------------------------------------------

test('Phase1Ask sufficient: minimal valid', () => {
	const r = validatePhase1Ask({ kind: 'sufficient' });
	assert.equal(r.ok, true);
});

test('Phase1Ask context-needed: rejects empty requests', () => {
	const r = validatePhase1Ask({ kind: 'context-needed', requests: [] });
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.ok(r.errors.some(e => /required non-empty array/.test(e)));
		assert.ok(r.errors.some(e => /sufficient/.test(e)));
	}
});

test('Phase1Ask context-needed: passes through one valid request', () => {
	const r = validatePhase1Ask({
		kind: 'context-needed',
		requests: [{ kind: 'entities', names: ['Foo'] }],
	});
	assert.equal(r.ok, true);
});

test('Phase1Ask context-needed: cascades request-level errors', () => {
	const r = validatePhase1Ask({
		kind: 'context-needed',
		requests: [{ kind: 'entities' /* no filter */ }],
	});
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.ok(r.errors.some(e => /phase1Ask\.requests\[0\]/.test(e)));
	}
});


// ---------------------------------------------------------------------------
// ContextChunk -- needs-narrowing requires narrowingHint.
// ---------------------------------------------------------------------------

test('ContextChunk needs-narrowing requires narrowingHint', () => {
	const r = validateContextChunk({
		request: { kind: 'files', globs: ['**'] },
		status:  'needs-narrowing',
		payload: null,
	});
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.ok(r.errors.some(e => /required when status === 'needs-narrowing'/.test(e)));
	}
});

test('ContextChunk needs-narrowing with hint passes', () => {
	const r = validateContextChunk({
		request: { kind: 'files', globs: ['**'] },
		status:  'needs-narrowing',
		payload: null,
		narrowingHint: { matched: 500, suggestedFilters: ['narrow by dir'] },
	});
	assert.equal(r.ok, true);
});

test('ContextChunk ok: minimal valid', () => {
	const r = validateContextChunk({
		request: { kind: 'entities', names: ['Foo'] },
		status:  'ok',
		payload: [{ id: 'e1' }],
	});
	assert.equal(r.ok, true);
});

test('ContextChunk: invalid status rejected', () => {
	const r = validateContextChunk({
		request: { kind: 'entities', names: ['Foo'] },
		status:  'bogus',
		payload: [],
	});
	assert.equal(r.ok, false);
});

test('ContextChunk: rejects malformed narrowingHint kinds', () => {
	const r = validateContextChunk({
		request: { kind: 'files', globs: ['**'] },
		status:  'needs-narrowing',
		payload: null,
		narrowingHint: { matched: 1, suggestedAlternativeKinds: ['not-a-kind'] },
	});
	assert.equal(r.ok, false);
});


// ---------------------------------------------------------------------------
// Phase1Result -- chunks array + meta object.
// ---------------------------------------------------------------------------

test('Phase1Result: valid', () => {
	const r = validatePhase1Result({
		chunks: [{ request: { kind: 'entities', names: ['Foo'] }, status: 'ok', payload: [] }],
		meta:   { totalBytes: 0, elapsedMs: 12, droppedRequests: 0 },
	});
	assert.equal(r.ok, true);
});

test('Phase1Result: rejects missing meta', () => {
	const r = validatePhase1Result({
		chunks: [],
	});
	assert.equal(r.ok, false);
});

test('Phase1Result: rejects negative meta numbers', () => {
	const r = validatePhase1Result({
		chunks: [],
		meta:   { totalBytes: -1, elapsedMs: 0, droppedRequests: 0 },
	});
	assert.equal(r.ok, false);
});


// ---------------------------------------------------------------------------
// Phase2Out -- deliverable / context-needed / abort.
// ---------------------------------------------------------------------------

test('Phase2Out deliverable: requires non-empty body', () => {
	const r1 = validatePhase2Out({ kind: 'deliverable', body: '' });
	assert.equal(r1.ok, false);
	const r2 = validatePhase2Out({ kind: 'deliverable', body: 'hello' });
	assert.equal(r2.ok, true);
});

test('Phase2Out context-needed: requires non-empty reason', () => {
	const r1 = validatePhase2Out({
		kind: 'context-needed',
		requests: [{ kind: 'entities', names: ['Foo'] }],
		reason:   '',
	});
	assert.equal(r1.ok, false);
	if (!r1.ok) {
		assert.ok(r1.errors.some(e => /reason: required non-empty string/.test(e)));
	}
	const r2 = validatePhase2Out({
		kind: 'context-needed',
		requests: [{ kind: 'entities', names: ['Foo'] }],
		reason:   'previous fetch missed the parent class',
	});
	assert.equal(r2.ok, true);
});

test('Phase2Out context-needed: requires non-empty requests', () => {
	const r = validatePhase2Out({
		kind: 'context-needed',
		requests: [],
		reason:   'need more',
	});
	assert.equal(r.ok, false);
});

test('Phase2Out abort: requires reason + resolution', () => {
	const r1 = validatePhase2Out({ kind: 'abort', reason: 'cant proceed' });
	assert.equal(r1.ok, false);
	const r2 = validatePhase2Out({ kind: 'abort', reason: 'cant proceed', resolution: 'invalid' });
	assert.equal(r2.ok, false);
	const r3 = validatePhase2Out({ kind: 'abort', reason: 'cant proceed', resolution: 'user-required' });
	assert.equal(r3.ok, true);
	const r4 = validatePhase2Out({ kind: 'abort', reason: 'cant proceed', resolution: 'plan-revisable', hint: 'try /design first' });
	assert.equal(r4.ok, true);
});

test('Phase2Out: rejects unknown kind', () => {
	const r = validatePhase2Out({ kind: 'invented' });
	assert.equal(r.ok, false);
});
