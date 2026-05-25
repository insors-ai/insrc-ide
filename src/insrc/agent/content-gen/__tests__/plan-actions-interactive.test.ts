/**
 * Tests for `planActionsInteractive` (Plan 4 Phase 2).
 *
 * Three surfaces:
 *   1. Pure helpers (seed-message builder, subtype-hint map,
 *      tool-catalog construction)
 *   2. End-to-end happy path -- fake cloud emits a probe, then
 *      submit_plan; substrate validates + returns PlanActionsResult
 *   3. Failure paths -- exhaustion, provider error, empty actions,
 *      planner emits text instead of a tool call
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	planActionsInteractive,
	_buildSeedMessagesForTest         as buildSeedMessages,
	_buildPlannerToolCatalogForTest   as buildPlannerToolCatalog,
	_renderSkillResultForLLMForTest   as renderSkillResultForLLM,
	_SUBTYPE_HINTS_FOR_TEST           as SUBTYPE_HINTS,
} from '../plan-actions-interactive.js';
import { registerAllSkills } from '../../../daemon/skills/index.js';
import { _resetSkillRegistryForTests } from '../../../daemon/skills/registry.js';
import { _resetRegistryForTests } from '../../../daemon/tools/registry.js';
import { registerSkillTools } from '../../../daemon/tools/builtins/skills/invoke-skill.js';
import type {
	LLMProvider,
	LLMMessage,
	LLMResponse,
	CompletionOpts,
	ToolCall,
} from '../../../shared/types.js';
import type { Session } from '../../session.js';
import type { AnalysisSubtype } from '../../classify/scope.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setup(): void {
	_resetSkillRegistryForTests();
	_resetRegistryForTests();
	registerAllSkills();
	registerSkillTools();
}

const FAKE_SESSION = {} as unknown as Session;
const FAKE_RESOLVER = (() => ({} as unknown as LLMProvider));

function fakeProvider(script: readonly LLMResponse[]): {
	provider: LLMProvider;
	calls:    { messages: readonly LLMMessage[]; opts: CompletionOpts | undefined }[];
} {
	const calls: { messages: readonly LLMMessage[]; opts: CompletionOpts | undefined }[] = [];
	let i = 0;
	const provider: LLMProvider = {
		supportsTools: true,
		async complete(messages, opts) {
			calls.push({ messages: [...messages], opts });
			const r = script[i++];
			if (!r) {
				throw new Error(`fake provider out of canned responses (idx=${i - 1})`);
			}
			return r;
		},
		async *stream() { return; },
		async embed() { return []; },
	};
	return { provider, calls };
}

function toolUse(name: string, input: Record<string, unknown>, id = 'tc1'): ToolCall {
	return { id, name, input };
}

function resp(opts: { text?: string; toolCalls?: ToolCall[] }): LLMResponse {
	const toolCalls = opts.toolCalls;
	return {
		text:       opts.text ?? '',
		stopReason: (toolCalls && toolCalls.length > 0) ? 'tool_use' : 'end_turn',
		...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
	};
}

// ---------------------------------------------------------------------------
// Subtype hints
// ---------------------------------------------------------------------------

test('SUBTYPE_HINTS: covers all 7 AnalysisSubtype values', () => {
	const expected: readonly AnalysisSubtype[] = ['review', 'summarize', 'audit', 'explain', 'compare', 'document', 'diagnose'];
	for (const s of expected) {
		assert.ok(typeof SUBTYPE_HINTS[s] === 'string');
		assert.ok(SUBTYPE_HINTS[s].length > 30);
	}
	assert.equal(Object.keys(SUBTYPE_HINTS).length, expected.length);
});

// ---------------------------------------------------------------------------
// Seed-message builder
// ---------------------------------------------------------------------------

test('buildSeedMessages: produces system + user messages with the request + repoPath', () => {
	const out = buildSeedMessages({
		intent:   'code-analysis',
		request:  'review insors/extraction',
		repoPath: '/repo/insors-extraction',
		tier:     'XL',
		subtype:  'review',
		tools:    [{ name: 'code.source.module.describe', description: 'describe a module', inputSchema: {} }],
	});
	assert.equal(out.length, 2);
	assert.equal(out[0]!.role, 'system');
	assert.equal(out[1]!.role, 'user');
	const system = out[0]!.content as string;
	const user   = out[1]!.content as string;
	assert.match(system, /code\.source\.module\.describe/);
	assert.match(system, /describe a module/);
	assert.match(system, /submit_plan/);
	assert.match(system, /review request/);   // subtype hint
	assert.match(user, /review insors\/extraction/);
	assert.match(user, /\/repo\/insors-extraction/);
	assert.match(user, /XL/);
});

test('buildSeedMessages: subtype hint changes with subtype', () => {
	const base = {
		intent: 'code-analysis', request: 'x', repoPath: '/r', tier: 'M' as const,
		tools: [],
	};
	const review   = buildSeedMessages({ ...base, subtype: 'review'   });
	const summarize = buildSeedMessages({ ...base, subtype: 'summarize' });
	const auditMsg  = buildSeedMessages({ ...base, subtype: 'audit'    });

	const sReview    = review[0]!.content    as string;
	const sSummarize = summarize[0]!.content as string;
	const sAudit     = auditMsg[0]!.content  as string;

	assert.match(sReview,    /gaps, risks/);
	assert.match(sSummarize, /concise, broad-stroke/);
	assert.match(sAudit,     /exhaustive coverage/);
});

test('buildSeedMessages: lists every supplied tool in the catalog section', () => {
	const out = buildSeedMessages({
		intent: 'code-analysis', request: 'x', repoPath: '/r', tier: 'M', subtype: 'review',
		tools: [
			{ name: 'foo', description: 'do foo',      inputSchema: {} },
			{ name: 'bar', description: 'do bar',      inputSchema: {} },
			{ name: 'baz', description: 'do baz',      inputSchema: {} },
		],
	});
	const system = out[0]!.content as string;
	assert.match(system, /`foo`/);
	assert.match(system, /`bar`/);
	assert.match(system, /`baz`/);
});

// ---------------------------------------------------------------------------
// Tool catalog construction
// ---------------------------------------------------------------------------

test('buildPlannerToolCatalog: registers all 9 planner-discovery skill IDs after registerAllSkills', () => {
	setup();
	const catalog = buildPlannerToolCatalog();
	const names = catalog.map(t => t.name).sort();
	assert.deepEqual(names, [
		'code.entity.locate-by-name',
		'code.entity.search-by-vector',
		'code.entity.summary',
		'code.repo.git-recent',
		'code.repo.git-status',
		'code.source.file.describe',
		'code.source.grep',
		'code.source.module.describe',
		'code.source.repo.describe',
	]);
});

test('buildPlannerToolCatalog: each tool carries its skill description and schema', () => {
	setup();
	const catalog = buildPlannerToolCatalog();
	for (const t of catalog) {
		assert.ok(t.description.length > 30, `${t.name}: description too short`);
		assert.ok(typeof t.inputSchema === 'object', `${t.name}: no schema`);
	}
});

// ---------------------------------------------------------------------------
// Skill result rendering
// ---------------------------------------------------------------------------

test('renderSkillResultForLLM: emits header + value JSON', () => {
	const out = renderSkillResultForLLM('code.foo', {
		value:      { hello: 'world' },
		confidence: 'high',
		notes:      [],
		toolCalls:  [],
	});
	assert.match(out, /\[skill:code\.foo\]/);
	assert.match(out, /confidence=high/);
	assert.match(out, /"hello": "world"/);
});

test('renderSkillResultForLLM: includes notes when present', () => {
	const out = renderSkillResultForLLM('code.bar', {
		value:      null,
		confidence: 'medium',
		notes:      ['note one', 'note two'],
		toolCalls:  [],
	});
	assert.match(out, /notes:/);
	assert.match(out, /- note one/);
	assert.match(out, /- note two/);
});

test('renderSkillResultForLLM: handles unserializable values gracefully', () => {
	const cyclic: Record<string, unknown> = {};
	cyclic['self'] = cyclic;
	const out = renderSkillResultForLLM('code.baz', {
		value:      cyclic,
		confidence: 'low',
		notes:      [],
		toolCalls:  [],
	});
	assert.match(out, /<unserializable>/);
});

// ---------------------------------------------------------------------------
// End-to-end happy path
// ---------------------------------------------------------------------------

test('planActionsInteractive: probe then submit_plan -> returns PlanActionsResult', async () => {
	setup();
	const submitPayload = {
		intentBrief: 'Sample plan for the insors extraction module.',
		actions: [
			{
				id:               'overview',
				title:            'Extraction Subsystem Overview',
				objective:        'Summarize the extraction package layout.',
				maxBudgetTokens:  1500,
				reviewCriteria:   ['names the major subpackages', 'identifies the public API surface', 'covers data flow'],
			},
		],
	};
	const { provider, calls } = fakeProvider([
		// Turn 1: probe (returns error -- skill will fail on missing fixtures, that's fine)
		resp({ toolCalls: [toolUse('code.source.module.describe', { modulePath: '/nonexistent', repoPath: '/nonexistent' }, 't1')] }),
		// Turn 2: commit via submit_plan
		resp({ toolCalls: [toolUse('submit_plan', submitPayload, 't2')] }),
	]);
	const out = await planActionsInteractive({
		intent:          'code-analysis',
		request:         'analyze the extraction subsystem',
		repoPath:        '/repo/example',
		tier:            'XL',
		subtype:         'review',
		session:         FAKE_SESSION,
		resolveProvider: FAKE_RESOLVER,
	}, provider);
	assert.equal(out.degraded, false);
	assert.equal(out.actions.length, 1);
	assert.equal(out.actions[0]!.id, 'overview');
	assert.equal(out.intentBrief, submitPayload.intentBrief);
	assert.equal(calls.length, 2);   // 1 probe + 1 commit
});

test('planActionsInteractive: submit_plan on turn 1 (no probes) -> still works', async () => {
	setup();
	const submitPayload = {
		intentBrief: 'tight plan',
		actions: [{
			id: 's1', title: 'Section 1', objective: 'do x',
			maxBudgetTokens: 1500, reviewCriteria: ['a', 'b', 'c'],
		}],
	};
	const { provider } = fakeProvider([
		resp({ toolCalls: [toolUse('submit_plan', submitPayload)] }),
	]);
	const out = await planActionsInteractive({
		intent:          'code-analysis',
		request:         'tiny scope',
		repoPath:        '/r',
		tier:            'S',
		session:         FAKE_SESSION,
		resolveProvider: FAKE_RESOLVER,
	}, provider);
	assert.equal(out.degraded, false);
	assert.equal(out.actions.length, 1);
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

test('planActionsInteractive: turn-cap exhausted -> degraded', async () => {
	setup();
	// 4 turns of probes, never commits -> exhausts at turn 4.
	const { provider } = fakeProvider([
		resp({ toolCalls: [toolUse('code.source.module.describe', { modulePath: '/a', repoPath: '/a' }, '1')] }),
		resp({ toolCalls: [toolUse('code.source.module.describe', { modulePath: '/b', repoPath: '/b' }, '2')] }),
		resp({ toolCalls: [toolUse('code.source.module.describe', { modulePath: '/c', repoPath: '/c' }, '3')] }),
		resp({ toolCalls: [toolUse('code.source.module.describe', { modulePath: '/d', repoPath: '/d' }, '4')] }),
	]);
	const out = await planActionsInteractive({
		intent: 'code-analysis', request: 'wander', repoPath: '/r', tier: 'XL',
		session: FAKE_SESSION, resolveProvider: FAKE_RESOLVER, maxTurns: 4,
	}, provider);
	assert.equal(out.degraded, true);
	assert.match(out.note ?? '', /exhausted/);
});

test('planActionsInteractive: provider error -> degraded with note', async () => {
	setup();
	const provider: LLMProvider = {
		supportsTools: true,
		async complete() { throw new Error('cloud is down'); },
		async *stream() { return; },
		async embed() { return []; },
	};
	const out = await planActionsInteractive({
		intent: 'code-analysis', request: 'x', repoPath: '/r', tier: 'M',
		session: FAKE_SESSION, resolveProvider: FAKE_RESOLVER,
	}, provider);
	assert.equal(out.degraded, true);
	assert.match(out.note ?? '', /provider error/);
});

test('planActionsInteractive: empty request -> throws', async () => {
	const { provider } = fakeProvider([]);
	await assert.rejects(
		planActionsInteractive({
			intent: 'code-analysis', request: '', repoPath: '/r', tier: 'M',
			session: FAKE_SESSION, resolveProvider: FAKE_RESOLVER,
		}, provider),
		/request.*non-empty/,
	);
});

test('planActionsInteractive: submit_plan with schema-violating payload -> retries, then succeeds', async () => {
	setup();
	const { provider, calls } = fakeProvider([
		// Turn 1: invalid submit_plan (no actions field)
		resp({ toolCalls: [toolUse('submit_plan', { intentBrief: 'x' }, 't1')] }),
		// Turn 2: valid submit_plan
		resp({ toolCalls: [toolUse('submit_plan', {
			intentBrief: 'fixed',
			actions: [{ id: 's1', title: 'T', objective: 'O', maxBudgetTokens: 1500, reviewCriteria: ['a', 'b'] }],
		}, 't2')] }),
	]);
	const out = await planActionsInteractive({
		intent: 'code-analysis', request: 'x', repoPath: '/r', tier: 'M',
		session: FAKE_SESSION, resolveProvider: FAKE_RESOLVER,
	}, provider);
	assert.equal(out.degraded, false);
	assert.equal(out.actions.length, 1);
	assert.equal(calls.length, 2);
});

test('planActionsInteractive: maxActions clamps the returned actions', async () => {
	setup();
	const submitPayload = {
		intentBrief: 'many',
		actions: Array.from({ length: 10 }, (_, i) => ({
			id: `s${i}`, title: `T${i}`, objective: `o${i}`,
			maxBudgetTokens: 1500, reviewCriteria: ['a', 'b'],
		})),
	};
	const { provider } = fakeProvider([
		resp({ toolCalls: [toolUse('submit_plan', submitPayload)] }),
	]);
	const out = await planActionsInteractive({
		intent: 'code-analysis', request: 'x', repoPath: '/r', tier: 'M',
		session: FAKE_SESSION, resolveProvider: FAKE_RESOLVER,
		maxActions: 3,
	}, provider);
	assert.equal(out.degraded, false);
	assert.equal(out.actions.length, 3);
});
