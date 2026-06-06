/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the Q8 progress-event payloads (P6 TodoList wiring).
 *
 * Pins what `runSectionFlow` emits on each phase so the daemon-side
 * controller (data-analyzer-orchestrator.ts:_wireProgressToTodos) can
 * rely on the meta shape:
 *
 *   - 'plan'                 -> meta.todos[] carries every TODO with
 *                               id/objective/origin so the controller
 *                               can addItem-per-TODO before per-TODO
 *                               execution starts.
 *   - 'todo-start'           -> meta.{todoId, index, objective, origin}.
 *   - 'todo-complete'        -> meta.{todoId, index, l2, replans,
 *                               fallback, subItems} where subItems is
 *                               one entry per reviewable root with
 *                               status text covering the verdict +
 *                               cycle count + exhausted bit.
 *   - 'scope-gap-todo-added' -> meta.{todoId, objective, origin}
 *                               (origin === 'report-review-escalation').
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	runSectionFlow,
	type ProgressEvent,
} from '../run-section-flow.js';
import { _resetBulletsTableCache } from '../../../db/lance/working-memory-bullets.js';
import { closeLanceConn, setLanceConnPath } from '../../../db/lance/conn.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import type { ExecuteLeaf } from '../step-root-execution.js';
import type { L2Fallback } from '../todo-orchestrator.js';

// ---------------------------------------------------------------------------
// Tmp Lance + working-memory dirs (same pattern as run-section-flow.test.ts).
// ---------------------------------------------------------------------------

let lanceDir: string;
let memoryDir: string;

test.beforeEach(async () => {
	await closeLanceConn();
	_resetBulletsTableCache();
	lanceDir = mkdtempSync(join(tmpdir(), 'insrc-sf-progress-lance-'));
	memoryDir = mkdtempSync(join(tmpdir(), 'insrc-sf-progress-memory-'));
	setLanceConnPath(join(lanceDir, 'lance'));
});

test.afterEach(async () => {
	await closeLanceConn();
	_resetBulletsTableCache();
	rmSync(lanceDir, { recursive: true, force: true });
	rmSync(memoryDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function scriptedProvider(responses: readonly string[]): LLMProvider {
	let cursor = 0;
	return {
		supportsTools: true,
		async complete(_messages: LLMMessage[], _opts: CompletionOpts = {}): Promise<LLMResponse> {
			if (cursor >= responses.length) {
				throw new Error(`scriptedProvider: ran out of responses at call ${cursor + 1}`);
			}
			const text = responses[cursor]!;
			cursor++;
			return { text, stopReason: 'end_turn' };
		},
		async *stream(): AsyncIterable<string> { yield ''; },
		async embed(): Promise<number[]> { return []; },
	} as unknown as LLMProvider;
}

const HEALTHY_TREE_JSON = JSON.stringify({
	intentBrief: 'investigation',
	root: {
		id: 'root', title: 'root', objective: 'r', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
		children: [
			{ id: 'discover', title: 'd', objective: 'd', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
				children: [{ id: 'd1', title: 'd1', objective: 'd1', kind: 'leaf', skill: 'shared.discover', inputs: {}, emit: 'intermediate' }] },
			{ id: 'synthesize', title: 's', objective: 's', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'section',
				children: [{ id: 's1', title: 's1', objective: 's1', kind: 'leaf', skill: 'shared.write', inputs: { d: { source: 'node', nodeId: 'discover', path: '$' } }, emit: 'section' }] },
		],
	},
});

const accept = JSON.stringify({ verdict: 'accept', reasoning: 'ok' });

const SCOPE_M_REVIEW = JSON.stringify({ scope: 'M', subtype: 'review', reasoning: 'm' });

const executeLeaf: ExecuteLeaf = async (input) => `<output:${input.leaf.id}>`;
const l2Fallback:  L2Fallback   = async () => 'UNUSED';

const bulletExtractResponse = JSON.stringify({ bullets: ['fact'] });

// ---------------------------------------------------------------------------
// Plan event
// ---------------------------------------------------------------------------

test("'plan' event carries todos[] with id+objective+origin", async () => {
	const plan = JSON.stringify({
		todos: [
			{ id: 't-first',  objective: 'First investigation'  },
			{ id: 't-second', objective: 'Second investigation' },
		],
		reasoning: 'two-TODO plan',
	});
	const provider = scriptedProvider([
		SCOPE_M_REVIEW,
		plan,
		// TODO 1
		HEALTHY_TREE_JSON,
		accept, accept,
		accept,
		bulletExtractResponse,
		// TODO 2 (incremental update; 3 layer calls + section tree)
		JSON.stringify({ summary:  's' }),
		JSON.stringify({ recent:   'r' }),
		JSON.stringify({ semantic: 'se' }),
		HEALTHY_TREE_JSON,
		accept, accept,
		accept,
		bulletExtractResponse,
		// Report
		'# Final\n',
		accept,
	]);

	const events: ProgressEvent[] = [];
	await runSectionFlow({
		question:         'Q',
		provider,
		executeLeaf,
		l2Fallback,
		runId:            'r-1',
		workingMemoryDir: join(memoryDir, 'r-1'),
		onProgress:       (e) => { events.push(e); },
	});

	const planEvent = events.find(e => e.phase === 'plan');
	assert.ok(planEvent !== undefined);
	const todos = planEvent.meta!['todos'] as Array<Record<string, string>>;
	assert.equal(todos.length, 2);
	assert.equal(todos[0]!['id'], 't-first');
	assert.equal(todos[0]!['origin'], 'initial');
	assert.equal(todos[1]!['id'], 't-second');
});

// ---------------------------------------------------------------------------
// todo-start / todo-complete events
// ---------------------------------------------------------------------------

test("'todo-start' event carries todoId, index, objective, origin", async () => {
	const plan = JSON.stringify({ todos: [{ id: 't-only', objective: 'Single TODO' }], reasoning: 'r' });
	const provider = scriptedProvider([
		SCOPE_M_REVIEW,
		plan,
		HEALTHY_TREE_JSON,
		accept, accept,
		accept,
		bulletExtractResponse,
		'# Final\n',
		accept,
	]);
	const events: ProgressEvent[] = [];
	await runSectionFlow({
		question:         'Q',
		provider,
		executeLeaf,
		l2Fallback,
		runId:            'r-2',
		workingMemoryDir: join(memoryDir, 'r-2'),
		onProgress:       (e) => { events.push(e); },
	});

	const startEvent = events.find(e => e.phase === 'todo-start');
	assert.ok(startEvent !== undefined);
	assert.equal(startEvent.meta!['todoId'], 't-only');
	assert.equal(startEvent.meta!['index'], 0);
	assert.equal(startEvent.meta!['objective'], 'Single TODO');
	assert.equal(startEvent.meta!['origin'], 'initial');
});

test("'todo-complete' event carries subItems with verdict + status text", async () => {
	const plan = JSON.stringify({ todos: [{ id: 't-only', objective: 'X' }], reasoning: 'r' });
	const provider = scriptedProvider([
		SCOPE_M_REVIEW,
		plan,
		HEALTHY_TREE_JSON,
		accept, accept,
		accept,
		bulletExtractResponse,
		'# Final\n',
		accept,
	]);
	const events: ProgressEvent[] = [];
	await runSectionFlow({
		question:         'Q',
		provider,
		executeLeaf,
		l2Fallback,
		runId:            'r-3',
		workingMemoryDir: join(memoryDir, 'r-3'),
		onProgress:       (e) => { events.push(e); },
	});

	const completeEvent = events.find(e => e.phase === 'todo-complete');
	assert.ok(completeEvent !== undefined);
	const subItems = completeEvent.meta!['subItems'] as Array<Record<string, unknown>>;
	assert.equal(subItems.length, 2);    // discover + synthesize
	assert.equal(subItems[0]!['id'], 'discover');
	assert.equal(subItems[0]!['status'], 'complete');
	// No followups -> status text is just the verdict (no cycle count).
	assert.equal(subItems[0]!['statusText'], 'accept');
	assert.equal(subItems[1]!['id'], 'synthesize');
});

test("'todo-complete' surfaces L2 fallback bit when section tree fails", async () => {
	const plan = JSON.stringify({ todos: [{ id: 't-only', objective: 'X' }], reasoning: 'r' });
	// Force planner to throw (degenerate tree x2) so L2 kicks in.
	const degenerate = JSON.stringify({
		intentBrief: 'bad',
		root: { id: 'r', title: 'r', objective: 'r', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
			children: [{ id: 'only', title: 'o', objective: 'o', kind: 'leaf', skill: 'shared.x', inputs: {}, emit: 'section' }] },
	});
	const provider = scriptedProvider([
		SCOPE_M_REVIEW,
		plan,
		degenerate, degenerate,    // planner throws
		bulletExtractResponse,
		'# Final\n',
		accept,
	]);
	const l2: L2Fallback = async () => 'L2 OUTPUT';
	const events: ProgressEvent[] = [];
	await runSectionFlow({
		question:         'Q',
		provider,
		executeLeaf,
		l2Fallback:       l2,
		runId:            'r-4',
		workingMemoryDir: join(memoryDir, 'r-4'),
		onProgress:       (e) => { events.push(e); },
	});

	const completeEvent = events.find(e => e.phase === 'todo-complete');
	assert.ok(completeEvent !== undefined);
	assert.equal(completeEvent.meta!['l2'], true);
	assert.equal(completeEvent.meta!['fallback'], 'L2');
});

// ---------------------------------------------------------------------------
// Phase ordering
// ---------------------------------------------------------------------------

test('phase ordering: scope -> plan -> todo-start -> todo-complete -> report-assemble -> report-review -> cleanup', async () => {
	const plan = JSON.stringify({ todos: [{ id: 't', objective: 'X' }], reasoning: 'r' });
	const provider = scriptedProvider([
		SCOPE_M_REVIEW,
		plan,
		HEALTHY_TREE_JSON,
		accept, accept,
		accept,
		bulletExtractResponse,
		'# Final\n',
		accept,
	]);
	const events: ProgressEvent[] = [];
	await runSectionFlow({
		question:         'Q',
		provider,
		executeLeaf,
		l2Fallback,
		runId:            'r-5',
		workingMemoryDir: join(memoryDir, 'r-5'),
		onProgress:       (e) => { events.push(e); },
	});

	const phases = events.map(e => e.phase);
	assert.deepEqual(phases, [
		'scope',
		'plan',
		'todo-start',
		'todo-complete',
		'report-assemble',
		'report-review',
		'cleanup',
	]);
});

// ---------------------------------------------------------------------------
// async onProgress callbacks are awaited
// ---------------------------------------------------------------------------

test('async onProgress callbacks resolve before next phase starts', async () => {
	const plan = JSON.stringify({ todos: [{ id: 't', objective: 'X' }], reasoning: 'r' });
	const provider = scriptedProvider([
		SCOPE_M_REVIEW,
		plan,
		HEALTHY_TREE_JSON,
		accept, accept,
		accept,
		bulletExtractResponse,
		'# Final\n',
		accept,
	]);
	const order: string[] = [];
	await runSectionFlow({
		question:         'Q',
		provider,
		executeLeaf,
		l2Fallback,
		runId:            'r-6',
		workingMemoryDir: join(memoryDir, 'r-6'),
		onProgress:       async (e) => {
			order.push(`enter:${e.phase}`);
			// Simulate slow workbench write.
			await new Promise<void>(r => setTimeout(r, 5));
			order.push(`exit:${e.phase}`);
		},
	});

	// For every phase, enter must immediately precede exit (no
	// interleaving even with the awaited 5ms gap).
	for (let i = 0; i + 1 < order.length; i += 2) {
		const enter = order[i]!;
		const exit  = order[i + 1]!;
		assert.equal(enter.startsWith('enter:'), true);
		assert.equal(exit.startsWith('exit:'),   true);
		assert.equal(enter.slice('enter:'.length), exit.slice('exit:'.length));
	}
});

// ---------------------------------------------------------------------------
// onProgress thrown errors are swallowed
// ---------------------------------------------------------------------------

test('onProgress that throws is swallowed; pipeline keeps running', async () => {
	const plan = JSON.stringify({ todos: [{ id: 't', objective: 'X' }], reasoning: 'r' });
	const provider = scriptedProvider([
		SCOPE_M_REVIEW,
		plan,
		HEALTHY_TREE_JSON,
		accept, accept,
		accept,
		bulletExtractResponse,
		'# Final\n',
		accept,
	]);
	const result = await runSectionFlow({
		question:         'Q',
		provider,
		executeLeaf,
		l2Fallback,
		runId:            'r-7',
		workingMemoryDir: join(memoryDir, 'r-7'),
		onProgress:       () => { throw new Error('callback exploded'); },
	});
	// Pipeline completed successfully despite the throw.
	assert.equal(result.entries.length, 1);
	assert.match(result.finalReport, /# Final/);
});
