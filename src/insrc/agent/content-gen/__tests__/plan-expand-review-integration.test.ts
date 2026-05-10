/**
 * Integration test for the lean cloud-plan / local-expand /
 * cloud-review synthesis flow.
 *
 *   planActions(cloud, lean input)
 *     -> per-action: orchestrator runs skills pipeline scoped to step
 *     -> expandThenReview(local, cloud)
 *     -> stitch
 *
 * The orchestrator's per-step skills-pipeline call is exercised in
 * the orchestrator-side tests (controllers/__tests__/...). This file
 * locks in the helper-level contract: the planner's lean output of
 * N actions feeds N independent expand+review loops, in plan order.
 *
 * No `evidence` refs on PlannedAction. The orchestrator gathers
 * per-step evidence at expand time; this test simulates that by
 * passing canned evidence per action.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planActions, type PlanExecution } from '../plan-actions.js';
import { expandThenReview } from '../review-action.js';
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

// Per-step evidence canned for each action -- the orchestrator
// would gather this at expand time via runSkillsPipeline; the
// integration test substitutes pre-canned evidence for determinism.
const EVIDENCE_FOR_MODULES: PlanExecution[] = [
	{
		skillId:    'code.source.repo.describe',
		value:      { topModules: [{ path: '/repo/hadoop/hadoop-hdfs', fileCount: 240 }] },
		confidence: 'high',
		notes:      [],
	},
];
const EVIDENCE_FOR_CYCLES: PlanExecution[] = [
	{
		skillId:    'code.quality.cyclic-deps',
		value:      { cycleCount: 3, cycles: [{ entities: ['A', 'B', 'C'] }] },
		confidence: 'high',
		notes:      [],
	},
];

// ---------------------------------------------------------------------------
// End-to-end happy path
// ---------------------------------------------------------------------------

test('integration: lean plan -> per-action expandThenReview -> all sections produced in plan order', async () => {
	const cloudPlanProvider = fakeProvider(PLAN_OUTPUT);

	const plan = await planActions({ ...FIXTURE_INPUT }, cloudPlanProvider);

	assert.equal(plan.degraded, false);
	assert.equal(plan.actions.length, 2);
	assert.equal(plan.actions[0]!.id, 'modules');
	assert.equal(plan.actions[1]!.id, 'cycles');
	// Plan actions have NO `evidence` field anymore.
	for (const a of plan.actions) {
		assert.equal((a as unknown as { evidence?: unknown }).evidence, undefined);
	}

	const localProvider = fakeProvider(
		'HDFS Core sits at `/repo/hadoop/hadoop-hdfs` (240 files).',
		'cyclic-deps reported 3 cycles; the largest involves entities A, B, C.',
	);
	const reviewProvider = fakeProvider(
		JSON.stringify({ verdict: 'accept', notes: ['criteria satisfied'] }),
		JSON.stringify({ verdict: 'accept', notes: ['cycle count verified'] }),
	);

	const evidenceByActionId: Record<string, PlanExecution[]> = {
		modules: EVIDENCE_FOR_MODULES,
		cycles:  EVIDENCE_FOR_CYCLES,
	};

	const sections: { id: string; title: string; markdown: string }[] = [];
	for (const action of plan.actions) {
		const evidence = evidenceByActionId[action.id] ?? [];
		const out = await expandThenReview(
			{ action, evidence, request: 'do a detailed analysis of HDFS Core' },
			localProvider,
			reviewProvider,
		);
		sections.push({ id: action.id, title: action.title, markdown: out.markdown });
		assert.equal(out.rounds, 1);
		assert.equal(out.verdict, 'accept');
	}

	assert.equal(sections.length, 2);
	assert.equal(sections[0]!.id, 'modules');
	assert.equal(sections[1]!.id, 'cycles');
	assert.match(sections[0]!.markdown, /HDFS Core sits at/);
	assert.match(sections[1]!.markdown, /cyclic-deps reported 3 cycles/);
});

test('integration: refine on one action does not affect the other', async () => {
	const cloudPlanProvider = fakeProvider(PLAN_OUTPUT);
	const plan = await planActions({ ...FIXTURE_INPUT }, cloudPlanProvider);

	// 3 local calls: modules-draft1, cycles-draft1, cycles-draft2.
	const localProvider = fakeProvider('modules-draft1', 'cycles-draft1', 'cycles-draft2-after-refine');
	// Reviewer: accepts modules; refines cycles, then accepts.
	const reviewProvider = fakeProvider(
		JSON.stringify({ verdict: 'accept', notes: ['ok'] }),
		JSON.stringify({ verdict: 'refine', refine: { hint: 'mention the largest cycle by name' }, notes: [] }),
		JSON.stringify({ verdict: 'accept', notes: ['fixed'] }),
	);

	const results: { id: string; rounds: 1 | 2; verdict: string }[] = [];
	const evidenceByActionId: Record<string, PlanExecution[]> = {
		modules: EVIDENCE_FOR_MODULES,
		cycles:  EVIDENCE_FOR_CYCLES,
	};
	for (const action of plan.actions) {
		const evidence = evidenceByActionId[action.id] ?? [];
		const out = await expandThenReview(
			{ action, evidence, request: 'q' },
			localProvider,
			reviewProvider,
		);
		results.push({ id: action.id, rounds: out.rounds, verdict: out.verdict });
	}

	assert.deepEqual(results, [
		{ id: 'modules', rounds: 1, verdict: 'accept' },
		{ id: 'cycles',  rounds: 2, verdict: 'refine-then-accept' },
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

test('integration: empty evidence -> expander still drafts a section', async () => {
	const cloudPlanProvider = fakeProvider(JSON.stringify({
		intentBrief: 'x',
		actions: [{
			id: 'modules', title: 't',
			objective: 'Map the top-level packages.',
			reviewCriteria: ['c'],
		}],
	}));
	const plan = await planActions({ ...FIXTURE_INPUT, tier: 'M' }, cloudPlanProvider);
	assert.equal(plan.degraded, false);
	assert.equal(plan.actions.length, 1);

	// Orchestrator's per-step skills pipeline returned no evidence
	// (cold repo / local model degraded). The expander still drafts.
	const localProvider = fakeProvider('a section drafted with no evidence');
	const reviewProvider = fakeProvider(JSON.stringify({ verdict: 'accept' }));
	const out = await expandThenReview(
		{ action: plan.actions[0]!, evidence: [], request: 'q' },
		localProvider,
		reviewProvider,
	);
	assert.equal(out.verdict, 'accept');
	assert.match(out.markdown, /no evidence/);
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
