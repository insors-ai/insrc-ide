/**
 * Phase γ tests for plans/code-analyzer-discovery-plan-loop.md.
 *
 * Covers the cloud-side entrypoints:
 *   - expandDiscoveryPlan -- Stage 2 cloud call
 *   - reviewCycle         -- Stage 5 cloud call
 *
 * Tests use a FakeProvider that returns canned JSON responses, no
 * real Anthropic / OpenAI / etc. calls. The provider returns the
 * canned text on each `complete()`; multi-attempt retry is tested by
 * cycling through error -> success in the canned response list.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	expandDiscoveryPlan,
	reviewCycle,
	_validateDiscoveryPlanForTest as validateDiscoveryPlan,
	_validateCycleReviewForTest   as validateCycleReview,
	_buildExpandMessagesForTest   as buildExpandMessages,
	_buildReviewMessagesForTest   as buildReviewMessages,
	_fallbackPlanForTest          as fallbackPlan,
} from '../discovery-plan-actions.js';

import { emptyCycleMemory } from '../discovery-plan.js';
import type {
	CycleMemory,
	StepOutput,
	DiscoveryStep,
} from '../discovery-plan.js';

import type { PlannedAction } from '../plan-actions.js';
import type { LLMProvider, LLMMessage, LLMResponse, CompletionOpts } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const SECTION: PlannedAction = {
	id:                'hdfs-arch',
	title:             'HDFS Architecture & Core Components',
	objective:         'Describe the NameNode + DataNode subsystems and their interaction.',
	maxBudgetTokens:   2000,
	reviewCriteria: [
		'Names NameNode core classes',
		'Explains block placement',
		'Covers HA failover patterns',
		'Identifies lease management',
	],
};

const VALID_PLAN_JSON = JSON.stringify({
	cycle: 1,
	steps: [
		{
			id: 'step-1',
			intent: 'investigate the FSDirectory class in the NameNode',
			skills: [
				{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'the FSDirectory class' },
				{ id: 's1.b', skillId: 'code.entity.summary',         context: 'use entityId from s1.a', dependsOn: 's1.a' },
			],
			targetsCriteria: [0],
		},
		{
			id: 'step-2',
			intent: 'examine DataNode block storage layer',
			skills: [
				{ id: 's2.a', skillId: 'code.source.module.describe', context: 'the hadoop-hdfs-project module' },
			],
			targetsCriteria: [1],
		},
	],
});

const VALID_REVIEW_JSON = JSON.stringify({
	keep: ['step-1'],
	new_steps: [
		{
			id: 'step-3',
			intent: 'investigate HA failover via QuorumJournalManager',
			skills: [
				{ id: 's3.a', skillId: 'code.entity.locate-by-name', context: 'QuorumJournalManager' },
			],
			targetsCriteria: [2],
		},
	],
	scratchpad: 'EditLog uses an unusual journal format -- flag for the writer.',
});

const FIXTURE_STEP_OUTPUTS: StepOutput[] = [
	{
		stepId:    'step-1',
		status:    'ok',
		facts:     ['FSDirectory anchors the namespace'],
		citations: [{ path: '/repo/FSDirectory.java', startLine: 1, endLine: 400, label: 'FSDirectory' }],
		durationMs: 200,
	},
	{
		stepId:    'step-2',
		status:    'partial',
		facts:     ['DataNode module exists'],
		citations: [],
		durationMs: 150,
	},
];

function fakeProvider(responses: readonly (string | Error)[]): LLMProvider {
	let i = 0;
	return {
		supportsTools: true,
		async complete(_messages: LLMMessage[], _opts?: CompletionOpts): Promise<LLMResponse> {
			const next = responses[i++];
			if (next === undefined) throw new Error(`fake provider out of canned responses (idx=${i - 1})`);
			if (next instanceof Error) throw next;
			return { text: next, stopReason: 'end_turn' };
		},
		async *stream() { return; },
		async embed() { return []; },
	};
}

// ---------------------------------------------------------------------------
// validateDiscoveryPlan
// ---------------------------------------------------------------------------

test('validateDiscoveryPlan: valid plan -> parsed', () => {
	const parsed = JSON.parse(VALID_PLAN_JSON);
	const out = validateDiscoveryPlan(parsed, 1);
	if (typeof out === 'string') throw new Error(`expected ok, got: ${out}`);
	assert.equal(out.steps.length, 2);
	assert.equal(out.cycle, 1);
	assert.equal(out.steps[0]!.id, 'step-1');
	assert.equal(out.steps[0]!.skills.length, 2);
	assert.equal(out.steps[0]!.skills[1]!.dependsOn, 's1.a');
});

test('validateDiscoveryPlan: cycle field overridden to expectedCycle (canonical)', () => {
	const parsed = JSON.parse(VALID_PLAN_JSON);
	parsed.cycle = 2;        // cloud said 2
	const out = validateDiscoveryPlan(parsed, 3);   // orchestrator says 3
	if (typeof out === 'string') throw new Error('unexpected error');
	assert.equal(out.cycle, 3);   // orchestrator wins
});

test('validateDiscoveryPlan: non-object -> error', () => {
	assert.equal(typeof validateDiscoveryPlan(null, 1), 'string');
	assert.equal(typeof validateDiscoveryPlan('hello', 1), 'string');
	assert.equal(typeof validateDiscoveryPlan([1, 2], 1), 'string');
});

test('validateDiscoveryPlan: empty steps -> error', () => {
	const r = validateDiscoveryPlan({ cycle: 1, steps: [] }, 1);
	assert.match(String(r), /non-empty/);
});

test('validateDiscoveryPlan: duplicate step ids -> error', () => {
	const r = validateDiscoveryPlan({
		cycle: 1,
		steps: [
			{ id: 's1', intent: 'a', skills: [{ id: 'a', skillId: 'code.x', context: 'x' }], targetsCriteria: [0] },
			{ id: 's1', intent: 'b', skills: [{ id: 'a', skillId: 'code.y', context: 'y' }], targetsCriteria: [1] },
		],
	}, 1);
	assert.match(String(r), /duplicated/);
});

test('validateDiscoveryPlan: step missing required field -> error', () => {
	const r = validateDiscoveryPlan({
		cycle: 1,
		steps: [
			{ id: 's1', intent: '', skills: [{ id: 'a', skillId: 'code.x', context: 'x' }], targetsCriteria: [0] },
		],
	}, 1);
	assert.match(String(r), /intent.*required/);
});

test('validateDiscoveryPlan: skill missing required field -> error', () => {
	const r = validateDiscoveryPlan({
		cycle: 1,
		steps: [
			{ id: 's1', intent: 'a', skills: [{ id: 'a', skillId: '', context: 'x' }], targetsCriteria: [0] },
		],
	}, 1);
	assert.match(String(r), /skillId.*required/);
});

// ---------------------------------------------------------------------------
// validateCycleReview
// ---------------------------------------------------------------------------

test('validateCycleReview: valid response -> parsed', () => {
	const parsed = JSON.parse(VALID_REVIEW_JSON);
	const out = validateCycleReview(parsed, FIXTURE_STEP_OUTPUTS);
	if (typeof out === 'string') throw new Error(`expected ok, got: ${out}`);
	assert.deepEqual([...out.keep], ['step-1']);
	assert.equal(out.new_steps.length, 1);
	assert.equal(out.scratchpad, 'EditLog uses an unusual journal format -- flag for the writer.');
});

test('validateCycleReview: keep ids not in stepOutputs are silently dropped', () => {
	const out = validateCycleReview({
		keep:      ['step-1', 'step-ghost'],
		new_steps: [],
	}, FIXTURE_STEP_OUTPUTS);
	if (typeof out === 'string') throw new Error(out);
	assert.deepEqual([...out.keep], ['step-1']);     // ghost dropped
});

test('validateCycleReview: empty new_steps -> termination signal', () => {
	const out = validateCycleReview({ keep: ['step-1'], new_steps: [] }, FIXTURE_STEP_OUTPUTS);
	if (typeof out === 'string') throw new Error(out);
	assert.equal(out.new_steps.length, 0);
});

test('validateCycleReview: scratchpad omitted -> undefined', () => {
	const out = validateCycleReview({ keep: [], new_steps: [] }, FIXTURE_STEP_OUTPUTS);
	if (typeof out === 'string') throw new Error(out);
	assert.equal(out.scratchpad, undefined);
});

test('validateCycleReview: blank scratchpad -> dropped (treated as omitted)', () => {
	const out = validateCycleReview({ keep: [], new_steps: [], scratchpad: '   ' }, FIXTURE_STEP_OUTPUTS);
	if (typeof out === 'string') throw new Error(out);
	assert.equal(out.scratchpad, undefined);
});

test('validateCycleReview: missing keep array -> error', () => {
	const r = validateCycleReview({ new_steps: [] }, FIXTURE_STEP_OUTPUTS);
	assert.match(String(r), /keep.*array/);
});

test('validateCycleReview: non-array new_steps -> error', () => {
	const r = validateCycleReview({ keep: [], new_steps: 'not an array' }, FIXTURE_STEP_OUTPUTS);
	assert.match(String(r), /new_steps.*array/);
});

test('validateCycleReview: duplicate new_steps ids -> error', () => {
	const r = validateCycleReview({
		keep: [],
		new_steps: [
			{ id: 'x', intent: 'a', skills: [{ id: 'a', skillId: 'code.x', context: 'x' }], targetsCriteria: [0] },
			{ id: 'x', intent: 'b', skills: [{ id: 'a', skillId: 'code.y', context: 'y' }], targetsCriteria: [1] },
		],
	}, FIXTURE_STEP_OUTPUTS);
	assert.match(String(r), /duplicated/);
});

// ---------------------------------------------------------------------------
// buildExpandMessages
// ---------------------------------------------------------------------------

test('buildExpandMessages: includes section title + objective + criteria', () => {
	const msgs = buildExpandMessages({
		section:     SECTION,
		tier:        'XL',
		cycle:       1,
		cycleMemory: emptyCycleMemory(SECTION.reviewCriteria),
	});
	const user = msgs[1]!.content as string;
	assert.match(user, /HDFS Architecture & Core Components/);
	assert.match(user, /Describe the NameNode/);
	assert.match(user, /Names NameNode core classes/);
	assert.match(user, /Cycle 1 of 3/);
});

test('buildExpandMessages: cycle 2+ surfaces CycleMemory block', () => {
	const mem: CycleMemory = {
		priorAsks: [{ cycle: 1, steps: [{ id: 'step-1', intent: 'first ask' }] }],
		criteriaCoverage: SECTION.reviewCriteria.map((c, i) => ({
			criterion: c,
			status: i === 0 ? 'covered' as const : 'open' as const,
			contributingStepIds: i === 0 ? ['step-1'] : [],
		})),
		scratchpad: 'note from cycle 1',
	};
	const msgs = buildExpandMessages({
		section:     SECTION,
		tier:        'XL',
		cycle:       2,
		cycleMemory: mem,
	});
	const user = msgs[1]!.content as string;
	assert.match(user, /Cycle 2 of 3/);
	assert.match(user, /Prior cycles/);
	assert.match(user, /step-1: first ask/);
	assert.match(user, /\[covered\]/);
	assert.match(user, /\[open\]/);
	assert.match(user, /note from cycle 1/);
});

test('buildExpandMessages: system prompt loads from flow/discovery-expand', () => {
	const msgs = buildExpandMessages({
		section:     SECTION,
		tier:        'L',
		cycle:       1,
		cycleMemory: emptyCycleMemory(SECTION.reviewCriteria),
	});
	const sys = msgs[0]!.content as string;
	assert.match(sys, /discovery plan/i);
	assert.match(sys, /Available skills/);
	// Tier-L coverage-angles should be injected.
	assert.match(sys, /tier L/);
});

// ---------------------------------------------------------------------------
// buildReviewMessages
// ---------------------------------------------------------------------------

test('buildReviewMessages: renders step outputs with facts + citations', () => {
	const msgs = buildReviewMessages({
		section:     SECTION,
		cycle:       1,
		stepOutputs: FIXTURE_STEP_OUTPUTS,
		cycleMemory: emptyCycleMemory(SECTION.reviewCriteria),
	});
	const user = msgs[1]!.content as string;
	assert.match(user, /step-1 {2}\(status: ok/);
	assert.match(user, /FSDirectory anchors the namespace/);
	assert.match(user, /\/repo\/FSDirectory\.java#L1-L400/);
	assert.match(user, /step-2 {2}\(status: partial/);
});

test('buildReviewMessages: omits CycleMemory block when memory empty', () => {
	const msgs = buildReviewMessages({
		section:     SECTION,
		cycle:       1,
		stepOutputs: FIXTURE_STEP_OUTPUTS,
		cycleMemory: emptyCycleMemory(SECTION.reviewCriteria),
	});
	const user = msgs[1]!.content as string;
	assert.doesNotMatch(user, /Prior cycles/);
});

// ---------------------------------------------------------------------------
// fallbackPlan
// ---------------------------------------------------------------------------

test('fallbackPlan: produces a single-step plan targeting all criteria', () => {
	const fp = fallbackPlan({
		section:     SECTION,
		tier:        'XL',
		cycle:       2,
		cycleMemory: emptyCycleMemory(SECTION.reviewCriteria),
	});
	assert.equal(fp.cycle, 2);
	assert.equal(fp.steps.length, 1);
	assert.deepEqual([...fp.steps[0]!.targetsCriteria], [0, 1, 2, 3]);
});

// ---------------------------------------------------------------------------
// expandDiscoveryPlan e2e (with fake provider)
// ---------------------------------------------------------------------------

test('expandDiscoveryPlan: happy path -> parsed plan', async () => {
	const plan = await expandDiscoveryPlan(
		{ section: SECTION, tier: 'XL', cycle: 1, cycleMemory: emptyCycleMemory(SECTION.reviewCriteria) },
		fakeProvider([VALID_PLAN_JSON]),
	);
	assert.equal(plan.cycle, 1);
	assert.equal(plan.steps.length, 2);
	assert.equal(plan.steps[0]!.id, 'step-1');
});

test('expandDiscoveryPlan: invalid JSON first, valid second -> recovers', async () => {
	const plan = await expandDiscoveryPlan(
		{ section: SECTION, tier: 'XL', cycle: 1, cycleMemory: emptyCycleMemory(SECTION.reviewCriteria) },
		fakeProvider(['not json', VALID_PLAN_JSON]),
	);
	assert.equal(plan.steps.length, 2);
});

test('expandDiscoveryPlan: all attempts fail -> emits fallback single-step plan', async () => {
	const plan = await expandDiscoveryPlan(
		{ section: SECTION, tier: 'XL', cycle: 1, cycleMemory: emptyCycleMemory(SECTION.reviewCriteria) },
		fakeProvider(['bad', 'still bad', 'still bad too']),
	);
	assert.equal(plan.steps.length, 1);
	assert.equal(plan.steps[0]!.id, 'step-fallback-1');
});

test('expandDiscoveryPlan: provider error then success -> recovers', async () => {
	const plan = await expandDiscoveryPlan(
		{ section: SECTION, tier: 'XL', cycle: 1, cycleMemory: emptyCycleMemory(SECTION.reviewCriteria) },
		fakeProvider([new Error('429 rate limit'), VALID_PLAN_JSON]),
	);
	assert.equal(plan.steps.length, 2);
});

// ---------------------------------------------------------------------------
// reviewCycle e2e (with fake provider)
// ---------------------------------------------------------------------------

test('reviewCycle: happy path -> parsed response', async () => {
	const r = await reviewCycle(
		{ section: SECTION, cycle: 1, stepOutputs: FIXTURE_STEP_OUTPUTS, cycleMemory: emptyCycleMemory(SECTION.reviewCriteria) },
		fakeProvider([VALID_REVIEW_JSON]),
	);
	assert.deepEqual([...r.keep], ['step-1']);
	assert.equal(r.new_steps.length, 1);
	assert.equal(r.scratchpad, 'EditLog uses an unusual journal format -- flag for the writer.');
});

test('reviewCycle: termination signal (empty new_steps)', async () => {
	const r = await reviewCycle(
		{ section: SECTION, cycle: 2, stepOutputs: FIXTURE_STEP_OUTPUTS, cycleMemory: emptyCycleMemory(SECTION.reviewCriteria) },
		fakeProvider([JSON.stringify({ keep: ['step-1', 'step-2'], new_steps: [] })]),
	);
	assert.equal(r.new_steps.length, 0);
	assert.equal(r.keep.length, 2);
});

test('reviewCycle: all attempts fail -> fallback keeps all ok outputs, terminates', async () => {
	const r = await reviewCycle(
		{ section: SECTION, cycle: 1, stepOutputs: FIXTURE_STEP_OUTPUTS, cycleMemory: emptyCycleMemory(SECTION.reviewCriteria) },
		fakeProvider(['bad', 'bad', 'bad']),
	);
	// step-1 was 'ok', step-2 was 'partial' -- only step-1 kept.
	assert.deepEqual([...r.keep], ['step-1']);
	assert.equal(r.new_steps.length, 0);
});
