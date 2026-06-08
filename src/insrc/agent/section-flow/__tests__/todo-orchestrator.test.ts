/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Tests for the TODO orchestrator (P3.d).
 *
 * Provider scripting note: each TODO run consumes provider calls in
 * this fixed order:
 *   1. Section planner (1 call when first-attempt validates).
 *   2. Per-root review (1 per reviewable root, on the happy path).
 *   3. Section review (1 on initial accept; more on revise-edits).
 *   4. (If replan fires) -- another planner call + the chain repeats.
 *
 * The fixtures below build the expected response sequence by hand so
 * each test pins exactly which path the orchestrator took.
 *
 * Covered:
 * - Happy path: planner + 3 root reviews + section review accept ->
 *   entry has 3 perRoot findings, no annotations, l2FallbackUsed=false.
 * - Section review exhausted (cap-3 revise-edits): entry detail
 *   carries `section-review-exhausted` annotation, exhausted=true,
 *   no replan, no L2.
 * - Per-root revise-major within budget: replan, second attempt
 *   accepts -> replansConsumed=1, no L2.
 * - Per-root revise-major beyond budget: L2 fallback;
 *   findings.fallback === 'L2'; single 'L2-fallback' finding.
 * - Section review revise-major within budget: replan, second
 *   attempt clears -> no L2.
 * - Section planner throws: skip replans, go straight to L2.
 * - Planner retried (first attempt rejected) annotation surfaces.
 * - Assembly fallback annotation surfaces.
 * - maxReplans = 0: ANY revise-major goes directly to L2.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	runTodoOrchestrator,
	_buildSuccessEntryForTest as buildSuccessEntry,
	_buildL2EntryForTest as buildL2Entry,
	_appendAnnotationsForTest as appendAnnotations,
	DEFAULT_MAX_REPLANS_VALUE,
	type L2Fallback,
} from '../todo-orchestrator.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import type { MemoryShapeBundle } from '../../working-memory/index.js';
import type { TodoSpec } from '../types.js';
import type { ExecuteLeaf, LeafExecutionInput } from '../step-root-execution.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const todo: TodoSpec = { id: 'todo-x', objective: 'Investigate X', origin: 'initial' };
const memory: MemoryShapeBundle = { system: '', summary: '', recent: '', semantic: '', code: '' };

function scriptedProvider(responses: readonly string[]): { provider: LLMProvider; calls: { messages: LLMMessage[]; opts: CompletionOpts }[] } {
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

function l2Mock(markdown: string): { fn: L2Fallback; called: { todo: TodoSpec; reason: string }[] } {
	const called: { todo: TodoSpec; reason: string }[] = [];
	const fn: L2Fallback = async (input) => {
		called.push({ todo: input.todo, reason: input.reason });
		return markdown;
	};
	return { fn, called };
}

// Healthy 3-root tree the section planner emits on the happy path.
const HEALTHY_TREE_JSON = JSON.stringify({
	intentBrief: 'test',
	root: {
		id: 'root', title: 'root', objective: 'r', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
		children: [
			{
				id: 'discover', title: 'd', objective: 'd', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
				children: [{ id: 'd1', title: 'd1', objective: 'd1', kind: 'leaf', skill: 'shared.x', inputs: {}, emit: 'intermediate' }],
			},
			{
				id: 'analyze', title: 'a', objective: 'a', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
				children: [{ id: 'a1', title: 'a1', objective: 'a1', kind: 'leaf', skill: 'shared.y', inputs: { discoveries: { source: 'node', nodeId: 'discover', path: '$' } }, emit: 'intermediate' }],
			},
			{
				id: 'synthesize', title: 's', objective: 's', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'section',
				children: [{ id: 's1', title: 's1', objective: 's1', kind: 'leaf', skill: 'shared.write', inputs: { analysis: { source: 'node', nodeId: 'analyze', path: '$' } }, emit: 'section' }],
			},
		],
	},
});

const acceptVerdict = (extras: Record<string, unknown> = {}): string =>
	JSON.stringify({ verdict: 'accept', ...extras });
const reviseEditsVerdict = (edits: string): string =>
	JSON.stringify({ verdict: 'revise-edits', edits, reasoning: 'fix' });
const reviseMajorVerdict = (reasoning: string): string =>
	JSON.stringify({ verdict: 'revise-major', reasoning });

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('DEFAULT_MAX_REPLANS_VALUE: 1', () => {
	assert.equal(DEFAULT_MAX_REPLANS_VALUE, 1);
});

test('appendAnnotations: no flags -> unchanged', () => {
	assert.equal(
		appendAnnotations('body', { sectionExhausted: false, plannerRetried: false, assemblyFallback: false }),
		'body',
	);
});

test('appendAnnotations: flags surface in HTML comment', () => {
	const out = appendAnnotations('body', { sectionExhausted: true, plannerRetried: true, assemblyFallback: false });
	assert.match(out, /<!-- section-flow: section-review-exhausted, planner-corrected -->/);
});

test('buildSuccessEntry: detail + objective + findings carry through', () => {
	const entry = buildSuccessEntry({
		todo,
		detail:           'final markdown',
		findings:         { perRoot: [{ rootId: 'r1', verdict: 'accept', cyclesConsumed: 0, exhausted: false, content: 'c' }] },
		sectionExhausted: false,
		plannerRetried:   false,
		assemblyFallback: false,
	});
	assert.equal(entry.todoId, 'todo-x');
	assert.equal(entry.objective, 'Investigate X');
	assert.equal(entry.detail, 'final markdown');
	assert.equal(entry.findings.perRoot.length, 1);
	assert.equal(entry.findings.fallback, undefined);
});

test('buildL2Entry: findings.fallback=L2 + synthetic L2-fallback perRoot', () => {
	const entry = buildL2Entry({ todo, detail: 'L2 markdown', l2Reason: 'because' });
	assert.equal(entry.findings.fallback, 'L2');
	assert.equal(entry.findings.perRoot.length, 1);
	assert.equal(entry.findings.perRoot[0]!.verdict, 'L2-fallback');
	assert.match(entry.findings.perRoot[0]!.content, /because/);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('happy path: planner accepts, 3 roots accept, section review accept -> success entry', async () => {
	const { execute } = leafExecutor({ d1: 'D', a1: 'A', s1: '# Section\n\nbody' });
	const { provider } = scriptedProvider([
		HEALTHY_TREE_JSON,             // planner
		acceptVerdict(),               // discover review
		acceptVerdict(),               // analyze review
		acceptVerdict(),               // synthesize review
		acceptVerdict(),               // section review
	]);
	const { fn: l2, called } = l2Mock('SHOULD NOT BE CALLED');

	const result = await runTodoOrchestrator({
		todo, memory, provider, executeLeaf: execute, l2Fallback: l2,
	});

	assert.equal(result.trace.l2FallbackUsed, false);
	assert.equal(result.trace.replansConsumed, 0);
	assert.equal(called.length, 0);
	assert.equal(result.entry.findings.perRoot.length, 3);
	assert.equal(result.entry.findings.fallback, undefined);
	assert.match(result.entry.detail, /# Section/);
	// No annotations -> no HTML comment.
	assert.ok(!result.entry.detail.includes('<!-- section-flow'));
});

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

test('planner retried -> entry detail carries planner-corrected annotation', async () => {
	// Planner emits a degenerate first attempt; retry succeeds.
	const degenerate = JSON.stringify({
		intentBrief: 't',
		root: { id: 'r', title: 'r', objective: 'r', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
			children: [{ id: 'only', title: 'only', objective: 'o', kind: 'leaf', skill: 'shared.x', inputs: {}, emit: 'section' }],
		},
	});
	const { execute } = leafExecutor({ d1: 'D', a1: 'A', s1: 'OUTPUT' });
	const { provider } = scriptedProvider([
		degenerate,                    // planner 1st: degenerate
		HEALTHY_TREE_JSON,             // planner 2nd: ok
		acceptVerdict(), acceptVerdict(), acceptVerdict(),    // 3 root reviews
		acceptVerdict(),                                       // section review
	]);
	const { fn: l2 } = l2Mock('UNUSED');
	const result = await runTodoOrchestrator({ todo, memory, provider, executeLeaf: execute, l2Fallback: l2 });
	assert.match(result.entry.detail, /planner-corrected/);
});

test('section review exhausted -> section-review-exhausted annotation, no replan, no L2', async () => {
	const { execute } = leafExecutor({ d1: 'D', a1: 'A', s1: 'OUT' });
	// SECTION_REVIEW_CYCLE_CAP=3. We need: 1 review (revise-edits) +
	// 3 cycles each (revise + review). Final review is revise-edits ->
	// force-accept.
	const reviewSequence = [
		reviseEditsVerdict('e0'),
		'# Rev 1',
		reviseEditsVerdict('e1'),
		'# Rev 2',
		reviseEditsVerdict('e2'),
		'# Rev 3',
		reviseEditsVerdict('e3'),    // CAP HIT
	];
	const { provider } = scriptedProvider([
		HEALTHY_TREE_JSON,
		acceptVerdict(), acceptVerdict(), acceptVerdict(),
		...reviewSequence,
	]);
	const { fn: l2 } = l2Mock('UNUSED');
	const result = await runTodoOrchestrator({ todo, memory, provider, executeLeaf: execute, l2Fallback: l2 });

	assert.equal(result.trace.l2FallbackUsed, false);
	assert.equal(result.trace.replansConsumed, 0);
	assert.match(result.entry.detail, /section-review-exhausted/);
});

// ---------------------------------------------------------------------------
// Per-root revise-major
// ---------------------------------------------------------------------------

test('per-root revise-major within budget -> replan, 2nd attempt accepts, no L2', async () => {
	const { execute } = leafExecutor({ d1: 'D', a1: 'A', s1: 'OUT' });
	const { provider } = scriptedProvider([
		HEALTHY_TREE_JSON,              // planner 1
		reviseMajorVerdict('rewrong'),  // discover review -> escalate
		HEALTHY_TREE_JSON,              // planner 2 (replan)
		acceptVerdict(), acceptVerdict(), acceptVerdict(),
		acceptVerdict(),
	]);
	const { fn: l2, called } = l2Mock('UNUSED');
	const result = await runTodoOrchestrator({ todo, memory, provider, executeLeaf: execute, l2Fallback: l2 });

	assert.equal(result.trace.l2FallbackUsed, false);
	assert.equal(result.trace.replansConsumed, 1);
	assert.equal(called.length, 0);
	assert.match(result.trace.failureChain[0] ?? '', /rewrong/);
});

test('per-root revise-major beyond budget (maxReplans=0) -> L2 fallback', async () => {
	const { execute } = leafExecutor({ d1: 'D', a1: 'A', s1: 'OUT' });
	const { provider } = scriptedProvider([
		HEALTHY_TREE_JSON,
		reviseMajorVerdict('cant fix this'),
	]);
	const { fn: l2, called } = l2Mock('# L2 SECTION\n\nL2 produced this.');

	const result = await runTodoOrchestrator({
		todo, memory, provider, executeLeaf: execute, l2Fallback: l2, maxReplans: 0,
	});

	assert.equal(result.trace.l2FallbackUsed, true);
	assert.equal(called.length, 1);
	assert.match(called[0]!.reason, /cant fix this/);
	assert.equal(result.entry.findings.fallback, 'L2');
	assert.equal(result.entry.findings.perRoot[0]!.verdict, 'L2-fallback');
	assert.match(result.entry.detail, /# L2 SECTION/);
});

// ---------------------------------------------------------------------------
// Section review revise-major
// ---------------------------------------------------------------------------

test('section review revise-major within budget -> replan, 2nd attempt clean', async () => {
	const { execute } = leafExecutor({ d1: 'D', a1: 'A', s1: 'OUT' });
	const { provider } = scriptedProvider([
		HEALTHY_TREE_JSON,
		acceptVerdict(), acceptVerdict(), acceptVerdict(),
		reviseMajorVerdict('investigation gap'),     // section review escalates
		HEALTHY_TREE_JSON,                            // replan
		acceptVerdict(), acceptVerdict(), acceptVerdict(),
		acceptVerdict(),
	]);
	const { fn: l2, called } = l2Mock('UNUSED');
	const result = await runTodoOrchestrator({ todo, memory, provider, executeLeaf: execute, l2Fallback: l2 });

	assert.equal(result.trace.l2FallbackUsed, false);
	assert.equal(result.trace.replansConsumed, 1);
	assert.equal(called.length, 0);
	assert.match(result.trace.failureChain[0] ?? '', /investigation gap/);
});

test('section review revise-major beyond budget -> L2 fallback', async () => {
	const { execute } = leafExecutor({ d1: 'D', a1: 'A', s1: 'OUT' });
	const { provider } = scriptedProvider([
		HEALTHY_TREE_JSON,
		acceptVerdict(), acceptVerdict(), acceptVerdict(),
		reviseMajorVerdict('still broken'),
	]);
	const { fn: l2 } = l2Mock('L2 OUTPUT');
	const result = await runTodoOrchestrator({
		todo, memory, provider, executeLeaf: execute, l2Fallback: l2, maxReplans: 0,
	});
	assert.equal(result.trace.l2FallbackUsed, true);
	assert.equal(result.entry.findings.fallback, 'L2');
});

// ---------------------------------------------------------------------------
// Section planner throws -> L2 directly
// ---------------------------------------------------------------------------

test('section planner throws -> skip replans, go straight to L2', async () => {
	const { execute } = leafExecutor({});
	const degenerate = JSON.stringify({
		intentBrief: 't',
		root: { id: 'r', title: 'r', objective: 'r', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
			children: [{ id: 'only', title: 'only', objective: 'o', kind: 'leaf', skill: 'shared.x', inputs: {}, emit: 'section' }],
		},
	});
	// Both planner attempts return the same degenerate tree -> throws.
	const { provider } = scriptedProvider([degenerate, degenerate]);
	const { fn: l2, called } = l2Mock('L2 RESULT');
	const result = await runTodoOrchestrator({
		todo, memory, provider, executeLeaf: execute, l2Fallback: l2,
	});
	assert.equal(result.trace.l2FallbackUsed, true);
	assert.equal(result.trace.replansConsumed, 0);
	assert.equal(called.length, 1);
	assert.match(called[0]!.reason, /section planner failed/);
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

test('catalog threaded into the planner prompt as a rendered list', async () => {
	const { execute } = leafExecutor({ d1: 'D', a1: 'A', s1: 'OUT' });
	const { provider, calls } = scriptedProvider([
		HEALTHY_TREE_JSON,
		acceptVerdict(), acceptVerdict(), acceptVerdict(),
		acceptVerdict(),
	]);
	const { fn: l2 } = l2Mock('UNUSED');
	await runTodoOrchestrator({
		todo, memory, provider, executeLeaf: execute, l2Fallback: l2,
		catalog: [
			// Match the ids HEALTHY_TREE_JSON uses so the validator accepts the plan.
			{ id: 'data.profile-shape',                description: 'profile a dataset',  family: 'profile', owner: 'data-analyzer', inputs: {}, outputPaths: [] },
			{ id: 'code.list-class-fields',            description: 'list pydantic class fields', family: 'class', owner: 'code-analyzer', inputs: {}, outputPaths: [] },
			{ id: 'shared.compare-fields-vs-shape',    description: 'diff two field sets', family: 'compare', owner: 'shared', inputs: {}, outputPaths: [] },
			{ id: 'shared.write-section',              description: 'render the section',  family: 'synth',   owner: 'shared', inputs: {}, outputPaths: [] },
		],
	});
	const plannerUser = calls[0]!.messages[1]!.content;
	assert.match(plannerUser, /SKILL CATALOG \(4 skills available/);
	assert.match(plannerUser, /data\.profile-shape/);
});

// ---------------------------------------------------------------------------
// Default maxReplans = 1
// ---------------------------------------------------------------------------

test('default maxReplans=1: one revise-major triggers replan, two trigger L2', async () => {
	const { execute } = leafExecutor({ d1: 'D', a1: 'A', s1: 'OUT' });
	const { provider } = scriptedProvider([
		HEALTHY_TREE_JSON,
		reviseMajorVerdict('first escalation'),    // discover escalates
		HEALTHY_TREE_JSON,                          // replan 1
		reviseMajorVerdict('second escalation'),    // discover escalates again
		// budget exhausted -> L2
	]);
	const { fn: l2, called } = l2Mock('L2');
	const result = await runTodoOrchestrator({
		todo, memory, provider, executeLeaf: execute, l2Fallback: l2,
	});
	assert.equal(result.trace.replansConsumed, 1);
	assert.equal(result.trace.l2FallbackUsed, true);
	assert.equal(called.length, 1);
	assert.equal(result.trace.failureChain.length, 2);
});
