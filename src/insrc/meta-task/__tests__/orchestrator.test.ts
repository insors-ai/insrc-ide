/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Orchestrator tests. Scripted cloud LLM + fake TodosApi + tmp persistRoot so we
 * can exercise the full two-phase loop deterministically without external
 * services.
 *
 * Three classes of scenarios covered:
 *   1. Happy path: phase 1 'sufficient' -> phase 2 'deliverable'.
 *   2. Context-needed retry loop: phase 2 -> 'context-needed' (with reason) ->
 *      phase 1 refetches -> phase 2 'deliverable'. Cap exhaustion -> abort.
 *   3. Abort: cloud LLM emits 'abort' -> step + meta-task end aborted.
 *
 * Narrowing tests are deferred to M3 (where fetchers we can easily script
 * are wired in). For M1+M2 the narrowing loop is covered by fetcher unit
 * tests + the schema/dispatcher pairing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMProvider, LLMResponse } from '../../shared/types.js';
import { runMetaTask } from '../orchestrator.js';
import { MetaTaskEmitter } from '../event-emitter.js';
import { PATHS } from '../../shared/paths.js';
import type { OutboundMessage } from '../event-emitter.js';

// Bootstrap the template registry so `/review` is discoverable.
import '../templates/index.js';


// ---------------------------------------------------------------------------
// Helpers: scripted cloud LLM + fake TodosApi.
// ---------------------------------------------------------------------------

class ScriptedCloud implements LLMProvider {
	private idx = 0;
	constructor(private readonly responses: readonly string[]) {}
	async complete(_messages: unknown, opts?: { onToken?: (t: string) => void }): Promise<LLMResponse> {
		const text = this.responses[this.idx++] ?? '';
		if (opts?.onToken !== undefined) {
			opts.onToken(text);
		}
		return { text, stopReason: 'end_turn' };
	}
	stream(): AsyncIterable<string> {
		// Not exercised by the orchestrator paths under test.
		return (async function* () { yield ''; })();
	}
	async embed(): Promise<number[]> { return []; }
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
	async markComplete(itemId: string): Promise<unknown> { this.calls.push(`markComplete:${itemId}`); return {}; }
	async markBlocked(itemId: string, reason: string): Promise<unknown> { this.calls.push(`markBlocked:${itemId}:${reason}`); return {}; }
	async updateListBody(listId: string, _body: string): Promise<unknown> { this.calls.push(`updateListBody:${listId}`); return {}; }
}

function setupEnv(): { home: string; restore: () => void } {
	const home = mkdtempSync(join(tmpdir(), 'mt-orch-'));
	const restore = process.env.HOME;
	process.env.HOME = home;
	// PATHS.meta was resolved at module load; we have to point its computed
	// value somewhere we can clean up. Easier: just monkey-patch PATHS.meta.
	const originalMeta = PATHS.meta;
	(PATHS as { meta: string }).meta = join(home, '.insrc', 'meta');
	return {
		home,
		restore: () => {
			(PATHS as { meta: string }).meta = originalMeta;
			if (restore !== undefined) { process.env.HOME = restore; }
			try { rmSync(home, { recursive: true, force: true }); } catch { /* skip */ }
		},
	};
}

function makeEmitter(): { emit: MetaTaskEmitter; todos: FakeTodosApi; events: OutboundMessage[] } {
	const events: OutboundMessage[] = [];
	const todos = new FakeTodosApi();
	const emit = new MetaTaskEmitter({
		send:  msg => events.push(msg),
		todos: todos as unknown as MetaTaskEmitter['todos'],
	});
	return { emit, todos, events };
}


// ---------------------------------------------------------------------------
// Happy path: 'sufficient' -> 'deliverable'
// ---------------------------------------------------------------------------

test('runMetaTask: happy path /review with sufficient + deliverable', async () => {
	const env = setupEnv();
	try {
		const { emit, todos, events } = makeEmitter();
		const cloud = new ScriptedCloud([
			JSON.stringify({ kind: 'sufficient' }),
			JSON.stringify({ kind: 'deliverable', body: '# Review\n\n## Findings\n- One' }),
		]);
		const result = await runMetaTask({
			templateId: 'review',
			intent:     'look at parser.ts',
			scope: {
				intent:          'look at parser.ts',
				repoPath:        env.home,
				inScopeGlobs:    ['**'],
				outOfScopePaths: [],
			},
			sessionId: 'sess-1',
			emit,
			cloud,
			embed:    async () => [],
			allocId:  () => 'mt-test-happy',
		});
		assert.equal(result.outcome, 'completed');
		assert.equal(result.deliverables.size, 1);
		assert.ok(result.deliverables.get(1)!.includes('Findings'));

		// TodoList lifecycle should fire: createList, addItem, markInProgress, markComplete, updateListBody.
		assert.ok(todos.calls.some(c => c.startsWith('createList:')));
		assert.ok(todos.calls.some(c => c.startsWith('addItem:')));
		assert.ok(todos.calls.some(c => c.startsWith('markInProgress:')));
		assert.ok(todos.calls.some(c => c.startsWith('markComplete:')));
		assert.ok(todos.calls.some(c => c.startsWith('updateListBody:')));

		// Persistence side effects.
		const rootDir = join(PATHS.meta, 'mt-test-happy');
		assert.ok(existsSync(join(rootDir, 'meta.json')));
		assert.ok(existsSync(join(rootDir, 'plan.json')));
		const meta = JSON.parse(readFileSync(join(rootDir, 'meta.json'), 'utf8'));
		assert.equal(meta.templateId, 'review');
		assert.equal(meta.planRevisionCount, 0);

		// IPC events: at least liveStep, progress, done.
		const streams = new Set(events.map(e => e.stream));
		assert.ok(streams.has('liveStep'));
		assert.ok(streams.has('progress'));
		assert.ok(streams.has('done'));
	} finally {
		env.restore();
	}
});


// ---------------------------------------------------------------------------
// Context-needed retry: cloud -> ctx-needed (with reason) -> phase 1 again
// (still says sufficient) -> deliverable.
// ---------------------------------------------------------------------------

test('runMetaTask: phase-2 context-needed loops back through phase 1, then succeeds', async () => {
	const env = setupEnv();
	try {
		const { emit, todos } = makeEmitter();
		const cloud = new ScriptedCloud([
			// Iteration 1
			JSON.stringify({ kind: 'sufficient' }),                                       // phase-1 ask
			JSON.stringify({ kind: 'context-needed',
				requests: [{ kind: 'files', globs: ['**/*.ts'] }],
				reason:   'I need to see the actual parser.ts file' }),                     // phase-2 -> retry
			// Iteration 2
			JSON.stringify({ kind: 'sufficient' }),                                       // phase-1 ask retry
			JSON.stringify({ kind: 'deliverable', body: '# Review\n\n## Findings\n- One' }),  // phase-2 success
		]);
		const result = await runMetaTask({
			templateId: 'review',
			intent:     'test',
			scope: {
				intent: 'test', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [],
			},
			sessionId: 'sess-2',
			emit,
			cloud,
			embed:    async () => [],
			allocId:  () => 'mt-test-retry',
		});
		assert.equal(result.outcome, 'completed');
		assert.equal(result.deliverables.size, 1);
		assert.ok(todos.calls.some(c => c.startsWith('markComplete:')));
	} finally {
		env.restore();
	}
});


// ---------------------------------------------------------------------------
// Context-needed cap exhaustion -> abort
// ---------------------------------------------------------------------------

test('runMetaTask: context-needed cap exhausted -> abort', async () => {
	const env = setupEnv();
	try {
		const { emit, todos } = makeEmitter();
		// Default cap is 3 context-needed retries. We script 4 retries (5 phase-2
		// calls) -- the 4th rejection trips the cap.
		const ctxNeeded = JSON.stringify({
			kind:     'context-needed',
			requests: [{ kind: 'files', globs: ['**/*.ts'] }],
			reason:   'still insufficient',
		});
		const cloud = new ScriptedCloud([
			JSON.stringify({ kind: 'sufficient' }), ctxNeeded,
			JSON.stringify({ kind: 'sufficient' }), ctxNeeded,
			JSON.stringify({ kind: 'sufficient' }), ctxNeeded,
			JSON.stringify({ kind: 'sufficient' }), ctxNeeded,
			JSON.stringify({ kind: 'sufficient' }), ctxNeeded,  // cap trips here
		]);
		const result = await runMetaTask({
			templateId: 'review',
			intent:     'test',
			scope: {
				intent: 'test', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [],
			},
			sessionId: 'sess-3',
			emit,
			cloud,
			embed:    async () => [],
			allocId:  () => 'mt-test-cap',
		});
		assert.equal(result.outcome, 'aborted');
		assert.ok(result.abortReason !== undefined);
		assert.ok(result.abortReason!.includes('cap'));
		assert.ok(todos.calls.some(c => c.startsWith('markBlocked:')));
	} finally {
		env.restore();
	}
});


// ---------------------------------------------------------------------------
// Phase-2 abort -> meta-task aborts immediately.
// ---------------------------------------------------------------------------

test('runMetaTask: phase-2 abort terminates the step', async () => {
	const env = setupEnv();
	try {
		const { emit, todos } = makeEmitter();
		const cloud = new ScriptedCloud([
			JSON.stringify({ kind: 'sufficient' }),
			JSON.stringify({
				kind:       'abort',
				reason:     'acceptance criteria conflict',
				resolution: 'user-required',
				hint:       'user needs to clarify scope',
			}),
		]);
		const result = await runMetaTask({
			templateId: 'review',
			intent:     'test',
			scope: {
				intent: 'test', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [],
			},
			sessionId: 'sess-4',
			emit,
			cloud,
			embed:    async () => [],
			allocId:  () => 'mt-test-abort',
		});
		assert.equal(result.outcome, 'aborted');
		assert.ok(result.abortReason!.includes('user-required'));
		assert.ok(result.abortReason!.includes('acceptance criteria conflict'));
		assert.ok(todos.calls.some(c => c.startsWith('markBlocked:')));
	} finally {
		env.restore();
	}
});


// ---------------------------------------------------------------------------
// Unknown template id -> immediate error
// ---------------------------------------------------------------------------

test('runMetaTask: unknown templateId throws', async () => {
	const env = setupEnv();
	try {
		const { emit } = makeEmitter();
		await assert.rejects(
			runMetaTask({
				templateId: 'not-a-template',
				intent:     'test',
				scope: {
					intent: 'test', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [],
				},
				sessionId: 'sess-5',
				emit,
				cloud:    new ScriptedCloud([]),
				embed:    async () => [],
			}),
			/unknown meta-task template/,
		);
	} finally {
		env.restore();
	}
});
