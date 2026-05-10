/**
 * Integration test for the cloud-plan / local-expand / cloud-review
 * synthesis flow (Phase 7 of plans/analyzers/cloud-plan-local-expand-
 * cloud-review.md). End-to-end exercise of the three helpers together:
 *
 *   planActions(cloud)
 *     -> expandThenReview(local, cloud) per action
 *     -> stitch
 *
 * Stubbed providers throughout; no Ollama / Anthropic dependency. The
 * orchestrator-side stitch is exercised separately in the orchestrator's
 * own tests (controllers/__tests__/...). This file locks in the
 * cross-helper contract: a planner output of N actions produces N
 * sections, each through its own expand+review loop, in plan order.
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
			objective: 'Map the top-level HDFS Core packages.',
			evidence:  [{ skillId: 'code.source.repo.describe', executionIdx: 0 }],
			maxBudgetTokens: 1500,
			reviewCriteria: [
				'Names each top-level module by absolute path',
				'Cites the repo.describe finding',
			],
		},
		{
			id:        'cycles',
			title:     'Cyclic Dependencies',
			objective: 'Surface the cycles the cyclic-deps skill reported.',
			evidence:  [{ skillId: 'code.quality.cyclic-deps', executionIdx: 1 }],
			maxBudgetTokens: 1200,
			reviewCriteria: [
				'Lists every cycle the skill reported',
				'Calls out the largest cycle by entity count',
			],
		},
	],
});

const EXECUTIONS: PlanExecution[] = [
	{
		skillId:    'code.source.repo.describe',
		value:      { topModules: [{ path: '/repo/hadoop/hadoop-hdfs', fileCount: 240 }] },
		confidence: 'high',
		notes:      [],
	},
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

test('integration: plan -> per-action expandThenReview -> all sections produced in plan order', async () => {
	// Cloud planner: returns the canned 2-action plan.
	const cloudPlanProvider = fakeProvider(PLAN_OUTPUT);

	const plan = await planActions(
		{
			request:     'do a detailed analysis of HDFS Core',
			repoSummary: '/repo/hadoop -- languages: java, scala',
			executions:  EXECUTIONS,
			tier:        'L',
		},
		cloudPlanProvider,
	);

	assert.equal(plan.degraded, false);
	assert.equal(plan.actions.length, 2);
	assert.equal(plan.actions[0]!.id, 'modules');
	assert.equal(plan.actions[1]!.id, 'cycles');

	// Local expander: yields a different body per action so we can
	// verify ordering. Reviewer: accepts both on first pass.
	const localProvider = fakeProvider(
		'HDFS Core sits at `/repo/hadoop/hadoop-hdfs` (240 files).',
		'cyclic-deps reported 3 cycles; the largest involves entities A, B, C.',
	);
	const reviewProvider = fakeProvider(
		JSON.stringify({ verdict: 'accept', notes: ['criteria satisfied'] }),
		JSON.stringify({ verdict: 'accept', notes: ['cycle count verified'] }),
	);

	const sections: { id: string; title: string; markdown: string }[] = [];
	for (const action of plan.actions) {
		const evidence = EXECUTIONS.filter(e => action.evidence.some(r => r.skillId === e.skillId));
		const out = await expandThenReview(
			{
				action,
				evidence,
				request: 'do a detailed analysis of HDFS Core',
			},
			localProvider,
			reviewProvider,
		);
		sections.push({ id: action.id, title: action.title, markdown: out.markdown });
		assert.equal(out.rounds, 1);
		assert.equal(out.verdict, 'accept');
	}

	// All sections present in plan order.
	assert.equal(sections.length, 2);
	assert.equal(sections[0]!.id, 'modules');
	assert.equal(sections[1]!.id, 'cycles');
	assert.match(sections[0]!.markdown, /HDFS Core sits at/);
	assert.match(sections[1]!.markdown, /cyclic-deps reported 3 cycles/);
});

test('integration: refine on one action does not affect the other', async () => {
	const cloudPlanProvider = fakeProvider(PLAN_OUTPUT);
	const plan = await planActions(
		{
			request:     'do a detailed analysis of HDFS Core',
			repoSummary: '/repo/hadoop',
			executions:  EXECUTIONS,
			tier:        'L',
		},
		cloudPlanProvider,
	);

	// Local expander: 3 calls -- modules-draft1, cycles-draft1, cycles-draft2.
	const localProvider = fakeProvider(
		'modules-draft1',
		'cycles-draft1',
		'cycles-draft2-after-refine',
	);
	// Reviewer: accepts modules; refines cycles on first pass; accepts cycles on second.
	const reviewProvider = fakeProvider(
		JSON.stringify({ verdict: 'accept', notes: ['ok'] }),
		JSON.stringify({ verdict: 'refine', refine: { hint: 'mention the largest cycle by name' }, notes: [] }),
		JSON.stringify({ verdict: 'accept', notes: ['fixed'] }),
	);

	const results: { id: string; rounds: 1 | 2; verdict: string }[] = [];
	for (const action of plan.actions) {
		const evidence = EXECUTIONS.filter(e => action.evidence.some(r => r.skillId === e.skillId));
		const out = await expandThenReview(
			{ action, evidence, request: 'q' },
			localProvider,
			reviewProvider,
		);
		results.push({ id: action.id, rounds: out.rounds, verdict: out.verdict });
	}

	// Modules accepted in 1 round; cycles needed 2.
	assert.deepEqual(results, [
		{ id: 'modules', rounds: 1, verdict: 'accept' },
		{ id: 'cycles',  rounds: 2, verdict: 'refine-then-accept' },
	]);
});

test('integration: planner degraded -> caller substitutes fallback action', async () => {
	const cloudPlanProvider = fakeProvider('garbage', 'still garbage');
	const plan = await planActions(
		{
			request:     'something',
			repoSummary: '/repo/foo',
			executions:  EXECUTIONS,
			tier:        'M',
		},
		cloudPlanProvider,
	);
	assert.equal(plan.degraded, true);
	assert.equal(plan.actions.length, 0);
	// The orchestrator (not this test) is responsible for substituting
	// a synthetic fallback action; here we just assert the contract:
	// degraded=true + actions=[]. Orchestrator-side fallback is
	// covered by the dedicated orchestrator integration tests.
});

test('integration: action evidence with unknown executionIdx still drives a section (orchestrator filters)', async () => {
	// Planner cites an out-of-range index; pickEvidence filtering is
	// the orchestrator's job, but the helpers themselves don't crash.
	const planWithBadEvidence = JSON.stringify({
		intentBrief: 'x',
		actions: [{
			id: 'modules', title: 't', objective: 'o',
			evidence: [{ skillId: 'code.source.repo.describe', executionIdx: 99 }],
			reviewCriteria: ['c'],
		}],
	});
	const cloudPlanProvider = fakeProvider(planWithBadEvidence);
	const plan = await planActions(
		{
			request:     'q',
			repoSummary: '/repo',
			executions:  EXECUTIONS,
			tier:        'M',
		},
		cloudPlanProvider,
	);
	assert.equal(plan.degraded, false);
	assert.equal(plan.actions.length, 1);

	// Run expandThenReview with EMPTY evidence (mimics orchestrator's
	// pickEvidence filtering out the bad ref). The expander still
	// produces a section.
	const localProvider = fakeProvider('a section drafted with no evidence');
	const reviewProvider = fakeProvider(JSON.stringify({ verdict: 'accept' }));
	const out = await expandThenReview(
		{
			action:   plan.actions[0]!,
			evidence: [],          // orchestrator would filter the bad idx
			request:  'q',
		},
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
			id: `act-${i}`, title: 't', objective: 'o',
			evidence: [{ skillId: 'code.source.repo.describe', executionIdx: 0 }],
			reviewCriteria: ['c'],
		})),
	});
	const plan = await planActions(
		{
			request:     'q',
			repoSummary: '/repo',
			executions:  EXECUTIONS,
			tier:        'S',
		},
		fakeProvider(overshoot),
	);
	assert.equal(plan.actions.length, 2);   // S budget
});
