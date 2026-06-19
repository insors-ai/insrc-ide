/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the orchestrator's M4.a Phase 1 escape hatch
 * (`StepDescriptor.phase2`).
 *
 * Plan ref: `plans/meta-task-plan.md` Phase 1.
 * Design ref: `design/meta-task-plan.html` §9 O1 resolution.
 *
 * Pins the contract:
 *   - Default path (no `phase2`) is unchanged -- existing /review still works.
 *   - `phase2` present + returns deliverable -> orchestrator advances normally.
 *   - `phase2` returns context-needed -> normal retry loop kicks in.
 *   - `phase2` returns abort -> meta-task terminates with that resolution.
 *   - `phase2` throws -> step aborts with user-required resolution and a
 *     stable error message (no orchestrator crash).
 *   - `phase2` may call ctx.cloud (verified by counting calls + asserting
 *     a scripted response landed verbatim in the deliverable body).
 *   - `phase2` receives prior-step deliverables in ctx.deliverables so
 *     deterministic helpers (P4 validate reads P3 draft, P6 synth reads
 *     P3 + P5) have the bodies inline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMProvider, LLMResponse } from '../../shared/types.js';
import { runMetaTask } from '../orchestrator.js';
import { MetaTaskEmitter, type OutboundMessage } from '../event-emitter.js';
import { PATHS } from '../../shared/paths.js';
import { _clearRegistryForTests, registerTemplate, type MetaTaskTemplate } from '../templates/index.js';
import type { Phase2Out, Phase2Runner, Phase2RunnerCtx, Plan, ScopeManifest } from '../types.js';

// Bootstrap the registry so /review remains discoverable (we register custom
// templates in each test on top).
import '../templates/index.js';


// ---------------------------------------------------------------------------
// Scripted cloud + fake TodosApi (mirrors orchestrator.test.ts pattern)
// ---------------------------------------------------------------------------

interface RecordedCall { messages: unknown; opts: unknown }
interface RecordingCloud extends LLMProvider { calls: RecordedCall[] }

function recordingCloud(responses: readonly string[]): RecordingCloud {
	let idx = 0;
	const calls: RecordedCall[] = [];
	return {
		calls,
		async complete(messages: unknown, opts: unknown): Promise<LLMResponse> {
			calls.push({ messages, opts });
			const text = responses[idx++] ?? '';
			return { text, stopReason: 'end_turn' };
		},
		stream(): AsyncIterable<string> { return (async function* () { yield ''; })(); },
		async embed(): Promise<number[]> { return []; },
	};
}


class FakeTodosApi {
	calls: string[] = [];
	private listCounter = 0;
	private itemCounter = 0;
	async createList(opts: { title: string }): Promise<{ id: string }> {
		this.calls.push(`createList:${opts.title}`);
		return { id: `list-${++this.listCounter}` };
	}
	async addItem(listId: string, opts: { title: string }): Promise<{ id: string }> {
		this.calls.push(`addItem:${listId}:${opts.title}`);
		return { id: `item-${++this.itemCounter}` };
	}
	async markInProgress(itemId: string): Promise<unknown> { this.calls.push(`markInProgress:${itemId}`); return {}; }
	async markComplete(itemId: string):   Promise<unknown> { this.calls.push(`markComplete:${itemId}`); return {}; }
	async markBlocked(itemId: string, reason: string): Promise<unknown> { this.calls.push(`markBlocked:${itemId}:${reason}`); return {}; }
	async updateListBody(listId: string, _body: string): Promise<unknown> { this.calls.push(`updateListBody:${listId}`); return {}; }
}

function setupEnv(): { home: string; restore: () => void } {
	const home = mkdtempSync(join(tmpdir(), 'mt-p2runner-'));
	const restoreHome = process.env.HOME;
	process.env.HOME = home;
	const originalMeta = PATHS.meta;
	(PATHS as { meta: string }).meta = join(home, '.insrc', 'meta');
	return {
		home,
		restore: () => {
			(PATHS as { meta: string }).meta = originalMeta;
			if (restoreHome !== undefined) { process.env.HOME = restoreHome; }
			try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
		},
	};
}

function makeEmitter(): { emit: MetaTaskEmitter; todos: FakeTodosApi; events: OutboundMessage[] } {
	const events: OutboundMessage[] = [];
	const todos = new FakeTodosApi();
	const emit  = new MetaTaskEmitter({
		send:  msg => events.push(msg),
		todos: todos as unknown as MetaTaskEmitter['todos'],
	});
	return { emit, todos, events };
}

/**
 * Build a one-step custom template using the supplied phase2 runner. Keeps
 * the test surface small: we don't want to exercise multi-step composition
 * here -- the existing orchestrator tests already cover that.
 */
function makeOneStepTemplate(id: string, runner: Phase2Runner | undefined, stepName = 'P1 only'): MetaTaskTemplate {
	const planFn = (_scope: ScopeManifest): Plan => ({
		revision: 0,
		steps: [
			{
				name: stepName,
				intent: 'one-step phase2-runner regression target',
				acceptance: [{ id: 'soft.always', description: 'always passes', kind: 'soft' }],
				...(runner !== undefined ? { phase2: runner } : {}),
			},
		],
	});
	return {
		id,
		displayName: id,
		worktreeMode: 'none',
		plan: planFn,
	};
}

function makeTwoStepTemplate(id: string, step2Runner: Phase2Runner): MetaTaskTemplate {
	const planFn = (_scope: ScopeManifest): Plan => ({
		revision: 0,
		steps: [
			{
				name: 'S1 first',
				intent: 'first step (uses default LLM path)',
				acceptance: [{ id: 'soft.always', description: 'always passes', kind: 'soft' }],
			},
			{
				name: 'S2 runner',
				intent: 'second step reads step-1 deliverable via ctx.deliverables',
				acceptance: [{ id: 'soft.always', description: 'always passes', kind: 'soft' }],
				phase2: step2Runner,
			},
		],
	});
	return {
		id,
		displayName: id,
		worktreeMode: 'none',
		plan: planFn,
	};
}


// ---------------------------------------------------------------------------
// Default path regression: /review still uses the LLM path
// ---------------------------------------------------------------------------

test('phase2 runner: default path unchanged when stepDesc.phase2 absent (review regression)', async () => {
	const env = setupEnv();
	try {
		const { emit, todos } = makeEmitter();
		const cloud = recordingCloud([
			JSON.stringify({ kind: 'sufficient' }),
			JSON.stringify({ kind: 'deliverable', body: '# Review\n- finding' }),
		]);
		const result = await runMetaTask({
			templateId: 'review',
			intent: 'regression',
			scope: { intent: 'regression', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [] },
			sessionId: 'sess-p2r-1',
			emit, cloud,
			embed: async () => [],
			allocId: () => 'mt-p2r-1',
		});
		assert.equal(result.outcome, 'completed');
		assert.equal(cloud.calls.length, 2, 'review default path still makes 2 cloud calls (phase-1 ask + phase-2 task)');
		assert.ok(todos.calls.some(c => c.startsWith('markComplete:')));
	} finally { env.restore(); }
});


// ---------------------------------------------------------------------------
// Runner returns deliverable
// ---------------------------------------------------------------------------

test('phase2 runner: deliverable -> orchestrator advances normally', async () => {
	const env = setupEnv();
	_clearRegistryForTests();
	try {
		const runnerCalls: Phase2RunnerCtx[] = [];
		const runner: Phase2Runner = async (ctx) => {
			runnerCalls.push(ctx);
			return { kind: 'deliverable', body: '# Runner deliverable\n\nfrom phase2 runner' };
		};
		registerTemplate(makeOneStepTemplate('test-runner-deliverable', runner));

		const { emit } = makeEmitter();
		const cloud = recordingCloud([
			JSON.stringify({ kind: 'sufficient' }),   // phase-1 ask
			// no phase-2 cloud call expected
		]);
		const result = await runMetaTask({
			templateId: 'test-runner-deliverable',
			intent: 'runner-deliverable',
			scope: { intent: 'runner-deliverable', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [] },
			sessionId: 'sess-p2r-2',
			emit, cloud,
			embed: async () => [],
			allocId: () => 'mt-p2r-2',
		});
		assert.equal(result.outcome, 'completed');
		assert.equal(result.deliverables.size, 1);
		assert.match(result.deliverables.get(1)!, /Runner deliverable/);
		assert.equal(cloud.calls.length, 1, 'phase-2 LLM call must NOT happen when runner is set');
		assert.equal(runnerCalls.length, 1, 'runner invoked exactly once');
	} finally { env.restore(); _clearRegistryForTests(); }
});


// ---------------------------------------------------------------------------
// Runner returns context-needed -> normal retry loop
// ---------------------------------------------------------------------------

test('phase2 runner: context-needed -> phase-1 retry loop runs; runner re-invoked', async () => {
	const env = setupEnv();
	_clearRegistryForTests();
	try {
		let invocation = 0;
		const runner: Phase2Runner = async () => {
			invocation += 1;
			if (invocation === 1) {
				return {
					kind: 'context-needed',
					requests: [{ kind: 'files', globs: ['**/*.ts'] }],
					reason: 'first runner pass declares insufficient',
				};
			}
			return { kind: 'deliverable', body: 'done on attempt ' + String(invocation) };
		};
		registerTemplate(makeOneStepTemplate('test-runner-ctxneeded', runner));

		const { emit } = makeEmitter();
		const cloud = recordingCloud([
			JSON.stringify({ kind: 'sufficient' }),    // phase-1 ask iter 1
			JSON.stringify({ kind: 'sufficient' }),    // phase-1 ask iter 2
		]);
		const result = await runMetaTask({
			templateId: 'test-runner-ctxneeded',
			intent: 'runner-ctxneeded',
			scope: { intent: 'runner-ctxneeded', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [] },
			sessionId: 'sess-p2r-3',
			emit, cloud,
			embed: async () => [],
			allocId: () => 'mt-p2r-3',
		});
		assert.equal(result.outcome, 'completed');
		assert.equal(invocation, 2, 'runner ran twice: insufficient then deliverable');
		assert.match(result.deliverables.get(1)!, /attempt 2/);
	} finally { env.restore(); _clearRegistryForTests(); }
});


// ---------------------------------------------------------------------------
// Runner returns abort
// ---------------------------------------------------------------------------

test('phase2 runner: abort -> meta-task terminates with that resolution', async () => {
	const env = setupEnv();
	_clearRegistryForTests();
	try {
		const runner: Phase2Runner = async () => ({
			kind: 'abort',
			resolution: 'plan-revisable',
			reason: 'runner declined: deterministic check failed',
			hint: 'try a different intent',
		});
		registerTemplate(makeOneStepTemplate('test-runner-abort', runner));

		const { emit, todos } = makeEmitter();
		const cloud = recordingCloud([JSON.stringify({ kind: 'sufficient' })]);
		const result = await runMetaTask({
			templateId: 'test-runner-abort',
			intent: 'runner-abort',
			scope: { intent: 'runner-abort', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [] },
			sessionId: 'sess-p2r-4',
			emit, cloud,
			embed: async () => [],
			allocId: () => 'mt-p2r-4',
		});
		assert.equal(result.outcome, 'aborted');
		assert.match(result.abortReason ?? '', /plan-revisable/);
		assert.match(result.abortReason ?? '', /runner declined/);
		assert.ok(todos.calls.some(c => c.startsWith('markBlocked:')));
	} finally { env.restore(); _clearRegistryForTests(); }
});


// ---------------------------------------------------------------------------
// Runner throws -> user-required abort (no orchestrator crash)
// ---------------------------------------------------------------------------

test('phase2 runner: throw -> step aborts with user-required + stable error', async () => {
	const env = setupEnv();
	_clearRegistryForTests();
	try {
		const runner: Phase2Runner = async () => {
			throw new Error('boom from runner');
		};
		registerTemplate(makeOneStepTemplate('test-runner-throw', runner));

		const { emit } = makeEmitter();
		const cloud = recordingCloud([JSON.stringify({ kind: 'sufficient' })]);
		const result = await runMetaTask({
			templateId: 'test-runner-throw',
			intent: 'runner-throw',
			scope: { intent: 'runner-throw', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [] },
			sessionId: 'sess-p2r-5',
			emit, cloud,
			embed: async () => [],
			allocId: () => 'mt-p2r-5',
		});
		assert.equal(result.outcome, 'aborted');
		assert.match(result.abortReason ?? '', /user-required/);
		assert.match(result.abortReason ?? '', /boom from runner/);
	} finally { env.restore(); _clearRegistryForTests(); }
});


// ---------------------------------------------------------------------------
// Runner can call ctx.cloud
// ---------------------------------------------------------------------------

test('phase2 runner: may invoke ctx.cloud -- response lands in deliverable', async () => {
	const env = setupEnv();
	_clearRegistryForTests();
	try {
		const runner: Phase2Runner = async (ctx) => {
			const r = await ctx.cloud.complete([
				{ role: 'system', content: 'reply with the word PONG' },
				{ role: 'user', content: 'ping' },
			]);
			return { kind: 'deliverable', body: `cloud said: ${r.text}` };
		};
		registerTemplate(makeOneStepTemplate('test-runner-cloud', runner));

		const { emit } = makeEmitter();
		const cloud = recordingCloud([
			JSON.stringify({ kind: 'sufficient' }),
			'PONG',
		]);
		const result = await runMetaTask({
			templateId: 'test-runner-cloud',
			intent: 'runner-cloud',
			scope: { intent: 'runner-cloud', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [] },
			sessionId: 'sess-p2r-6',
			emit, cloud,
			embed: async () => [],
			allocId: () => 'mt-p2r-6',
		});
		assert.equal(result.outcome, 'completed');
		assert.equal(cloud.calls.length, 2, 'phase-1 ask + runner-driven cloud call');
		assert.match(result.deliverables.get(1)!, /cloud said: PONG/);
	} finally { env.restore(); _clearRegistryForTests(); }
});


// ---------------------------------------------------------------------------
// Runner receives prior-step deliverables
// ---------------------------------------------------------------------------

test('phase2 runner: ctx.deliverables carries prior-step bodies (P6 synth pattern)', async () => {
	const env = setupEnv();
	_clearRegistryForTests();
	try {
		const seenDeliverables: ReadonlyMap<number, string>[] = [];
		const step2Runner: Phase2Runner = async (ctx) => {
			seenDeliverables.push(new Map(ctx.deliverables));
			const prior = ctx.deliverables.get(1) ?? '<missing>';
			return { kind: 'deliverable', body: `merged: ${prior}` };
		};
		registerTemplate(makeTwoStepTemplate('test-runner-deliverables', step2Runner));

		const { emit } = makeEmitter();
		const cloud = recordingCloud([
			JSON.stringify({ kind: 'sufficient' }),                          // S1 phase-1
			JSON.stringify({ kind: 'deliverable', body: 'STEP-1 BODY' }),    // S1 phase-2
			JSON.stringify({ kind: 'sufficient' }),                          // S2 phase-1 (runner reads from ctx after)
		]);
		const result = await runMetaTask({
			templateId: 'test-runner-deliverables',
			intent: 'runner-deliverables',
			scope: { intent: 'runner-deliverables', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [] },
			sessionId: 'sess-p2r-7',
			emit, cloud,
			embed: async () => [],
			allocId: () => 'mt-p2r-7',
		});
		assert.equal(result.outcome, 'completed');
		assert.equal(seenDeliverables.length, 1, 'runner invoked once');
		assert.equal(seenDeliverables[0]!.get(1), 'STEP-1 BODY', 'runner sees step-1 body inline');
		assert.equal(seenDeliverables[0]!.get(2), undefined, 'runner does NOT see its own (current) body');
		assert.match(result.deliverables.get(2)!, /merged: STEP-1 BODY/);
	} finally { env.restore(); _clearRegistryForTests(); }
});


// ---------------------------------------------------------------------------
// Phase2Out shape sanity (defensive)
// ---------------------------------------------------------------------------

test('phase2 runner: malformed output (extra fields) still typechecks via Phase2Out', () => {
	// Compile-time check: any well-formed Phase2Out passes.
	const samples: Phase2Out[] = [
		{ kind: 'deliverable', body: 'ok' },
		{ kind: 'abort', resolution: 'user-required', reason: 'x' },
		{ kind: 'abort', resolution: 'plan-revisable', reason: 'x', hint: 'h' },
		{ kind: 'context-needed', requests: [{ kind: 'files', globs: ['**'] }], reason: 'r' },
	];
	assert.equal(samples.length, 4);
});
