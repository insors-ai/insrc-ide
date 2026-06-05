/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Integration test for the top-level section-flow orchestrator
 * (P5.a). Drives the full pipeline (scope -> plan -> per-TODO ->
 * report review) end-to-end with a scripted provider and an
 * injected `executeLeaf` mock.
 *
 * Bullet cache and working-memory persistence run against real tmp
 * directories so we exercise the LanceDB + filesystem wiring, but
 * the provider returns an empty embedding vector throughout so the
 * cache stays empty and never actually drives semantic-layer lookups
 * (the LLM-fallback path is exercised in updater.test.ts).
 *
 * Covered:
 * - Happy path single-TODO (fast-path, simplest pipeline shape).
 * - Multi-TODO plan: per-TODO sections produced, persisted to the
 *   working-memory store, then assembled + reviewed.
 * - Trace surfaces every phase: scope / investigation plan /
 *   per-TODO / report review.
 * - Final report is the assembler's output verbatim when the
 *   reviewer accepts on first pass.
 * - Working-memory entries are persisted in order on disk; the
 *   accumulatedMemoryText format matches what the next-TODO shape
 *   step would consume.
 * - Progress events fire at every phase transition.
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
import { openWorkingMemoryStore } from '../../working-memory/index.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import type { ExecuteLeaf, LeafExecutionInput } from '../step-root-execution.js';
import type { L2Fallback } from '../todo-orchestrator.js';

// ---------------------------------------------------------------------------
// Lance tmp dir setup (same pattern as working-memory-bullets.test.ts)
// ---------------------------------------------------------------------------

let lanceDir: string;
let memoryDir: string;

test.beforeEach(async () => {
	await closeLanceConn();
	_resetBulletsTableCache();
	lanceDir = mkdtempSync(join(tmpdir(), 'insrc-sf-lance-'));
	memoryDir = mkdtempSync(join(tmpdir(), 'insrc-sf-memory-'));
	setLanceConnPath(join(lanceDir, 'lance'));
});

test.afterEach(async () => {
	await closeLanceConn();
	_resetBulletsTableCache();
	rmSync(lanceDir, { recursive: true, force: true });
	rmSync(memoryDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scripted provider
// ---------------------------------------------------------------------------

interface ScriptedProvider {
	provider: LLMProvider;
	calls:    { messages: LLMMessage[]; opts: CompletionOpts }[];
}

function scriptedProvider(responses: readonly string[]): ScriptedProvider {
	const calls: { messages: LLMMessage[]; opts: CompletionOpts }[] = [];
	let cursor = 0;
	const provider = {
		supportsTools: true,
		async complete(messages: LLMMessage[], opts: CompletionOpts = {}): Promise<LLMResponse> {
			calls.push({ messages, opts });
			if (cursor >= responses.length) {
				throw new Error(`scriptedProvider: ran out of responses at call ${cursor + 1}`);
			}
			const text = responses[cursor]!;
			cursor++;
			return { text, stopReason: 'end_turn' };
		},
		async *stream(): AsyncIterable<string> { yield ''; },
		// Returns [] so the bullet-cache write step skips (cloud-provider
		// fallback path; the test doesn't exercise the real cache hit
		// since that requires real embeddings).
		async embed(): Promise<number[]> { return []; },
	} as unknown as LLMProvider;
	return { provider, calls };
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

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const accept = JSON.stringify({ verdict: 'accept', reasoning: 'ok' });

function leafExec(outputs: Record<string, string>): { executeLeaf: ExecuteLeaf; calls: LeafExecutionInput[] } {
	const calls: LeafExecutionInput[] = [];
	const executeLeaf: ExecuteLeaf = async (input) => {
		calls.push(input);
		return outputs[input.leaf.id] ?? `<output:${input.leaf.id}>`;
	};
	return { executeLeaf, calls };
}

const l2Fallback: L2Fallback = async () => 'UNUSED-L2';

const SCOPE_M_REVIEW = JSON.stringify({ scope: 'M', subtype: 'review', reasoning: 'm' });

// ---------------------------------------------------------------------------
// Single-TODO happy path
// ---------------------------------------------------------------------------

test('single-TODO happy path: scope -> plan -> 1 TODO -> assemble -> review accept', async () => {
	const plan = JSON.stringify({
		todos:     [{ id: 't1', objective: 'Audit X' }],
		reasoning: 'single TODO',
	});

	const { provider } = scriptedProvider([
		SCOPE_M_REVIEW,                  // Step 1 scope
		plan,                             // Step 2 plan
		// Per-TODO 1:
		HEALTHY_TREE_JSON,                // section planner
		accept,                           // discover root review
		accept,                           // synthesize root review
		accept,                           // section review
		// Bullet extraction (after entry write):
		JSON.stringify({ bullets: ['fact A', 'fact B'] }),
		// Report:
		'# Final Report\n\nAssembled.',   // assemble (markdown)
		accept,                           // report review
	]);

	const { executeLeaf } = leafExec({
		d1: 'discover output',
		s1: '# Section\n\nbody',
	});

	const progressEvents: ProgressEvent[] = [];

	const result = await runSectionFlow({
		question:           'Q',
		provider,
		executeLeaf,
		l2Fallback,
		runId:              'run-1',
		workingMemoryDir:   join(memoryDir, 'run-1'),
		onProgress:         (e) => progressEvents.push(e),
	});

	assert.equal(result.entries.length, 1);
	assert.equal(result.entries[0]!.todoId, 't1');
	assert.equal(result.finalReport, '# Final Report\n\nAssembled.');
	assert.equal(result.trace.scope.scope, 'M');
	assert.equal(result.trace.investigationPlan.todos.length, 1);
	assert.equal(result.trace.perTodo.length, 1);
	assert.equal(result.trace.reportReview.cyclesConsumed, 0);
	assert.equal(result.trace.reportReview.exhausted, false);

	// Progress events fire at every phase transition.
	const phases = progressEvents.map(e => e.phase);
	assert.ok(phases.includes('scope'));
	assert.ok(phases.includes('plan'));
	assert.ok(phases.includes('todo-start'));
	assert.ok(phases.includes('todo-complete'));
	assert.ok(phases.includes('report-assemble'));
	assert.ok(phases.includes('report-review'));
	assert.ok(phases.includes('cleanup'));

	// Entry persisted on disk.
	const store = openWorkingMemoryStore(join(memoryDir, 'run-1'));
	const persisted = await store.listEntries();
	assert.equal(persisted.length, 1);
	assert.equal(persisted[0]!.entry.todoId, 't1');
});

// ---------------------------------------------------------------------------
// Multi-TODO plan
// ---------------------------------------------------------------------------

test('multi-TODO plan: 2 TODOs run sequentially, both entries persisted', async () => {
	const plan = JSON.stringify({
		todos: [
			{ id: 't1', objective: 'First investigation' },
			{ id: 't2', objective: 'Second investigation' },
		],
		reasoning: 'two-TODO plan',
	});

	// Bullet response template (same for every TODO completion).
	const bullets = JSON.stringify({ bullets: ['fact'] });

	// Layer-update responses: incrementalUpdate fires 3 LLM calls per
	// TODO transition (summary / recent polish / semantic; the bullet
	// cache falls back to LLM because provider.embed returns []).
	const summaryLayer  = JSON.stringify({ summary:  'updated summary' });
	const recentLayer   = JSON.stringify({ recent:   '- new recent' });
	const semanticLayer = JSON.stringify({ semantic: '- new semantic' });

	const { provider } = scriptedProvider([
		SCOPE_M_REVIEW,
		plan,
		// TODO 1 (cold rebuild; empty memory short-circuits the shape call):
		HEALTHY_TREE_JSON,
		accept, accept,                    // 2 root reviews
		accept,                            // section review
		bullets,                           // bullet extraction
		// TODO 2 (incremental update + section flow):
		summaryLayer, recentLayer, semanticLayer,   // 3 layer updates
		HEALTHY_TREE_JSON,
		accept, accept,
		accept,
		bullets,
		// Report:
		'# Final Report\n\nTwo sections.',
		accept,
	]);

	const { executeLeaf } = leafExec({ d1: 'd', s1: 'sec' });

	const result = await runSectionFlow({
		question:         'Q',
		provider,
		executeLeaf,
		l2Fallback,
		runId:            'run-multi',
		workingMemoryDir: join(memoryDir, 'run-multi'),
	});

	assert.equal(result.entries.length, 2);
	assert.deepEqual(result.entries.map(e => e.todoId), ['t1', 't2']);
	assert.equal(result.trace.perTodo.length, 2);

	const store = openWorkingMemoryStore(join(memoryDir, 'run-multi'));
	const persisted = await store.listEntries();
	assert.equal(persisted.length, 2);
	assert.deepEqual(persisted.map(e => e.index), [0, 1]);
});

// ---------------------------------------------------------------------------
// L2 fallback path
// ---------------------------------------------------------------------------

test('L2 fallback fires when the per-TODO orchestrator throws all the way through', async () => {
	const plan = JSON.stringify({
		todos:     [{ id: 't1', objective: 'something' }],
		reasoning: 'one',
	});

	// Pre-cooked failure: section planner returns a degenerate tree
	// twice -> planner throws -> TODO orchestrator falls back to L2.
	const degenerateTree = JSON.stringify({
		intentBrief: 'bad',
		root: { id: 'r', title: 'r', objective: 'r', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
			children: [{ id: 'only', title: 'o', objective: 'o', kind: 'leaf', skill: 'shared.x', inputs: {}, emit: 'section' }] },
	});

	const { provider } = scriptedProvider([
		SCOPE_M_REVIEW,
		plan,
		degenerateTree, degenerateTree,    // planner throws after retry
		// Bullet extraction for the L2 entry.
		JSON.stringify({ bullets: [] }),
		// Report:
		'# Final Report\n\nL2 only.',
		accept,
	]);

	let l2Calls = 0;
	const l2Fb: L2Fallback = async () => {
		l2Calls += 1;
		return '# L2 SECTION\n\nL2-produced markdown.';
	};
	const { executeLeaf } = leafExec({});

	const result = await runSectionFlow({
		question:         'Q',
		provider,
		executeLeaf,
		l2Fallback:       l2Fb,
		runId:            'run-l2',
		workingMemoryDir: join(memoryDir, 'run-l2'),
	});

	assert.equal(l2Calls, 1);
	assert.equal(result.entries.length, 1);
	assert.equal(result.entries[0]!.findings.fallback, 'L2');
	assert.match(result.entries[0]!.detail, /L2-produced markdown/);
});

// ---------------------------------------------------------------------------
// Defaults / type sanity
// ---------------------------------------------------------------------------

test('runSectionFlow: default budget + numCtx work without crashes', async () => {
	const plan = JSON.stringify({
		todos:     [{ id: 't1', objective: 'X' }],
		reasoning: 'r',
	});
	const { provider } = scriptedProvider([
		SCOPE_M_REVIEW,
		plan,
		HEALTHY_TREE_JSON,
		accept, accept,
		accept,
		JSON.stringify({ bullets: [] }),
		'# R\n',
		accept,
	]);
	const { executeLeaf } = leafExec({ d1: 'd', s1: 's' });
	const result = await runSectionFlow({
		question:         'Q',
		provider,
		executeLeaf,
		l2Fallback,
		runId:            'run-defaults',
		workingMemoryDir: join(memoryDir, 'run-defaults'),
	});
	assert.equal(result.finalReport.length > 0, true);
});
