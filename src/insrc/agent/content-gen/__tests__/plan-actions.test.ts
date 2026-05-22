/**
 * Tests for the planActions helper.
 *
 * Lean input shape: intent + request + summaryContext + tier. The
 * planner does NOT see skill executions or evidence -- per the
 * design decision, the cloud LLM gets only what it needs to
 * decompose the work; the local model picks tools at expand time.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	planActions,
	DEFAULT_MAX_ACTIONS,
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
		async complete(): Promise<LLMResponse> { throw new Error(message); },
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
			id:        'overview',
			title:     'Overview',
			objective: 'Summarise the purpose and high-level structure of HDFS Core.',
			maxBudgetTokens: 1500,
			reviewCriteria: [
				'States what HDFS Core is and what it does',
				'Mentions the primary subsystems',
			],
		},
		{
			id:        'modules',
			title:     'Module layout',
			objective: 'Map the top-level modules and their responsibilities.',
			maxBudgetTokens: 1200,
			reviewCriteria: [
				'Names each top-level module by path',
				'Notes the file count per module',
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

// ---------------------------------------------------------------------------
// validatePlan (pure)
// ---------------------------------------------------------------------------

test('validatePlan: valid input -> ok', () => {
	const r = validatePlan(JSON.parse(VALID_PLAN));
	assert.notEqual(typeof r, 'string');
	if (typeof r === 'string') return;
	assert.equal(r.intentBrief.length > 0, true);
	assert.equal(r.actions.length, 2);
	assert.equal(r.actions[0]!.id, 'overview');
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
		actions: [{ id: 'a', title: 't', reviewCriteria: ['c'] }],
	};
	const r = validatePlan(broken);
	assert.equal(typeof r, 'string');
	assert.match(r as string, /objective/);
});

test('validatePlan: duplicate ids rejected', () => {
	const broken = {
		intentBrief: 'x',
		actions: [
			{ id: 'a', title: 't', objective: 'o', reviewCriteria: ['c1'] },
			{ id: 'a', title: 't', objective: 'o', reviewCriteria: ['c2'] },
		],
	};
	const r = validatePlan(broken);
	assert.equal(typeof r, 'string');
	assert.match(r as string, /duplicates/);
});

test('validatePlan: empty reviewCriteria array rejected', () => {
	const broken = {
		intentBrief: 'x',
		actions: [{ id: 'a', title: 't', objective: 'o', reviewCriteria: [] }],
	};
	const r = validatePlan(broken);
	assert.equal(typeof r, 'string');
	assert.match(r as string, /reviewCriteria/);
});

test('validatePlan: maxBudgetTokens clamps to [400, 3000]', () => {
	const r = validatePlan({
		intentBrief: 'x',
		actions: [
			{ id: 'low',  title: 't', objective: 'o', reviewCriteria: ['c'], maxBudgetTokens: 100 },
			{ id: 'high', title: 't', objective: 'o', reviewCriteria: ['c'], maxBudgetTokens: 999999 },
			{ id: 'absent', title: 't', objective: 'o', reviewCriteria: ['c'] },
		],
	});
	assert.notEqual(typeof r, 'string');
	if (typeof r === 'string') return;
	assert.equal(r.actions[0]!.maxBudgetTokens, 400);
	assert.equal(r.actions[1]!.maxBudgetTokens, 3000);
	assert.equal(r.actions[2]!.maxBudgetTokens, 1500);
});

test('validatePlan: extra `evidence` field is ignored (back-compat with pre-rewrite plans)', () => {
	// The schema no longer has evidence; old planner outputs that
	// included it should still parse cleanly (we just ignore it).
	const r = validatePlan({
		intentBrief: 'x',
		actions: [{
			id: 'a', title: 't', objective: 'o',
			evidence: [{ skillId: 's', executionIdx: 0 }],
			reviewCriteria: ['c'],
		}],
	});
	assert.notEqual(typeof r, 'string');
	if (typeof r === 'string') return;
	assert.equal((r.actions[0] as unknown as { evidence?: unknown }).evidence, undefined);
});

// ---------------------------------------------------------------------------
// buildPlanMessages (prompt assembly)
// ---------------------------------------------------------------------------

test('buildPlanMessages: includes intent, request, summary context, action budget', () => {
	const { messages, userText } = buildPlanMessages({ ...FIXTURE_INPUT }, 4);
	assert.equal(messages.length, 2);
	assert.equal(messages[0]!.role, 'system');
	assert.equal(messages[1]!.role, 'user');
	const sys = messages[0]!.content as string;
	assert.match(sys, /You plan a code-analysis report/);
	assert.match(userText, /## Intent\ncode-analysis/);
	assert.match(userText, /## Request/);
	assert.match(userText, /detailed analysis of HDFS Core/);
	assert.match(userText, /## Summary context/);
	assert.match(userText, /Prior turns covered: whole-repo overview/);
	assert.match(userText, /## Action budget/);
	assert.match(userText, /Safety ceiling: at most 4 actions/);
	assert.match(userText, /structural shape/);
});

test('buildPlanMessages: empty summary context renders fallback line', () => {
	const { userText } = buildPlanMessages({ ...FIXTURE_INPUT, summaryContext: '' }, 4);
	assert.match(userText, /\(no summary supplied\)/);
});

test('buildPlanMessages: data-analysis intent surfaces in system prompt', () => {
	const { messages } = buildPlanMessages({ ...FIXTURE_INPUT, intent: 'data-analysis' }, 4);
	const sys = messages[0]!.content as string;
	assert.match(sys, /You plan a data-analysis report/);
});

test('buildPlanMessages: NO executions block in the prompt (lean shape)', () => {
	const { userText } = buildPlanMessages({ ...FIXTURE_INPUT }, 4);
	assert.equal(userText.includes('## Executions'), false);
	assert.equal(userText.includes('confidence:'), false);
});

// ---------------------------------------------------------------------------
// Phase E: caller-injected tierContext (plans/code-analyzer-scope-tier-prompts.md)
// ---------------------------------------------------------------------------

test('buildPlanMessages: tierContext (when supplied) appears in the system prompt', () => {
	const tierContext = '## Decomposition guidance (tier XL+)\n\nSENTINEL_TIER_BODY';
	const { messages } = buildPlanMessages(
		{ ...FIXTURE_INPUT, tierContext },
		4,
	);
	const sys = messages[0]!.content as string;
	assert.match(sys, /SENTINEL_TIER_BODY/);
	// The tier block is injected ABOVE the per-action rules (the
	// planner reads the menu first, then learns how to emit actions).
	const tierIdx = sys.indexOf('SENTINEL_TIER_BODY');
	const rulesIdx = sys.indexOf('Per action you MUST emit');
	assert.ok(tierIdx >= 0 && rulesIdx >= 0 && tierIdx < rulesIdx,
		'tierContext should precede the per-action rules');
});

test('buildPlanMessages: tierContext omitted/empty -> system prompt unchanged shape', () => {
	const { messages: msgsNone } = buildPlanMessages({ ...FIXTURE_INPUT }, 4);
	const { messages: msgsEmpty } = buildPlanMessages({ ...FIXTURE_INPUT, tierContext: '' }, 4);
	const { messages: msgsWhite } = buildPlanMessages({ ...FIXTURE_INPUT, tierContext: '   \n  \n' }, 4);
	assert.equal(msgsNone[0]!.content, msgsEmpty[0]!.content);
	assert.equal(msgsEmpty[0]!.content, msgsWhite[0]!.content);
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
	// Lean shape: actions have NO evidence field.
	for (const a of result.actions) {
		assert.equal((a as unknown as { evidence?: unknown }).evidence, undefined);
	}
});

test('planActions: planner over-shoots safety ceiling -> clamped to DEFAULT_MAX_ACTIONS', async () => {
	const overshoot = JSON.stringify({
		intentBrief: 'foo',
		actions: Array.from({ length: DEFAULT_MAX_ACTIONS + 6 }, (_, i) => ({
			id: `act-${i}`,
			title: 't',
			objective: 'o',
			reviewCriteria: ['c'],
		})),
	});
	const result = await planActions(
		{ ...FIXTURE_INPUT, tier: 'S' },
		fakeProviderReturning(overshoot),
	);
	assert.equal(result.degraded, false);
	assert.equal(result.actions.length, DEFAULT_MAX_ACTIONS);
});

test('planActions: explicit maxActions overrides default ceiling (clamped to 32)', async () => {
	const overshoot = JSON.stringify({
		intentBrief: 'x',
		actions: Array.from({ length: 50 }, (_, i) => ({
			id: `a${i}`, title: 't', objective: 'o', reviewCriteria: ['c'],
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

test('planActions: provider throws -> degraded result, no throw', async () => {
	const result = await planActions(
		{ ...FIXTURE_INPUT },
		fakeProviderThrowing('connection lost'),
	);
	assert.equal(result.degraded, true);
	assert.match(result.note ?? '', /provider error/);
});

test('planActions: corrective retry hint appears on second attempt', async () => {
	const cap = captureMessagesProvider(VALID_PLAN);
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
	assert.ok(lastUser);
	assert.match(lastUser!.content as string, /Your previous response was rejected/);
});

// ---------------------------------------------------------------------------
// stripFences
// ---------------------------------------------------------------------------

test('stripFences: unwraps ```json fences', () => {
	assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
});

test('stripFences: leaves plain text alone', () => {
	assert.equal(stripFences('{"a":1}'), '{"a":1}');
});
