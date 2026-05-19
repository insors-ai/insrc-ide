/**
 * Integration tests for the lean cloud-plan flow + the cloud reviewer.
 *
 *   planActions(cloud, lean input)
 *     -> per-action: orchestrator runs a writer (writeSectionWithTools
 *        or patchSectionWithTools) scoped to step
 *     -> reviewAction(draft, evidence) returns verdict + workItems
 *     -> stitch
 *
 * The legacy `expandThenReview` 2-round driver was removed in Phase H
 * of plans/code-analyzer-structured-review.md. The new 3-round patch
 * loop runs in the code-analyzer orchestrator directly; this file
 * keeps the planner+reviewer contract pinned at the helper level.
 *
 * No `evidence` refs on PlannedAction. The orchestrator gathers
 * per-step evidence at expand time; this test simulates that by
 * passing canned evidence per action to reviewAction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planActions, type PlanExecution } from '../plan-actions.js';
import { reviewAction } from '../review-action.js';
import type { LLMMessage, LLMProvider, LLMResponse, CompletionOpts } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

function fakeProvider(...texts: readonly string[]): LLMProvider {
	let i = 0;
	return {
		async complete(_messages: LLMMessage[], _opts?: CompletionOpts): Promise<LLMResponse> {
			const text = texts[Math.min(i, texts.length - 1)] ?? '';
			i++;
			return { text, stopReason: 'end_turn' };
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: true,
	};
}

const PLAN_OUTPUT = JSON.stringify({
	intentBrief: 'Detailed analysis of HDFS Core: module layout and cyclic dependencies.',
	actions: [
		{
			id:        'modules',
			title:     'HDFS Core Modules',
			objective: 'Map the top-level HDFS Core packages and their responsibilities.',
			maxBudgetTokens: 1500,
			reviewCriteria: [
				'Names each top-level module by absolute path',
				'Cites the repo summary finding at least once',
			],
		},
		{
			id:        'cycles',
			title:     'Cyclic Dependencies',
			objective: 'Surface the dependency cycles in the HDFS Core code base.',
			maxBudgetTokens: 1200,
			reviewCriteria: [
				'Lists every cycle reported',
				'Calls out the largest cycle by entity count',
			],
		},
	],
});

const FIXTURE_INPUT = {
	intent:         'code-analysis',
	request:        'do a detailed analysis of HDFS Core',
	summaryContext: '/repo/hadoop -- java/scala, ~12500 files, scope tier L. Prior turns covered: whole-repo overview surfacing top modules.',
	tier:           'L' as const,
} as const;

const EVIDENCE_FOR_MODULES: PlanExecution[] = [
	{
		skillId:    'code.source.repo.describe',
		value:      { topModules: [{ path: '/repo/hadoop/hadoop-hdfs', fileCount: 240 }] },
		confidence: 'high',
		notes:      [],
	},
];

// ---------------------------------------------------------------------------
// Planner integration
// ---------------------------------------------------------------------------

test('integration: lean plan -> N actions in plan order, no evidence field', async () => {
	const cloudPlanProvider = fakeProvider(PLAN_OUTPUT);
	const plan = await planActions({ ...FIXTURE_INPUT }, cloudPlanProvider);

	assert.equal(plan.degraded, false);
	assert.equal(plan.actions.length, 2);
	assert.equal(plan.actions[0]!.id, 'modules');
	assert.equal(plan.actions[1]!.id, 'cycles');
	for (const a of plan.actions) {
		assert.equal((a as unknown as { evidence?: unknown }).evidence, undefined);
	}
});

test('integration: planner output feeds reviewer correctly (per-action contract)', async () => {
	const cloudPlanProvider = fakeProvider(PLAN_OUTPUT);
	const plan = await planActions({ ...FIXTURE_INPUT }, cloudPlanProvider);

	// One reviewer call per action: first action accepts, second flags work items.
	const reviewProvider = fakeProvider(
		JSON.stringify({ verdict: 'accept', workItems: [], notes: ['ok'] }),
		JSON.stringify({
			verdict:   'needs-work',
			workItems: [{
				id:     'wi-1',
				kind: 'fix',
				where:  'paragraph 1',
				issue:  'largest cycle not named',
				action: 'mention the largest cycle by name',
			}],
			notes:     [],
		}),
	);

	const results: { id: string; verdict: string; workItems: number }[] = [];
	for (const action of plan.actions) {
		// Simulate the orchestrator handing a canned draft to the reviewer.
		const draft = {
			actionId:      action.id,
			markdown:      action.id === 'modules' ? '/repo/hadoop/hadoop-hdfs (240 files).' : 'Three cycles reported.',
			tokenEstimate: 100,
			truncated:     false,
			degraded:      false,
		};
		const review = await reviewAction(
			{ action, draft, evidence: EVIDENCE_FOR_MODULES, analyzerLabel: 'code-analyzer' },
			reviewProvider,
		);
		results.push({ id: action.id, verdict: review.verdict, workItems: review.workItems.length });
	}

	assert.deepEqual(results, [
		{ id: 'modules', verdict: 'accept',     workItems: 0 },
		{ id: 'cycles',  verdict: 'needs-work', workItems: 1 },
	]);
});

test('integration: planner degraded -> caller substitutes fallback action', async () => {
	const cloudPlanProvider = fakeProvider('garbage', 'still garbage');
	const plan = await planActions({ ...FIXTURE_INPUT }, cloudPlanProvider);
	assert.equal(plan.degraded, true);
	assert.equal(plan.actions.length, 0);
	// Orchestrator (not this test) substitutes a synthetic fallback
	// action; here we just assert the contract: degraded=true with
	// empty actions.
});

test('integration: reviewer soft-accepts when both attempts produce garbage', async () => {
	const cloudPlanProvider = fakeProvider(PLAN_OUTPUT);
	const plan = await planActions({ ...FIXTURE_INPUT }, cloudPlanProvider);
	const action = plan.actions[0]!;

	const reviewProvider = fakeProvider('garbage one', 'garbage two');
	const draft = {
		actionId:      action.id,
		markdown:      'something the local model drafted',
		tokenEstimate: 50,
		truncated:     false,
		degraded:      false,
	};
	const review = await reviewAction(
		{ action, draft, evidence: EVIDENCE_FOR_MODULES, analyzerLabel: 'code-analyzer' },
		reviewProvider,
	);
	assert.equal(review.verdict, 'accept');
	assert.equal(review.degraded, true);
	assert.deepEqual(review.workItems, []);
	assert.equal(review.accepted?.markdown, 'something the local model drafted');
});

test('integration: tier S clamps planner overshoot to 2 actions', async () => {
	const overshoot = JSON.stringify({
		intentBrief: 'x',
		actions: Array.from({ length: 6 }, (_, i) => ({
			id: `act-${i}`, title: 't', objective: 'o', reviewCriteria: ['c'],
		})),
	});
	const plan = await planActions(
		{ ...FIXTURE_INPUT, tier: 'S' },
		fakeProvider(overshoot),
	);
	assert.equal(plan.actions.length, 2);
});
