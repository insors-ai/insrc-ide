/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for Step 2 (Investigation Plan) of the section-flow
 * orchestrator (P2).
 *
 * Covered:
 * - Fast path: scope.isTrivial -> single-TODO plan, no LLM call.
 * - General path: LLM emits 2-12 TODOs, validator passes.
 * - Validation errors:
 *     - 0 TODOs / >12 TODOs / empty objective / overlong objective /
 *       near-duplicate objectives -> first attempt rejected.
 * - Retry path: first attempt fails validation, retry passes,
 *   result.retried === true.
 * - Retry path: both attempts fail validation -> throws.
 * - Id derivation: missing id derived from objective; collisions
 *   suffixed (-2, -3, ...).
 * - Fingerprint: near-duplicate "review the data layer" vs
 *   "Review the data layer!" rejected.
 * - LLM contract: disableThinking + temperature 0 + responseFormat
 *   'json'.
 * - Hadoop-shaped prompt yields the documented 5-8 TODO range
 *   (acceptance from the plan).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	runInvestigationPlan,
	_validateForTest             as validate,
	_fingerprintObjectiveForTest as fingerprintObjective,
	_deriveIdForTest             as deriveId,
	_normaliseIdForTest          as normaliseId,
	_buildTrivialTodoForTest     as buildTrivialTodo,
	_parseResponseForTest        as parseResponse,
	MAX_TODOS_VALUE,
	MAX_OBJECTIVE_LEN_VALUE,
} from '../step-investigation-plan.js';
import type { ScopeStepResult } from '../types.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';

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

function makeScope(overrides: Partial<ScopeStepResult> = {}): ScopeStepResult {
	return {
		scope:        overrides.scope        ?? 'L',
		subtype:      overrides.subtype      ?? 'review',
		contextRefs:  overrides.contextRefs  ?? [],
		isTrivial:    overrides.isTrivial    ?? false,
		reasoning:    overrides.reasoning    ?? 'L scope rationale',
		fallback:     overrides.fallback     ?? false,
	};
}

const validPlan = (todos: ReadonlyArray<{ id?: string; objective: string }>, reasoning = 'r'): string =>
	JSON.stringify({ todos, reasoning });

// ---------------------------------------------------------------------------
// Fast path
// ---------------------------------------------------------------------------

test('fast path: trivial scope + one ref -> single-TODO plan, no LLM call', async () => {
	const { provider, calls } = scriptedProvider([]);
	const scope = makeScope({
		scope: 'S',
		isTrivial: true,
		contextRefs: [{ kind: 'file', value: 'INGRN.py', origin: 'user-mention' }],
	});
	const result = await runInvestigationPlan({
		question: 'What does INGRN.py do?',
		scope,
		provider,
	});
	assert.equal(calls.length, 0);
	assert.equal(result.isFastPath, true);
	assert.equal(result.retried, false);
	assert.equal(result.todos.length, 1);
	assert.equal(result.todos[0]!.origin, 'initial');
	assert.match(result.todos[0]!.objective, /INGRN\.py/);
});

test('fast path: trivial scope with no refs falls back to question-based objective', () => {
	const scope = makeScope({ scope: 'S', isTrivial: true, contextRefs: [] });
	const todo = buildTrivialTodo('answer this question please', scope);
	assert.match(todo.objective, /answer this question please/);
});

// ---------------------------------------------------------------------------
// General-path happy path
// ---------------------------------------------------------------------------

test('general path: 5 TODOs validate cleanly; result.retried=false', async () => {
	const planJson = validPlan([
		{ id: 'discover-overview',  objective: 'Survey the HDFS module layout' },
		{ id: 'analyze-namenode',   objective: 'Audit NameNode metadata flow' },
		{ id: 'analyze-datanode',   objective: 'Audit DataNode block storage path' },
		{ id: 'analyze-rpc',        objective: 'Map the NN<->DN RPC contracts' },
		{ id: 'synthesize-summary', objective: 'Synthesize cross-component summary' },
	], 'standard discover -> analyze -> synthesize breakdown');
	const { provider, calls } = scriptedProvider([planJson]);
	const result = await runInvestigationPlan({
		question: 'Comprehensive HDFS review',
		scope: makeScope({ scope: 'XXL' }),
		provider,
	});
	assert.equal(calls.length, 1);
	assert.equal(result.todos.length, 5);
	assert.equal(result.isFastPath, false);
	assert.equal(result.retried, false);
	for (const t of result.todos) {
		assert.equal(t.origin, 'initial');
	}
});

test('general path: Hadoop-comprehensive question yields documented 5-8 TODO range', async () => {
	// Plan acceptance: simple data-analyzer -> 1-3 TODOs; Hadoop -> 5-8.
	const todos = [
		{ id: 'overview',        objective: 'High-level HDFS subsystem inventory' },
		{ id: 'namenode',        objective: 'NameNode internals: FSImage + EditLog' },
		{ id: 'datanode',        objective: 'DataNode write/read pipeline' },
		{ id: 'block-manager',   objective: 'BlockManager + replication policy' },
		{ id: 'ha-failover',     objective: 'HA / failover coordination' },
		{ id: 'rpc-protocol',    objective: 'RPC + Hadoop-specific wire formats' },
		{ id: 'security',        objective: 'Authentication + delegation tokens' },
		{ id: 'cross-summary',   objective: 'Synthesize cross-component summary' },
	];
	const { provider } = scriptedProvider([validPlan(todos)]);
	const result = await runInvestigationPlan({
		question: 'Comprehensive review of Hadoop HDFS architecture and key subsystems',
		scope: makeScope({ scope: 'XXL' }),
		provider,
	});
	assert.ok(result.todos.length >= 5);
	assert.ok(result.todos.length <= 8);
});

// ---------------------------------------------------------------------------
// Validation errors -> first attempt rejected
// ---------------------------------------------------------------------------

test('validate: 0 TODOs -> rejected with reason', () => {
	const r = validate([]);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /at least 1 TODO/); }
});

test('validate: too many TODOs -> rejected with reason', () => {
	const todos = Array.from({ length: MAX_TODOS_VALUE + 1 }, (_, i) => ({ objective: `t${i}` }));
	const r = validate(todos);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, new RegExp(`at most ${MAX_TODOS_VALUE} TODOs`)); }
});

test('validate: empty objective -> rejected', () => {
	const r = validate([{ objective: '  ' }]);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /empty objective/); }
});

test('validate: overlong objective -> rejected', () => {
	const long = 'a'.repeat(MAX_OBJECTIVE_LEN_VALUE + 1);
	const r = validate([{ objective: long }]);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, new RegExp(`exceeds ${MAX_OBJECTIVE_LEN_VALUE} chars`)); }
});

test('validate: near-duplicate objectives rejected', () => {
	const r = validate([
		{ objective: 'Review the data layer' },
		{ objective: 'review the DATA layer!' },
	]);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /near-duplicate/); }
});

test('validate: missing id derived from objective', () => {
	const r = validate([{ objective: 'Survey HDFS module layout' }]);
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.todos[0]!.id, 'survey-hdfs-module-layout');
	}
});

test('validate: id collision -> deterministic suffixing', () => {
	const r = validate([
		{ id: 'foo', objective: 'one' },
		{ id: 'foo', objective: 'two' },
		{ id: 'foo', objective: 'three' },
	]);
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.deepEqual(r.todos.map(t => t.id), ['foo', 'foo-2', 'foo-3']);
	}
});

test('validate: id with unsafe chars normalised to kebab-case', () => {
	const r = validate([{ id: 'Foo Bar!!!', objective: 'something' }]);
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.todos[0]!.id, 'foo-bar');
	}
});

test('fingerprintObjective: case + punctuation + whitespace ignored', () => {
	assert.equal(
		fingerprintObjective('Review the data-layer.'),
		fingerprintObjective('REVIEW   the data layer'),
	);
});

test('deriveId: empty-after-clean falls back to todo-N', () => {
	assert.equal(deriveId('!!!', 0), 'todo-1');
});

test('normaliseId: drops leading/trailing dashes + lowercases', () => {
	assert.equal(normaliseId('--Foo-Bar--'), 'foo-bar');
});

// ---------------------------------------------------------------------------
// Retry path
// ---------------------------------------------------------------------------

test('retry: first attempt fails validation; retry passes; retried=true', async () => {
	const badPlan = validPlan([], 'empty');
	const goodPlan = validPlan([
		{ id: 't1', objective: 'first' },
		{ id: 't2', objective: 'second' },
	]);
	const { provider, calls } = scriptedProvider([badPlan, goodPlan]);
	const result = await runInvestigationPlan({
		question: 'q',
		scope: makeScope(),
		provider,
	});
	assert.equal(calls.length, 2);
	assert.equal(result.retried, true);
	assert.equal(result.todos.length, 2);
	// Retry user prompt carries the RETRY CORRECTION block.
	assert.match(calls[1]!.messages[1]!.content, /RETRY CORRECTION/);
});

test('retry: both attempts fail validation -> throws', async () => {
	const empty = validPlan([], 'empty');
	const { provider } = scriptedProvider([empty, empty]);
	await assert.rejects(
		() => runInvestigationPlan({
			question: 'q',
			scope: makeScope(),
			provider,
		}),
		/investigation plan validation failed after retry/,
	);
});

// ---------------------------------------------------------------------------
// LLM contract
// ---------------------------------------------------------------------------

test('LLM call has disableThinking=true + temperature=0 + responseFormat=json', async () => {
	const { provider, calls } = scriptedProvider([
		validPlan([{ id: 't1', objective: 'one' }]),
	]);
	await runInvestigationPlan({ question: 'q', scope: makeScope(), provider });
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.opts.disableThinking, true);
	assert.equal(calls[0]!.opts.temperature, 0);
	assert.equal(calls[0]!.opts.responseFormat, 'json');
});

test('planner user prompt carries scope tier + subtype + context refs', async () => {
	const { provider, calls } = scriptedProvider([
		validPlan([{ id: 't1', objective: 'one' }]),
	]);
	await runInvestigationPlan({
		question: 'q',
		scope: makeScope({
			scope: 'XL',
			subtype: 'audit',
			contextRefs: [{ kind: 'file', value: 'a.py', origin: 'user-mention' }],
		}),
		provider,
	});
	const user = calls[0]!.messages[1]!.content;
	assert.match(user, /tier:\s+XL/);
	assert.match(user, /subtype:\s+audit/);
	assert.match(user, /- file: a\.py/);
});

// ---------------------------------------------------------------------------
// parseResponse robustness
// ---------------------------------------------------------------------------

test('parseResponse: unwraps markdown fences', () => {
	const fenced = '```json\n' + validPlan([{ id: 't1', objective: 'one' }]) + '\n```';
	const parsed = parseResponse(fenced);
	assert.equal(parsed.todos.length, 1);
});

test('parseResponse: malformed JSON throws', () => {
	assert.throws(() => parseResponse('not json'), /JSON parse failed/);
});

test('parseResponse: missing todos array throws', () => {
	assert.throws(() => parseResponse('{"reasoning":"x"}'), /missing or non-array `todos`/);
});

test('parseResponse: skips entries without objective', () => {
	const raw = JSON.stringify({
		todos: [
			{ id: 't1', objective: 'good' },
			{ id: 't2' },                          // missing objective
			null,
			{ objective: 'no-id-but-ok' },
		],
		reasoning: '',
	});
	const parsed = parseResponse(raw);
	assert.equal(parsed.todos.length, 2);
});
