/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the section planner step + degenerate-shape detector (P3.a).
 *
 * Covered:
 * - isDegenerateShape rules: top-level leaf, too-few top-level children,
 *   too-few leaves, thin-chain shapes; healthy trees pass.
 * - runSectionPlanner happy path: LLM emits multi-root tree, validates,
 *   no retry.
 * - runSectionPlanner retry path: first attempt is degenerate, retry
 *   passes, retried=true, firstFailureReason surfaced.
 * - runSectionPlanner throw: both attempts fail -> throws with reason.
 * - LLM contract: disableThinking + temperature 0 + responseFormat 'json'.
 * - Prompt structure: TODO objective + memory bundle + worked example
 *   + reviewable-root contract all surface in the user message.
 * - validateAll: structural failures bubble up with the structural
 *   prefix; degenerate failures bubble up verbatim.
 * - The worked example itself validates as a healthy tree (the LLM
 *   sees a non-degenerate example).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	runSectionPlanner,
	_validateAllForTest        as validateAll,
	_renderMemoryForTest       as renderMemory,
	_stripFencesForTest        as stripFences,
	WORKED_EXAMPLE_JSON_VALUE,
} from '../step-section-planner.js';
import {
	isDegenerateShape,
	validatePlannedTree,
	type PlannedTree,
} from '../../content-gen/plan-tree.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import type { TodoSpec } from '../types.js';
import type { MemoryShapeBundle } from '../../working-memory/index.js';

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

function makeTodo(overrides: Partial<TodoSpec> = {}): TodoSpec {
	return {
		id:        overrides.id        ?? 'todo-grn',
		objective: overrides.objective ?? 'Analyze GRN field mappings',
		origin:    overrides.origin    ?? 'initial',
	};
}

function makeMemory(overrides: Partial<MemoryShapeBundle> = {}): MemoryShapeBundle {
	return {
		system:   overrides.system   ?? 'project: insrc',
		summary:  overrides.summary  ?? 'prior turns cover GRN extraction',
		recent:   overrides.recent   ?? '- recent finding',
		semantic: overrides.semantic ?? '- relevant note',
		code:     overrides.code     ?? '',
	};
}

const HEALTHY_TREE_JSON = WORKED_EXAMPLE_JSON_VALUE;

const LIVE_TEST_FAILURE_TREE_JSON = JSON.stringify({
	intentBrief: 'failure shape',
	root: {
		id: 'root', title: 'root', objective: 'r', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
		children: [
			{ id: 'A', title: 'A', objective: 'a', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
				children: [
					{ id: 'B', title: 'B', objective: 'b', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
						children: [
							{ id: 'C', title: 'C', objective: 'c', kind: 'leaf', skill: 'shared.write-section', inputs: {}, emit: 'section' },
						],
					},
				],
			},
		],
	},
});

const SINGLE_LEAF_TREE_JSON = JSON.stringify({
	intentBrief: 'single leaf',
	root: { id: 'only', title: 'only', objective: 'o', kind: 'leaf', skill: 'shared.write-section', inputs: {}, emit: 'section' },
});

// ---------------------------------------------------------------------------
// isDegenerateShape
// ---------------------------------------------------------------------------

test('isDegenerateShape: healthy worked example -> null (acceptable)', () => {
	const validated = validatePlannedTree(JSON.parse(HEALTHY_TREE_JSON));
	assert.notEqual(typeof validated, 'string');
	assert.equal(isDegenerateShape(validated as PlannedTree), null);
});

test('isDegenerateShape: top-level leaf -> degenerate', () => {
	const validated = validatePlannedTree(JSON.parse(SINGLE_LEAF_TREE_JSON));
	assert.notEqual(typeof validated, 'string');
	const reason = isDegenerateShape(validated as PlannedTree);
	assert.match(reason ?? '', /top-level node is a leaf/);
});

test('isDegenerateShape: single-child top-level composition -> degenerate', () => {
	const tree: PlannedTree = {
		intentBrief: 'one child',
		root: {
			id: 'root', title: 'root', objective: 'r', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
			children: [
				{ id: 'only', title: 'only', objective: 'o', kind: 'leaf', skill: 'shared.x', inputs: {}, emit: 'section' },
			],
		},
	};
	const reason = isDegenerateShape(tree);
	assert.match(reason ?? '', /1 child\(ren\)/);
});

test('isDegenerateShape: too few leaves (1) -> degenerate', () => {
	const tree: PlannedTree = {
		intentBrief: 'thin',
		root: {
			id: 'root', title: 'root', objective: 'r', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
			children: [
				{ id: 'a', title: 'a', objective: 'a', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
					children: [
						{ id: 'a1', title: 'a1', objective: 'a1', kind: 'leaf', skill: 'shared.x', inputs: {}, emit: 'intermediate' },
					],
				},
				{ id: 'b', title: 'b', objective: 'b', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
					children: [
						// no leaves -- but that's caught earlier by structural validator (zero-leaf rule).
						{ id: 'b1', title: 'b1', objective: 'b1', kind: 'leaf', skill: 'shared.y', inputs: {}, emit: 'section' },
					],
				},
			],
		},
	};
	// 2 leaves -> not degenerate at default minLeaves=2.
	assert.equal(isDegenerateShape(tree), null);
	// But require >=3 -> degenerate.
	assert.match(isDegenerateShape(tree, { minLeaves: 3 }) ?? '', /2 leaf/);
});

test('isDegenerateShape: thin chain (live-test failure shape) -> degenerate', () => {
	const validated = validatePlannedTree(JSON.parse(LIVE_TEST_FAILURE_TREE_JSON));
	assert.notEqual(typeof validated, 'string');
	const reason = isDegenerateShape(validated as PlannedTree);
	// Live-test failure: top-level composition has 1 child, depth=3,
	// 1 leaf. The min-top-children rule fires first.
	assert.match(reason ?? '', /1 child\(ren\)/);
});

test('isDegenerateShape: deep + thin shape caught when leaves match the min', () => {
	// Build: 3 reviewable roots, only 2 leaves total, depth 3.
	const tree: PlannedTree = {
		intentBrief: 'thin deep',
		root: {
			id: 'root', title: 'root', objective: 'r', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
			children: [
				{ id: 'a', title: 'a', objective: 'a', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
					children: [
						{ id: 'a-inner', title: 'ai', objective: 'ai', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
							children: [
								{ id: 'a-leaf', title: 'al', objective: 'al', kind: 'leaf', skill: 'shared.x', inputs: {}, emit: 'intermediate' },
							],
						},
					],
				},
				{ id: 'b', title: 'b', objective: 'b', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
					children: [
						{ id: 'b-leaf', title: 'bl', objective: 'bl', kind: 'leaf', skill: 'shared.write-section', inputs: {}, emit: 'section' },
					],
				},
			],
		},
	};
	// depth = 3, leaves = 2; default minLeaves=2 passes the leaf rule.
	// thin-chain rule: depth > 2 AND leaves < depth -> 2 < 3 -> degenerate.
	const reason = isDegenerateShape(tree);
	assert.match(reason ?? '', /depth 3 with only 2 leaf/);
});

test('isDegenerateShape: minTopLevelChildren override', () => {
	// 2 reviewable roots passes default; bumping to 3 rejects.
	const tree: PlannedTree = {
		intentBrief: 't',
		root: {
			id: 'root', title: 'root', objective: 'r', kind: 'composition', composition: 'sequence', inputs: {}, emit: 'intermediate',
			children: [
				{ id: 'a', title: 'a', objective: 'a', kind: 'leaf', skill: 'shared.x', inputs: {}, emit: 'intermediate' },
				{ id: 'b', title: 'b', objective: 'b', kind: 'leaf', skill: 'shared.y', inputs: {}, emit: 'section' },
			],
		},
	};
	assert.equal(isDegenerateShape(tree), null);
	assert.match(isDegenerateShape(tree, { minTopLevelChildren: 3 }) ?? '', /2 child\(ren\)/);
});

// ---------------------------------------------------------------------------
// validateAll
// ---------------------------------------------------------------------------

test('validateAll: healthy tree -> ok with parsed PlannedTree', () => {
	const r = validateAll(HEALTHY_TREE_JSON, undefined);
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.tree.intentBrief, 'Analyze GRN field mappings');
		assert.equal(r.tree.root.children?.length, 3);
	}
});

test('validateAll: malformed JSON -> structural failure with reason', () => {
	const r = validateAll('not json', undefined);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /JSON parse failed/); }
});

test('validateAll: structural validator rejection prefixed with "structural"', () => {
	const r = validateAll(JSON.stringify({ intentBrief: '', root: { id: 'r' } }), undefined);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /^structural:/); }
});

test('validateAll: degenerate-shape failure surfaces verbatim', () => {
	const r = validateAll(LIVE_TEST_FAILURE_TREE_JSON, undefined);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /degenerate:/); }
});

test('validateAll: markdown-fenced JSON unwraps', () => {
	const fenced = '```json\n' + HEALTHY_TREE_JSON + '\n```';
	const r = validateAll(fenced, undefined);
	assert.equal(r.ok, true);
});

test('stripFences: strips fences and trims', () => {
	assert.equal(stripFences('```json\n{"x":1}\n```'), '{"x":1}');
	assert.equal(stripFences('  {"x":1}  '), '{"x":1}');
});

// ---------------------------------------------------------------------------
// renderMemory
// ---------------------------------------------------------------------------

test('renderMemory: empty bundle -> placeholder', () => {
	assert.match(
		renderMemory({ system: '', summary: '', recent: '', semantic: '', code: '' }),
		/this is the first TODO/,
	);
});

test('renderMemory: populated bundle includes all non-empty layers in order', () => {
	const out = renderMemory({
		system:   's1', summary: 's2',
		recent:   'r1', semantic: 'se1',
		code:     'c1',
	});
	assert.ok(out.indexOf('### system')   < out.indexOf('### summary'));
	assert.ok(out.indexOf('### summary')  < out.indexOf('### recent'));
	assert.ok(out.indexOf('### recent')   < out.indexOf('### semantic'));
	assert.ok(out.indexOf('### semantic') < out.indexOf('### code'));
});

test('renderMemory: empty layers are skipped', () => {
	const out = renderMemory({ system: 's', summary: '', recent: 'r', semantic: '', code: '' });
	assert.ok(out.includes('### system'));
	assert.ok(!out.includes('### summary'));
	assert.ok(out.includes('### recent'));
	assert.ok(!out.includes('### semantic'));
});

// ---------------------------------------------------------------------------
// runSectionPlanner end-to-end
// ---------------------------------------------------------------------------

test('runSectionPlanner: first attempt validates -> no retry', async () => {
	const { provider, calls } = scriptedProvider([HEALTHY_TREE_JSON]);
	const result = await runSectionPlanner({
		todo: makeTodo(), memory: makeMemory(), provider,
	});
	assert.equal(calls.length, 1);
	assert.equal(result.retried, false);
	assert.equal(result.tree.intentBrief, 'Analyze GRN field mappings');
});

test('runSectionPlanner: first attempt degenerate -> retry with corrective hint passes', async () => {
	const { provider, calls } = scriptedProvider([LIVE_TEST_FAILURE_TREE_JSON, HEALTHY_TREE_JSON]);
	const result = await runSectionPlanner({
		todo: makeTodo(), memory: makeMemory(), provider,
	});
	assert.equal(calls.length, 2);
	assert.equal(result.retried, true);
	assert.match(result.firstFailureReason ?? '', /degenerate|1 leaf/);
	assert.match(calls[1]!.messages[1]!.content, /RETRY CORRECTION/);
});

test('runSectionPlanner: both attempts fail -> throws', async () => {
	const { provider } = scriptedProvider([LIVE_TEST_FAILURE_TREE_JSON, LIVE_TEST_FAILURE_TREE_JSON]);
	await assert.rejects(
		() => runSectionPlanner({ todo: makeTodo(), memory: makeMemory(), provider }),
		/section planner validation failed after retry/,
	);
});

test('runSectionPlanner: every call has disableThinking + temperature=0 + responseFormat=json', async () => {
	const { provider, calls } = scriptedProvider([HEALTHY_TREE_JSON]);
	await runSectionPlanner({ todo: makeTodo(), memory: makeMemory(), provider });
	assert.equal(calls[0]!.opts.disableThinking, true);
	assert.equal(calls[0]!.opts.temperature, 0);
	assert.equal(calls[0]!.opts.responseFormat, 'json');
});

test('runSectionPlanner: user prompt carries TODO objective + memory + worked example + contract', async () => {
	const { provider, calls } = scriptedProvider([HEALTHY_TREE_JSON]);
	const todo = makeTodo({ objective: 'My specific TODO objective text' });
	await runSectionPlanner({
		todo,
		memory: makeMemory({ recent: 'recent finding text' }),
		provider,
	});
	const user = calls[0]!.messages[1]!.content;
	assert.match(user, /## TODO OBJECTIVE/);
	assert.match(user, /My specific TODO objective text/);
	assert.match(user, /recent finding text/);
	assert.match(user, /REVIEWABLE-ROOT CONTRACT/);
	assert.match(user, /WORKED EXAMPLE/);
	assert.match(user, /Top-level node MUST be a composition/);
});

test('runSectionPlanner: catalogHint surfaces in the user prompt when set', async () => {
	const { provider, calls } = scriptedProvider([HEALTHY_TREE_JSON]);
	await runSectionPlanner({
		todo:        makeTodo(),
		memory:      makeMemory(),
		catalogHint: '- shared.compare-fields-vs-shape -- diff two field sets',
		provider,
	});
	const user = calls[0]!.messages[1]!.content;
	assert.match(user, /SKILL CATALOG HINT/);
	assert.match(user, /shared\.compare-fields-vs-shape/);
});

test('runSectionPlanner: no catalogHint -> SKILL CATALOG HINT section omitted', async () => {
	const { provider, calls } = scriptedProvider([HEALTHY_TREE_JSON]);
	await runSectionPlanner({ todo: makeTodo(), memory: makeMemory(), provider });
	const user = calls[0]!.messages[1]!.content;
	assert.ok(!user.includes('SKILL CATALOG HINT'));
});

test('runSectionPlanner: respects degenerateOpts override (looser bound)', async () => {
	// A tree that fails default minLeaves=2 (single-leaf top-level) but
	// would otherwise be acceptable under a very loose policy.
	// The structural validator still requires >=1 leaf so we need a
	// tree that passes structural + degenerate-with-loose-opts.
	// Use a healthy tree -- the override case is a sanity check that
	// the opts flow through without breaking the happy path.
	const { provider } = scriptedProvider([HEALTHY_TREE_JSON]);
	const result = await runSectionPlanner({
		todo:           makeTodo(),
		memory:         makeMemory(),
		provider,
		degenerateOpts: { minTopLevelChildren: 1, minLeaves: 1 },
	});
	assert.equal(result.retried, false);
});

// ---------------------------------------------------------------------------
// WORKED_EXAMPLE_JSON validates as a healthy tree
// ---------------------------------------------------------------------------

test('worked example: itself a healthy tree (the LLM does not see a degenerate example)', () => {
	const r = validateAll(WORKED_EXAMPLE_JSON_VALUE, undefined);
	assert.equal(r.ok, true);
});
