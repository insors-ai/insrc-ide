/**
 * Unit tests for `data.meta.select-scope` (data-analyzer-skills §7.2).
 *
 * The smoke gate exercises the LLM-unavailable degraded path. These
 * tests inject a fakeProvider with canned JSON to cover:
 *   - happy path: valid scoped invocation -> confidence: high
 *   - ambiguity surfacing: multiple-matches drops to medium
 *   - notes surfacing: LLM-flagged uncertainty drops to medium
 *   - validation: hallucinated skillId rejected after retry -> low
 *   - validation: args fail inputSchema -> rejected, retry, low
 *   - validation: connectionId not in roster -> rejected
 *   - empty-candidate-list path: low confidence with clear note
 *   - missing-from-registry candidates: surfaced + dropped
 *   - LLM-throw path: low confidence with LLM-failure note
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerAllSkills } from '../index.js';
import {
	getSkill,
	_resetSkillRegistryForTests,
} from '../registry.js';
import { runSkillIsolated, type FakeProvider } from '../test-harness.js';
import type { LLMResponse } from '../../../shared/types.js';

const SELECT = 'data.meta.select-scope';

interface SelectScopeOutput {
	readonly scoped: readonly {
		readonly skillId: string;
		readonly args: Record<string, unknown>;
		readonly resolvedScope: { readonly connectionId: string; readonly target?: string; readonly columns?: readonly string[] };
		readonly ambiguity?: { readonly kind: string; readonly alternatives?: readonly string[] };
	}[];
	readonly notes: readonly string[];
}

function setup(): void {
	_resetSkillRegistryForTests();
	registerAllSkills();
	assert.ok(getSkill(SELECT), `${SELECT} must be registered`);
	// describe-table is the candidate the tests use; ensure it's in the registry.
	assert.ok(getSkill('data.source.rdbms.describe-table'));
}

function fakeProviderReturning(...texts: readonly string[]): FakeProvider {
	let i = 0;
	return {
		async complete(): Promise<LLMResponse> {
			const text = texts[Math.min(i, texts.length - 1)] ?? '';
			i++;
			return { text, stopReason: 'end_turn' };
		},
	};
}

const RDBMS_ROSTER = [{ id: 'prod-db', family: 'rdbms', kind: 'postgres' }];
const TWO_RDBMS    = [
	{ id: 'prod-db', family: 'rdbms', kind: 'postgres' },
	{ id: 'staging', family: 'rdbms', kind: 'postgres' },
];

const DESCRIBE_CANDIDATE = {
	skillId: 'data.source.rdbms.describe-table',
	rationale: 'RDBMS schema introspection.',
	mustHaveScope: 'connection+target' as const,
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('select-scope: high confidence when args + scope valid', async () => {
	setup();
	const json = JSON.stringify({
		scoped: [
			{
				skillId: 'data.source.rdbms.describe-table',
				args: { connectionId: 'prod-db', target: 'orders' },
				resolvedScope: { connectionId: 'prod-db', target: 'orders' },
			},
		],
		notes: [],
	});

	const { result } = await runSkillIsolated<unknown, SelectScopeOutput>(
		SELECT,
		{
			question: 'Describe the orders table on prod-db.',
			candidates: [DESCRIBE_CANDIDATE],
			connections: RDBMS_ROSTER,
		},
		{ fakeProvider: fakeProviderReturning(json) },
	);

	assert.equal(result.confidence, 'high');
	assert.equal(result.value.scoped.length, 1);
	assert.equal(result.value.scoped[0]!.skillId, 'data.source.rdbms.describe-table');
	assert.equal(result.value.scoped[0]!.args['target'], 'orders');
	assert.equal(result.value.scoped[0]!.resolvedScope.target, 'orders');
});

// ---------------------------------------------------------------------------
// Ambiguity + notes
// ---------------------------------------------------------------------------

test('select-scope: ambiguity surfaces as medium confidence', async () => {
	setup();
	const json = JSON.stringify({
		scoped: [
			{
				skillId: 'data.source.rdbms.describe-table',
				args: { connectionId: 'prod-db', target: 'orders' },
				resolvedScope: { connectionId: 'prod-db', target: 'orders' },
				ambiguity: { kind: 'multiple-matches', alternatives: ['prod-db', 'staging'] },
			},
			{
				skillId: 'data.source.rdbms.describe-table',
				args: { connectionId: 'staging', target: 'orders' },
				resolvedScope: { connectionId: 'staging', target: 'orders' },
				ambiguity: { kind: 'multiple-matches', alternatives: ['prod-db', 'staging'] },
			},
		],
		notes: [],
	});

	const { result } = await runSkillIsolated<unknown, SelectScopeOutput>(
		SELECT,
		{
			question: 'Describe the orders table.',
			candidates: [DESCRIBE_CANDIDATE],
			connections: TWO_RDBMS,
		},
		{ fakeProvider: fakeProviderReturning(json) },
	);

	assert.equal(result.confidence, 'medium');
	assert.equal(result.value.scoped.length, 2);
	assert.ok(result.value.scoped.every(s => s.ambiguity?.kind === 'multiple-matches'));
});

test('select-scope: notes presence drops to medium confidence', async () => {
	setup();
	const json = JSON.stringify({
		scoped: [
			{
				skillId: 'data.source.rdbms.describe-table',
				args: { connectionId: 'prod-db', target: 'orders' },
				resolvedScope: { connectionId: 'prod-db', target: 'orders' },
			},
		],
		notes: ['Sample size defaulted to 50; question did not specify.'],
	});

	const { result } = await runSkillIsolated<unknown, SelectScopeOutput>(
		SELECT,
		{
			question: 'Describe orders.',
			candidates: [DESCRIBE_CANDIDATE],
			connections: RDBMS_ROSTER,
		},
		{ fakeProvider: fakeProviderReturning(json) },
	);

	assert.equal(result.confidence, 'medium');
	assert.equal(result.value.notes.length, 1);
});

// ---------------------------------------------------------------------------
// Validation rejection
// ---------------------------------------------------------------------------

test('select-scope: hallucinated skillId rejected → low after retry', async () => {
	setup();
	const hallucinated = JSON.stringify({
		scoped: [
			{
				skillId: 'data.does.not.exist',
				args: {},
				resolvedScope: { connectionId: 'prod-db' },
			},
		],
		notes: [],
	});

	const { result } = await runSkillIsolated<unknown, SelectScopeOutput>(
		SELECT,
		{
			question: 'whatever',
			candidates: [DESCRIBE_CANDIDATE],
			connections: RDBMS_ROSTER,
		},
		{ fakeProvider: fakeProviderReturning(hallucinated, hallucinated) },
	);

	assert.equal(result.confidence, 'low');
	assert.match(result.notes!.join(' '), /validation twice|not in the candidate list/);
});

test('select-scope: args missing required field rejected → low', async () => {
	setup();
	// describe-table requires connectionId + target. Omit target.
	const bad = JSON.stringify({
		scoped: [
			{
				skillId: 'data.source.rdbms.describe-table',
				args: { connectionId: 'prod-db' },   // missing target
				resolvedScope: { connectionId: 'prod-db' },
			},
		],
		notes: [],
	});

	const { result } = await runSkillIsolated<unknown, SelectScopeOutput>(
		SELECT,
		{
			question: 'Describe orders.',
			candidates: [DESCRIBE_CANDIDATE],
			connections: RDBMS_ROSTER,
		},
		{ fakeProvider: fakeProviderReturning(bad, bad) },
	);

	assert.equal(result.confidence, 'low');
	assert.match(result.notes!.join(' '), /failed inputSchema|validation twice/);
});

test('select-scope: connectionId not in roster rejected → low', async () => {
	setup();
	const bad = JSON.stringify({
		scoped: [
			{
				skillId: 'data.source.rdbms.describe-table',
				args: { connectionId: 'never-registered', target: 'orders' },
				resolvedScope: { connectionId: 'never-registered', target: 'orders' },
			},
		],
		notes: [],
	});

	const { result } = await runSkillIsolated<unknown, SelectScopeOutput>(
		SELECT,
		{
			question: 'Describe orders.',
			candidates: [DESCRIBE_CANDIDATE],
			connections: RDBMS_ROSTER,
		},
		{ fakeProvider: fakeProviderReturning(bad, bad) },
	);

	assert.equal(result.confidence, 'low');
	assert.match(result.notes!.join(' '), /not in the connection roster|validation twice/);
});

test('select-scope: retries once and succeeds when second response is valid', async () => {
	setup();
	const valid = JSON.stringify({
		scoped: [
			{
				skillId: 'data.source.rdbms.describe-table',
				args: { connectionId: 'prod-db', target: 'orders' },
				resolvedScope: { connectionId: 'prod-db', target: 'orders' },
			},
		],
		notes: [],
	});

	const { result } = await runSkillIsolated<unknown, SelectScopeOutput>(
		SELECT,
		{
			question: 'Describe orders.',
			candidates: [DESCRIBE_CANDIDATE],
			connections: RDBMS_ROSTER,
		},
		{ fakeProvider: fakeProviderReturning('not-json', valid) },
	);

	assert.equal(result.confidence, 'high');
	assert.equal(result.value.scoped.length, 1);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('select-scope: empty candidate list → low + clear note', async () => {
	setup();
	const { result } = await runSkillIsolated<unknown, SelectScopeOutput>(
		SELECT,
		{
			question: 'Describe orders.',
			candidates: [],
			connections: RDBMS_ROSTER,
		},
		// No fakeProvider needed -- skill short-circuits before LLM call.
	);

	assert.equal(result.confidence, 'low');
	assert.match(result.notes!.join(' '), /no candidates/);
	// The structured value's notes also carry the human-readable
	// reason for the planner to surface.
	assert.match(result.value.notes.join(' '), /no candidates supplied|empty list/);
});

test('select-scope: candidate not in registry surfaces in notes', async () => {
	setup();
	const valid = JSON.stringify({
		scoped: [
			{
				skillId: 'data.source.rdbms.describe-table',
				args: { connectionId: 'prod-db', target: 'orders' },
				resolvedScope: { connectionId: 'prod-db', target: 'orders' },
			},
		],
		notes: [],
	});

	const { result } = await runSkillIsolated<unknown, SelectScopeOutput>(
		SELECT,
		{
			question: 'Describe orders.',
			candidates: [
				DESCRIBE_CANDIDATE,
				{
					skillId: 'data.does.not.exist',
					rationale: 'phantom',
					mustHaveScope: 'connection',
				},
			],
			connections: RDBMS_ROSTER,
		},
		{ fakeProvider: fakeProviderReturning(valid) },
	);

	// At least one resolved -> not the all-missing path; ran the LLM.
	assert.notEqual(result.confidence, 'low');
	assert.match((result.notes ?? []).join(' '), /unresolved candidate ids/);
});

test('select-scope: every candidate missing from registry → low', async () => {
	setup();
	const { result } = await runSkillIsolated<unknown, SelectScopeOutput>(
		SELECT,
		{
			question: 'whatever',
			candidates: [
				{ skillId: 'data.does.not.exist',     rationale: 'a', mustHaveScope: 'connection' },
				{ skillId: 'data.also.does.not.exist', rationale: 'b', mustHaveScope: 'connection' },
			],
			connections: RDBMS_ROSTER,
		},
	);

	assert.equal(result.confidence, 'low');
	assert.match(result.notes!.join(' '), /no candidates resolved/);
});

test('select-scope: LLM throws → low with clear note', async () => {
	setup();
	const { result } = await runSkillIsolated<unknown, SelectScopeOutput>(
		SELECT,
		{
			question: 'whatever',
			candidates: [DESCRIBE_CANDIDATE],
			connections: RDBMS_ROSTER,
		},
		{
			fakeProvider: {
				async complete(): Promise<LLMResponse> {
					throw new Error('provider boom');
				},
			},
		},
	);

	assert.equal(result.confidence, 'low');
	assert.match(result.notes!.join(' '), /LLM call failed.*provider boom/);
});
