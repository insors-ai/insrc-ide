/**
 * Tests for the planActions helper (Phase 1 of
 * plans/analyzers/cloud-plan-local-expand-cloud-review.md).
 *
 * The helper sends a single LLM call to the cloud provider; we stub
 * the provider with a fakeProvider that returns canned text so the
 * tests stay deterministic without hitting Anthropic / Ollama. The
 * happy path and the validation-retry path both verify that the
 * resulting `PlannedAction[]` is well-formed and clamped to the
 * per-tier action budget.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	planActions,
	ACTION_BUDGET_BY_TIER,
	_validatePlanForTest as validatePlan,
	_buildPlanMessagesForTest as buildPlanMessages,
	_stripFencesForTest as stripFences,
} from '../plan-actions.js';
import type { LLMProvider, LLMResponse, LLMMessage, CompletionOpts } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

function fakeProviderReturning(...texts: readonly string[]): LLMProvider {
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

function fakeProviderThrowing(message: string): LLMProvider {
	return {
		async complete(): Promise<LLMResponse> {
			throw new Error(message);
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: true,
	};
}

function captureMessagesProvider(text: string): {
	provider: LLMProvider;
	getCaptured: () => LLMMessage[];
} {
	let captured: LLMMessage[] = [];
	return {
		provider: {
			async complete(messages: LLMMessage[]): Promise<LLMResponse> {
				captured = messages;
				return { text, stopReason: 'end_turn' };
			},
			async *stream() { yield ''; },
			async embed() { return []; },
			supportsTools: true,
		},
		getCaptured: () => captured,
	};
}

const VALID_PLAN = JSON.stringify({
	intentBrief: 'Describe HDFS Core, the distributed-storage subsystem of Hadoop.',
	actions: [
		{
			id:        'modules-overview',
			title:     'HDFS Core: Module Layout',
			objective: 'Map the top-level HDFS Core packages and their responsibilities.',
			evidence: [
				{ skillId: 'code.source.repo.describe',   executionIdx: 0 },
				{ skillId: 'code.source.module.describe', executionIdx: 1, highlight: 'hadoop-hdfs' },
			],
			maxBudgetTokens: 1500,
			reviewCriteria: [
				'Names each top-level HDFS Core module by absolute path',
				'Cites the module.describe finding at least once',
				'Notes the file count per module',
			],
		},
		{
			id:        'cyclic-deps',
			title:     'Cyclic Dependencies',
			objective: 'Surface the SCC cycles the cyclic-deps skill reported.',
			evidence: [
				{ skillId: 'code.quality.cyclic-deps', executionIdx: 2 },
			],
			maxBudgetTokens: 1200,
			reviewCriteria: [
				'Lists every cycle the skill reported',
				'Calls out the largest cycle by entity count',
			],
		},
	],
});

const FIXTURE_INPUT = {
	request:     'do a detailed analysis of HDFS Core',
	repoSummary: '/repo/hadoop -- Apache Hadoop, Java; primaryLanguages: java, scala',
	executions:  [
		{ skillId: 'code.source.repo.describe',   value: { topModules: [] }, confidence: 'high' as const,    notes: [] },
		{ skillId: 'code.source.module.describe', value: { found: true },    confidence: 'high' as const,    notes: [] },
		{ skillId: 'code.quality.cyclic-deps',    value: { cycleCount: 3 },  confidence: 'high' as const,    notes: [] },
	],
	tier: 'L' as const,
} as const;

// ---------------------------------------------------------------------------
// validatePlan (pure)
// ---------------------------------------------------------------------------

test('validatePlan: valid input -> ok', () => {
	const r = validatePlan(JSON.parse(VALID_PLAN));
	assert.notEqual(typeof r, 'string');
	if (typeof r === 'string') return;
	assert.equal(r.intentBrief.length > 0, true);
	assert.equal(r.actions.length, 2);
	assert.equal(r.actions[0]!.id, 'modules-overview');
});

test('validatePlan: missing intentBrief -> error', () => {
	const r = validatePlan({ actions: [] });
	assert.equal(typeof r, 'string');
	assert.match(r as string, /intentBrief/);
});

test('validatePlan: actions missing -> error', () => {
	const r = validatePlan({ intentBrief: 'x' });
	assert.equal(typeof r, 'string');
	assert.match(r as string, /actions/);
});

test('validatePlan: action missing objective -> error', () => {
	const broken = {
		intentBrief: 'x',
		actions: [{ id: 'a', title: 't', evidence: [], reviewCriteria: ['c'] }],
	};
	const r = validatePlan(broken);
	assert.equal(typeof r, 'string');
	assert.match(r as string, /objective/);
});

test('validatePlan: duplicate ids rejected', () => {
	const broken = {
		intentBrief: 'x',
		actions: [
			{ id: 'a', title: 't', objective: 'o', evidence: [], reviewCriteria: ['c1'] },
			{ id: 'a', title: 't', objective: 'o', evidence: [], reviewCriteria: ['c2'] },
		],
	};
	const r = validatePlan(broken);
	assert.equal(typeof r, 'string');
	assert.match(r as string, /duplicates/);
});

test('validatePlan: evidence with non-numeric executionIdx rejected', () => {
	const broken = {
		intentBrief: 'x',
		actions: [{
			id: 'a', title: 't', objective: 'o',
			evidence: [{ skillId: 's', executionIdx: 'oops' }],
			reviewCriteria: ['c'],
		}],
	};
	const r = validatePlan(broken);
	assert.equal(typeof r, 'string');
	assert.match(r as string, /executionIdx/);
});

test('validatePlan: empty reviewCriteria array rejected', () => {
	const broken = {
		intentBrief: 'x',
		actions: [{
			id: 'a', title: 't', objective: 'o',
			evidence: [{ skillId: 's', executionIdx: 0 }],
			reviewCriteria: [],
		}],
	};
	const r = validatePlan(broken);
	assert.equal(typeof r, 'string');
	assert.match(r as string, /reviewCriteria/);
});

test('validatePlan: maxBudgetTokens clamps to [400, 3000]', () => {
	const r = validatePlan({
		intentBrief: 'x',
		actions: [
			{
				id: 'low', title: 't', objective: 'o',
				evidence: [{ skillId: 's', executionIdx: 0 }],
				reviewCriteria: ['c'],
				maxBudgetTokens: 100,
			},
			{
				id: 'high', title: 't', objective: 'o',
				evidence: [{ skillId: 's', executionIdx: 0 }],
				reviewCriteria: ['c'],
				maxBudgetTokens: 999999,
			},
			{
				id: 'absent', title: 't', objective: 'o',
				evidence: [{ skillId: 's', executionIdx: 0 }],
				reviewCriteria: ['c'],
			},
		],
	});
	assert.notEqual(typeof r, 'string');
	if (typeof r === 'string') return;
	assert.equal(r.actions[0]!.maxBudgetTokens, 400);
	assert.equal(r.actions[1]!.maxBudgetTokens, 3000);
	assert.equal(r.actions[2]!.maxBudgetTokens, 1500);
});

// ---------------------------------------------------------------------------
// buildPlanMessages (prompt assembly)
// ---------------------------------------------------------------------------

test('buildPlanMessages: includes request, repo summary, action budget, executions', () => {
	const { messages, userText } = buildPlanMessages({ ...FIXTURE_INPUT }, 4);
	assert.equal(messages.length, 2);
	assert.equal(messages[0]!.role, 'system');
	assert.equal(messages[1]!.role, 'user');
	assert.match(userText, /## Request/);
	assert.match(userText, /detailed analysis of HDFS Core/);
	assert.match(userText, /## Repository/);
	assert.match(userText, /## Action budget/);
	assert.match(userText, /Maximum actions for this report: 4/);
	assert.match(userText, /scope tier: L/);
	assert.match(userText, /## Executions \(3\)/);
	assert.match(userText, /code\.source\.repo\.describe/);
	assert.match(userText, /code\.quality\.cyclic-deps/);
});

test('buildPlanMessages: priorContextSummary section appears when supplied', () => {
	const { userText } = buildPlanMessages(
		{ ...FIXTURE_INPUT, priorContextSummary: 'Prior turn: described the whole repo (modules, file counts).' },
		4,
	);
	assert.match(userText, /## Prior turns covered/);
	assert.match(userText, /described the whole repo/);
});

test('buildPlanMessages: no priorContextSummary -> section omitted', () => {
	const { userText } = buildPlanMessages({ ...FIXTURE_INPUT }, 4);
	assert.equal(userText.includes('## Prior turns covered'), false);
});

test('buildPlanMessages: empty executions array -> placeholder line', () => {
	const { userText } = buildPlanMessages({ ...FIXTURE_INPUT, executions: [] }, 4);
	assert.match(userText, /## Executions \(0\)/);
	assert.match(userText, /no executions ran/);
});

// ---------------------------------------------------------------------------
// planActions end-to-end
// ---------------------------------------------------------------------------

test('planActions: empty request throws', async () => {
	await assert.rejects(
		() => planActions({ ...FIXTURE_INPUT, request: '' }, fakeProviderReturning('{}')),
		/non-empty/,
	);
});

test('planActions: happy path -> returns parsed plan + degraded:false', async () => {
	const result = await planActions({ ...FIXTURE_INPUT }, fakeProviderReturning(VALID_PLAN));
	assert.equal(result.degraded, false);
	assert.equal(result.actions.length, 2);
	assert.match(result.intentBrief, /HDFS Core/);
});

test('planActions: planner over-shoots tier cap -> clamped', async () => {
	// Build a 6-action plan; tier S only allows 2.
	const overshoot = JSON.stringify({
		intentBrief: 'foo',
		actions: Array.from({ length: 6 }, (_, i) => ({
			id: `act-${i}`,
			title: 't',
			objective: 'o',
			evidence: [{ skillId: 's', executionIdx: 0 }],
			reviewCriteria: ['c'],
		})),
	});
	const result = await planActions(
		{ ...FIXTURE_INPUT, tier: 'S' },
		fakeProviderReturning(overshoot),
	);
	assert.equal(result.degraded, false);
	assert.equal(result.actions.length, ACTION_BUDGET_BY_TIER.S);  // 2
});

test('planActions: explicit maxActions overrides tier cap (clamped to 32)', async () => {
	const overshoot = JSON.stringify({
		intentBrief: 'x',
		actions: Array.from({ length: 50 }, (_, i) => ({
			id: `a${i}`, title: 't', objective: 'o',
			evidence: [{ skillId: 's', executionIdx: 0 }],
			reviewCriteria: ['c'],
		})),
	});
	const result = await planActions(
		{ ...FIXTURE_INPUT, tier: 'S', maxActions: 100 },
		fakeProviderReturning(overshoot),
	);
	assert.equal(result.actions.length, 32);
});

test('planActions: first-pass invalid + second-pass valid -> ok', async () => {
	const result = await planActions(
		{ ...FIXTURE_INPUT },
		fakeProviderReturning('not-json-at-all', VALID_PLAN),
	);
	assert.equal(result.degraded, false);
	assert.equal(result.actions.length, 2);
});

test('planActions: both attempts invalid -> degraded:true with empty actions', async () => {
	const result = await planActions(
		{ ...FIXTURE_INPUT },
		fakeProviderReturning('garbage one', 'garbage two'),
	);
	assert.equal(result.degraded, true);
	assert.equal(result.actions.length, 0);
	assert.match(result.note ?? '', /plan stage failed/);
});

test('planActions: provider throws on first call -> retry, then degraded if second also throws', async () => {
	const result = await planActions(
		{ ...FIXTURE_INPUT },
		fakeProviderThrowing('connection lost'),
	);
	assert.equal(result.degraded, true);
	assert.match(result.note ?? '', /provider error/);
});

test('planActions: schema-violating first response includes corrective retry hint', async () => {
	const cap = captureMessagesProvider(VALID_PLAN);
	// The first response is unparseable so a retry message is appended.
	let callCount = 0;
	const provider: LLMProvider = {
		async complete(messages: LLMMessage[]): Promise<LLMResponse> {
			callCount++;
			if (callCount === 1) {
				return { text: 'not json', stopReason: 'end_turn' };
			}
			return cap.provider.complete(messages);
		},
		async *stream() { yield ''; },
		async embed() { return []; },
		supportsTools: true,
	};
	const result = await planActions({ ...FIXTURE_INPUT }, provider);
	assert.equal(result.degraded, false);
	const captured = cap.getCaptured();
	const lastUser = captured.filter(m => m.role === 'user').pop();
	assert.ok(lastUser, 'second attempt should have a user message');
	assert.match(lastUser!.content as string, /Your previous response was rejected/);
});

// ---------------------------------------------------------------------------
// stripFences (exported for symmetry with outline.ts)
// ---------------------------------------------------------------------------

test('stripFences: unwraps ```json fences', () => {
	assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
});

test('stripFences: leaves plain text alone', () => {
	assert.equal(stripFences('{"a":1}'), '{"a":1}');
});
