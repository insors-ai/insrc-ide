/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Tests for the per-root execution + review + followup loop (P3.b).
 *
 * Covered:
 * - DFS leaf walk: leaves execute in declared order; outputs accumulate
 *   in the aggregate string and the per-leaf map.
 * - Review parse: verdict enum coerced, malformed JSON degrades to
 *   `accept` (safer than retry-storm), suggested_leaves coerced into
 *   PlannedNode shape.
 * - Single-root happy path: review accepts immediately, finding has
 *   cyclesConsumed=0, exhausted=false.
 * - Followup loop: reviewer requests N followups; orchestrator
 *   executes each, increments cycle counter, re-reviews. Acceptable
 *   chain (followup-followup-accept) -> verdict 'accept',
 *   cyclesConsumed reflects, exhausted false.
 * - Cap-hit: 4 consecutive followup verdicts; loop force-accepts at
 *   cycle 3, verdict 'force-accept', exhausted=true.
 * - Revise-major escalation: reviewer returns revise-major;
 *   loop returns with reopenRequested=true; subsequent roots NOT
 *   executed.
 * - Empty followup suggested leaves: reviewer says followup but
 *   suggests nothing -> cycle counted but no execution.
 * - Multi-root happy path: 3 roots run sequentially; outputs flow
 *   into compositionOutputs map; final findings include all 3 roots.
 * - LLM contract: review calls send disableThinking + temperature 0
 *   + responseFormat 'json'.
 * - Degenerate tree (single-leaf top-level) -> escalates immediately.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	executeReviewableRoots,
	_parseReviewForTest as parseReview,
	_coerceLeafForTest as coerceLeaf,
	_executeLeavesDfsForTest as executeLeavesDfs,
	_composeFindingContentForTest as composeFindingContent,
	FOLLOWUP_CYCLE_CAP_VALUE,
	MAX_FOLLOWUP_LEAVES_VALUE,
	type ExecuteLeaf,
	type LeafExecutionInput,
} from '../step-root-execution.js';
import type { PlannedNode, PlannedTree } from '../../content-gen/plan-tree.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import type { MemoryShapeBundle } from '../../working-memory/index.js';
import type { TodoSpec } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface RecordedCall {
	readonly messages: LLMMessage[];
	readonly opts:     CompletionOpts;
}

function scriptedProvider(responses: readonly string[]): { provider: LLMProvider; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
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
		async embed(): Promise<number[]> { return []; },
	} as unknown as LLMProvider;
	return { provider, calls };
}

function leafExecutor(outputsByLeafId: Record<string, string>): { execute: ExecuteLeaf; calls: LeafExecutionInput[] } {
	const calls: LeafExecutionInput[] = [];
	const execute: ExecuteLeaf = async (input) => {
		calls.push(input);
		return outputsByLeafId[input.leaf.id] ?? `<output:${input.leaf.id}>`;
	};
	return { execute, calls };
}

function leaf(id: string, skill = 'shared.x'): PlannedNode {
	return { id, title: id, objective: `o-${id}`, kind: 'leaf', skill, inputs: {}, emit: 'intermediate' };
}

function compositionRoot(rootId: string, children: PlannedNode[], emit: PlannedNode['emit'] = 'intermediate'): PlannedNode {
	return { id: rootId, title: rootId, objective: `o-${rootId}`, kind: 'composition', composition: 'sequence', inputs: {}, emit, children };
}

function tree(children: PlannedNode[]): PlannedTree {
	return {
		intentBrief: 'test',
		root: { id: 'top', title: 'top', objective: 'top', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate', children },
	};
}

function memory(overrides: Partial<MemoryShapeBundle> = {}): MemoryShapeBundle {
	return {
		system: '', summary: '', recent: '', semantic: '', code: '',
		...overrides,
	};
}

function todo(): TodoSpec {
	return { id: 'todo-x', objective: 'Investigate X', origin: 'initial' };
}

const verdict = (v: 'accept' | 'followup' | 'revise-major', extras: Record<string, unknown> = {}): string =>
	JSON.stringify({ verdict: v, ...extras });

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('parseReview: accept verdict round-trips', () => {
	const r = parseReview(verdict('accept', { reasoning: 'looks good' }));
	assert.equal(r.verdict, 'accept');
	assert.equal(r.reasoning, 'looks good');
});

test('parseReview: followup with hint + leaves', () => {
	const r = parseReview(JSON.stringify({
		verdict: 'followup',
		reasoning: 'need more',
		followup: { hint: 'check X', suggested_leaves: [
			{ id: 'f1', title: 'f1', objective: 'o', kind: 'leaf', skill: 'shared.y', inputs: {}, emit: 'intermediate' },
		] },
	}));
	assert.equal(r.verdict, 'followup');
	assert.equal(r.followupHint, 'check X');
	assert.equal(r.followupLeaves?.length, 1);
	assert.equal(r.followupLeaves![0]!.id, 'f1');
});

test('parseReview: invalid verdict -> defaults to accept', () => {
	const r = parseReview(JSON.stringify({ verdict: 'maybe' }));
	assert.equal(r.verdict, 'accept');
});

test('parseReview: malformed JSON -> accept (no throw)', () => {
	const r = parseReview('not json');
	assert.equal(r.verdict, 'accept');
	assert.match(r.reasoning ?? '', /parse failure/);
});

test('parseReview: markdown-fenced JSON unwraps', () => {
	const r = parseReview('```json\n' + verdict('followup') + '\n```');
	assert.equal(r.verdict, 'followup');
});

test('coerceLeaf: well-formed leaf coerces', () => {
	const node = coerceLeaf({ id: 'a', title: 'A', objective: 'o', kind: 'leaf', skill: 'shared.x', inputs: {} });
	assert.notEqual(node, null);
	assert.equal(node?.id, 'a');
	assert.equal(node?.emit, 'intermediate');
});

test('coerceLeaf: rejects non-leaf kind', () => {
	const node = coerceLeaf({ id: 'a', title: 'A', objective: 'o', kind: 'composition', skill: 's', inputs: {} });
	assert.equal(node, null);
});

test('coerceLeaf: rejects missing required fields', () => {
	assert.equal(coerceLeaf({ id: '', title: 'a', objective: 'o', kind: 'leaf', skill: 's', inputs: {} }), null);
	assert.equal(coerceLeaf({ id: 'a', title: '', objective: 'o', kind: 'leaf', skill: 's', inputs: {} }), null);
	assert.equal(coerceLeaf({ id: 'a', title: 'A', objective: '', kind: 'leaf', skill: 's', inputs: {} }), null);
	assert.equal(coerceLeaf({ id: 'a', title: 'A', objective: 'o', kind: 'leaf', skill: '', inputs: {} }), null);
});

test('executeLeavesDfs: walks leaves in declared order', async () => {
	const { execute, calls } = leafExecutor({ a: 'A', b: 'B', c: 'C' });
	const root = compositionRoot('r', [leaf('a'), leaf('b'), leaf('c')]);
	const result = await executeLeavesDfs(root, {}, execute);
	assert.deepEqual(calls.map(c => c.leaf.id), ['a', 'b', 'c']);
	assert.match(result.aggregate, /### a\nA[\s\S]*### b\nB[\s\S]*### c\nC/);
	assert.deepEqual(result.outputs, { a: 'A', b: 'B', c: 'C' });
});

test('executeLeavesDfs: nested composition -> DFS', async () => {
	const { execute, calls } = leafExecutor({ x: 'X', y: 'Y' });
	// composition with one nested composition before a leaf
	const inner = compositionRoot('inner', [leaf('x'), leaf('y')]);
	const root = compositionRoot('outer', [inner]);
	await executeLeavesDfs(root, {}, execute);
	assert.deepEqual(calls.map(c => c.leaf.id), ['x', 'y']);
});

test('composeFindingContent: empty + empty -> "(empty)"', () => {
	assert.equal(composeFindingContent('', ''), '(empty)');
});

test('composeFindingContent: reasoning + aggregate concatenated', () => {
	const out = composeFindingContent('out', 'reason');
	assert.match(out, /reason/);
	assert.match(out, /out/);
	assert.ok(out.indexOf('reason') < out.indexOf('out'));
});

// ---------------------------------------------------------------------------
// executeReviewableRoots: single-root happy path
// ---------------------------------------------------------------------------

test('single root: review accepts immediately -> finding cyclesConsumed=0, exhausted=false', async () => {
	const t = tree([
		compositionRoot('r1', [leaf('a')]),
	]);
	const { execute } = leafExecutor({ a: 'A' });
	const { provider, calls } = scriptedProvider([verdict('accept', { reasoning: 'ok' })]);

	const result = await executeReviewableRoots({
		todo: todo(), tree: t, memory: memory(), executeLeaf: execute, provider,
	});
	assert.equal(result.reopenRequested, false);
	assert.equal(result.findings.perRoot.length, 1);
	assert.equal(result.findings.perRoot[0]!.verdict, 'accept');
	assert.equal(result.findings.perRoot[0]!.cyclesConsumed, 0);
	assert.equal(result.findings.perRoot[0]!.exhausted, false);
	assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// Followup loop
// ---------------------------------------------------------------------------

test('followup -> accept: cyclesConsumed=1, verdict accept', async () => {
	const t = tree([compositionRoot('r1', [leaf('a')])]);
	const { execute } = leafExecutor({ a: 'A', f1: 'F1' });

	const followupSuggestion = {
		id: 'f1', title: 'f1', objective: 'o', kind: 'leaf',
		skill: 'shared.y', inputs: {}, emit: 'intermediate',
	};
	const { provider } = scriptedProvider([
		verdict('followup', { followup: { hint: 'check more', suggested_leaves: [followupSuggestion] } }),
		verdict('accept', { reasoning: 'good now' }),
	]);

	const result = await executeReviewableRoots({
		todo: todo(), tree: t, memory: memory(), executeLeaf: execute, provider,
	});
	assert.equal(result.reopenRequested, false);
	assert.equal(result.findings.perRoot[0]!.cyclesConsumed, 1);
	assert.equal(result.findings.perRoot[0]!.exhausted, false);
	assert.equal(result.findings.perRoot[0]!.verdict, 'accept');
});

test('followup cap hit -> verdict force-accept, exhausted=true', async () => {
	const t = tree([compositionRoot('r1', [leaf('a')])]);
	const { execute } = leafExecutor({ a: 'A', f: 'F' });

	const fLeaf = { id: 'f', title: 'f', objective: 'o', kind: 'leaf', skill: 's', inputs: {}, emit: 'intermediate' };
	const fwResponses = Array.from({ length: FOLLOWUP_CYCLE_CAP_VALUE + 1 }, () =>
		verdict('followup', { followup: { hint: 'more', suggested_leaves: [fLeaf] } }),
	);
	const { provider } = scriptedProvider(fwResponses);

	const result = await executeReviewableRoots({
		todo: todo(), tree: t, memory: memory(), executeLeaf: execute, provider,
	});
	assert.equal(result.reopenRequested, false);
	const f = result.findings.perRoot[0]!;
	assert.equal(f.cyclesConsumed, FOLLOWUP_CYCLE_CAP_VALUE);
	assert.equal(f.exhausted, true);
	assert.equal(f.verdict, 'force-accept');
});

test('followup with empty suggested_leaves: cycle counted, no execution', async () => {
	const t = tree([compositionRoot('r1', [leaf('a')])]);
	const { execute, calls: leafCalls } = leafExecutor({ a: 'A' });
	const { provider } = scriptedProvider([
		verdict('followup', { followup: { hint: 'something' } }),    // no suggested_leaves
		verdict('accept'),
	]);

	const result = await executeReviewableRoots({
		todo: todo(), tree: t, memory: memory(), executeLeaf: execute, provider,
	});
	assert.equal(result.findings.perRoot[0]!.cyclesConsumed, 1);
	// Only 'a' was executed; no followup leaves ran.
	assert.deepEqual(leafCalls.map(c => c.leaf.id), ['a']);
});

test('followup MAX_FOLLOWUP_LEAVES_VALUE clamps suggested leaves', async () => {
	const t = tree([compositionRoot('r1', [leaf('a')])]);
	const { execute, calls: leafCalls } = leafExecutor({ a: 'A' });
	const tooMany = Array.from({ length: MAX_FOLLOWUP_LEAVES_VALUE + 2 }, (_, i) => ({
		id: `f${i}`, title: 'f', objective: 'o', kind: 'leaf', skill: 's', inputs: {}, emit: 'intermediate',
	}));
	const { provider } = scriptedProvider([
		verdict('followup', { followup: { hint: 'check', suggested_leaves: tooMany } }),
		verdict('accept'),
	]);

	await executeReviewableRoots({
		todo: todo(), tree: t, memory: memory(), executeLeaf: execute, provider,
	});
	// Initial 'a' + clamped MAX_FOLLOWUP_LEAVES followup leaves.
	assert.equal(leafCalls.length, 1 + MAX_FOLLOWUP_LEAVES_VALUE);
});

// ---------------------------------------------------------------------------
// Revise-major escalation
// ---------------------------------------------------------------------------

test('revise-major: reopenRequested=true, subsequent roots NOT executed', async () => {
	const t = tree([
		compositionRoot('r1', [leaf('a')]),
		compositionRoot('r2', [leaf('b')]),
	]);
	const { execute, calls: leafCalls } = leafExecutor({ a: 'A', b: 'B' });
	const { provider, calls } = scriptedProvider([
		verdict('revise-major', { reasoning: 'wrong direction' }),
		// No second-root review call expected.
	]);

	const result = await executeReviewableRoots({
		todo: todo(), tree: t, memory: memory(), executeLeaf: execute, provider,
	});
	assert.equal(result.reopenRequested, true);
	assert.match(result.reopenReason ?? '', /wrong direction/);
	// Only r1's leaf ran; r2 was never touched.
	assert.deepEqual(leafCalls.map(c => c.leaf.id), ['a']);
	assert.equal(calls.length, 1);   // one review call total
});

// ---------------------------------------------------------------------------
// Multi-root happy path
// ---------------------------------------------------------------------------

test('multi-root happy path: 3 roots all accept; outputs flow into compositionOutputs', async () => {
	const t = tree([
		compositionRoot('discover', [leaf('a')]),
		compositionRoot('analyze',   [leaf('b')]),
		compositionRoot('synthesize',[leaf('c')], 'section'),
	]);
	const { execute, calls: leafCalls } = leafExecutor({ a: 'A', b: 'B', c: 'C' });
	const { provider } = scriptedProvider([
		verdict('accept'),
		verdict('accept'),
		verdict('accept'),
	]);

	const result = await executeReviewableRoots({
		todo: todo(), tree: t, memory: memory(), executeLeaf: execute, provider,
	});
	assert.equal(result.reopenRequested, false);
	assert.equal(result.findings.perRoot.length, 3);
	assert.deepEqual(result.findings.perRoot.map(f => f.rootId), ['discover', 'analyze', 'synthesize']);
	for (const f of result.findings.perRoot) {
		assert.equal(f.verdict, 'accept');
		assert.equal(f.exhausted, false);
	}
	// 'analyze.b' executed AFTER 'discover.a' completed -- so 'discover'
	// was in priorOutputs when 'b' ran. The composition output is the
	// aggregate of its leaves (not the raw leaf output).
	const bCall = leafCalls.find(c => c.leaf.id === 'b');
	assert.ok(bCall !== undefined);
	assert.match(bCall!.priorOutputs['discover'] ?? '', /^### a\nA/);
});

// ---------------------------------------------------------------------------
// LLM contract
// ---------------------------------------------------------------------------

test('review call sends disableThinking=true + temperature=0 + responseFormat=json', async () => {
	const t = tree([compositionRoot('r1', [leaf('a')])]);
	const { execute } = leafExecutor({ a: 'A' });
	const { provider, calls } = scriptedProvider([verdict('accept')]);

	await executeReviewableRoots({
		todo: todo(), tree: t, memory: memory(), executeLeaf: execute, provider,
	});
	assert.equal(calls[0]!.opts.disableThinking, true);
	assert.equal(calls[0]!.opts.temperature, 0);
	assert.equal(calls[0]!.opts.responseFormat, 'json');
});

// ---------------------------------------------------------------------------
// Degenerate top-level tree
// ---------------------------------------------------------------------------

test('top-level leaf tree -> escalates synthetically (no review call)', async () => {
	const badTree: PlannedTree = {
		intentBrief: 't',
		root: { id: 'only', title: 'o', objective: 'o', kind: 'leaf', skill: 'shared.x', inputs: {}, emit: 'section' },
	};
	const { execute } = leafExecutor({ only: 'X' });
	const { provider, calls } = scriptedProvider([]);

	const result = await executeReviewableRoots({
		todo: todo(), tree: badTree, memory: memory(), executeLeaf: execute, provider,
	});
	assert.equal(result.reopenRequested, true);
	assert.match(result.reopenReason ?? '', /not a composition/);
	assert.equal(calls.length, 0);
});
