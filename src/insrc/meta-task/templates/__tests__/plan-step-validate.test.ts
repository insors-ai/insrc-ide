/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the P4 validate Phase2Runner (M4.a Phase 3).
 *
 * Plan ref: `plans/meta-task-plan.md` Phase 3.
 *
 * Pin the contract:
 *   - Happy path: linear draft -> deliverable with "no cycles" report.
 *   - Cycle: 3-step cycle in draft -> abort('plan-revisable') with the
 *     cycle path in the reason.
 *   - Phantom steps (empty description): WARNING surfaced in the body,
 *     not an abort.
 *   - Malformed P3 draft (zero steps after parse): abort('plan-revisable').
 *   - Missing P3 deliverable in ctx.deliverables: abort('user-required').
 *   - Runner never calls ctx.cloud (verified by a throwing stub).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planValidateRunner } from '../plan-step-validate.js';
import type { Phase2RunnerCtx } from '../../types.js';
import type { LLMProvider } from '../../../shared/types.js';
import type { OutboundMessage } from '../../event-emitter.js';
import { MetaTaskEmitter } from '../../event-emitter.js';


function throwingCloud(): LLMProvider {
	return {
		async complete() { throw new Error('plan-step-validate must NOT call cloud'); },
		stream() { return (async function* () { yield ''; })(); },
		async embed() { return []; },
	};
}

function emptyEmitter(): MetaTaskEmitter {
	const events: OutboundMessage[] = [];
	return new MetaTaskEmitter({
		send: m => events.push(m),
		todos: {
			async createList()       { return { id: 'l1' }; },
			async addItem()          { return { id: 'i1' }; },
			async markInProgress()   { return {}; },
			async markComplete()     { return {}; },
			async markBlocked()      { return {}; },
			async updateListBody()   { return {}; },
		} as unknown as MetaTaskEmitter['todos'],
	});
}

function ctx(deliverables: ReadonlyMap<number, string>): Phase2RunnerCtx {
	return {
		stepDesc: {
			name: 'P4 validate', intent: 'validate', acceptance: [],
			phase2: planValidateRunner,
		},
		phase1Result:     null,
		cumulativeChunks: [],
		cloud:            throwingCloud(),
		catalog:          [],
		deliverables,
		stepIndex:        4,
		retryAttempt:     0,
		bubble:           'test',
		signal:           undefined,
		// emit/store would land here in a real run; runner ignores them.
	} as unknown as Phase2RunnerCtx;
}


// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('planValidateRunner: linear plan -> deliverable with no-cycles report', async () => {
	const draft = JSON.stringify([
		{ title: 'Schema',  description: 'design schema',   dependsOnIdx: []  },
		{ title: 'API',     description: 'wire endpoints',  dependsOnIdx: [0] },
		{ title: 'Tests',   description: 'add coverage',    dependsOnIdx: [1] },
	]);
	const r = await planValidateRunner(ctx(new Map([[3, draft]])));
	assert.equal(r.kind, 'deliverable');
	if (r.kind === 'deliverable') {
		assert.match(r.body, /# Validation pass/);
		assert.match(r.body, /Step count: 3/);
		assert.match(r.body, /Dependency cycles: none/);
		assert.match(r.body, /1\. \*\*Schema\*\*/);
	}
	// emitter intentionally not asserted -- emit is stubbed and runner
	// doesn't use it.
	emptyEmitter();
});


// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

test('planValidateRunner: 3-step cycle -> abort plan-revisable + cycle path', async () => {
	// a -> b -> c -> a
	const draft = JSON.stringify([
		{ title: 'a', description: 'A', dependsOnIdx: [2] },
		{ title: 'b', description: 'B', dependsOnIdx: [0] },
		{ title: 'c', description: 'C', dependsOnIdx: [1] },
	]);
	const r = await planValidateRunner(ctx(new Map([[3, draft]])));
	assert.equal(r.kind, 'abort');
	if (r.kind === 'abort') {
		assert.equal(r.resolution, 'plan-revisable');
		assert.match(r.reason, /cycle detected/);
		// One of the titles should appear in the path.
		assert.ok(/a|b|c/.test(r.reason));
		assert.ok(r.hint !== undefined);
	}
});


test('planValidateRunner: self-cycle (a -> a) is dropped by buildPlan -> no cycle reported, but the dropped dep surfaces in body', async () => {
	const draft = JSON.stringify([
		{ title: 'a', description: 'A', dependsOnIdx: [0] },        // dropped
		{ title: 'b', description: 'B', dependsOnIdx: [0] },
	]);
	const r = await planValidateRunner(ctx(new Map([[3, draft]])));
	assert.equal(r.kind, 'deliverable');
	if (r.kind === 'deliverable') {
		assert.match(r.body, /Dropped malformed dependsOnIdx entries: 1/);
	}
});


// ---------------------------------------------------------------------------
// Defensive paths
// ---------------------------------------------------------------------------

test('planValidateRunner: phantom step (empty description) -> warning, not abort', async () => {
	const draft = JSON.stringify([
		{ title: 'real',    description: 'real step',  dependsOnIdx: [] },
		{ title: 'phantom', description: '',           dependsOnIdx: [0] },
	]);
	const r = await planValidateRunner(ctx(new Map([[3, draft]])));
	assert.equal(r.kind, 'deliverable');
	if (r.kind === 'deliverable') {
		assert.match(r.body, /WARNING:.*empty description/);
	}
});

test('planValidateRunner: duplicate titles surface as a warning, not abort', async () => {
	const draft = JSON.stringify([
		{ title: 'dup', description: 'first',  dependsOnIdx: [] },
		{ title: 'dup', description: 'second', dependsOnIdx: [0] },
	]);
	const r = await planValidateRunner(ctx(new Map([[3, draft]])));
	assert.equal(r.kind, 'deliverable');
	if (r.kind === 'deliverable') {
		assert.match(r.body, /duplicate step titles detected: dup/);
	}
});

test('planValidateRunner: zero steps after parse -> abort plan-revisable', async () => {
	// parseStepsJson('[]') returns []. Distinct from "malformed" which
	// produces a single-step fallback; an EMPTY array means the LLM literally
	// emitted nothing.
	const r = await planValidateRunner(ctx(new Map([[3, '[]']])));
	assert.equal(r.kind, 'abort');
	if (r.kind === 'abort') {
		assert.equal(r.resolution, 'plan-revisable');
		assert.match(r.reason, /zero steps/);
	}
});


test('planValidateRunner: missing P3 deliverable -> abort user-required', async () => {
	const r = await planValidateRunner(ctx(new Map()));    // no entry at stepIndex 3
	assert.equal(r.kind, 'abort');
	if (r.kind === 'abort') {
		assert.equal(r.resolution, 'user-required');
		assert.match(r.reason, /missing P3 draft deliverable/);
	}
});


// ---------------------------------------------------------------------------
// No-LLM invariant
// ---------------------------------------------------------------------------

test('planValidateRunner: never invokes ctx.cloud (deterministic invariant)', async () => {
	const draft = JSON.stringify([{ title: 'a', description: 'A', dependsOnIdx: [] }]);
	// throwingCloud's complete() throws; if the runner calls it, this test fails.
	const r = await planValidateRunner(ctx(new Map([[3, draft]])));
	assert.equal(r.kind, 'deliverable');
});
