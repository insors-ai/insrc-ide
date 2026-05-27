/**
 * Tests for `summarize-result.ts` (Phase A of
 * plans/analyzers/data-analyzer-parity.md).
 *
 * Pins the structured-output parser shape and the fence-stripping
 * defence. Tests don't exercise the LLM round-trip; they feed canned
 * responses through a fake provider and assert the parser narrows
 * each citation shape correctly, drops malformed entries, and
 * downgrades to a low-confidence "no facts extracted" entry on
 * total parse failure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	summarizeResult,
	_parseCitationForTest as parseCitation,
	_stripJsonCodeFenceForTest as stripJsonCodeFence,
	type SummarizeInput,
} from '../summarize-result.js';
import type { LLMProvider, LLMResponse } from '../../../../shared/types.js';

// ---------------------------------------------------------------------------
// Fake provider
// ---------------------------------------------------------------------------

function fakeProvider(responseText: string): LLMProvider {
	return {
		async complete(): Promise<LLMResponse> {
			return { text: responseText, finishReason: 'stop' };
		},
		async embed() { return []; },
		name() { return 'fake'; },
	} as unknown as LLMProvider;
}

const baseInput: SummarizeInput = {
	skillId:    'data.profile.numeric-rdbms',
	args:       { connectionId: 'pg-primary', table: 'orders', column: 'amount' },
	resultText: '{"min": 0, "max": 9999, "p50": 100, "p99": 5000, "nullRatio": 0.02}',
	objective:  'profile order amount distribution',
	criteria:   ['surface percentiles', 'flag null ratio if > 5%'],
};

// ---------------------------------------------------------------------------
// stripJsonCodeFence
// ---------------------------------------------------------------------------

test('stripJsonCodeFence: passes raw JSON through unchanged', () => {
	const raw = '{"facts": ["a"]}';
	assert.equal(stripJsonCodeFence(raw), raw);
});

test('stripJsonCodeFence: strips ```json fence (Haiku live repro)', () => {
	const wrapped = '```json\n{"facts": ["a"]}\n```';
	assert.equal(stripJsonCodeFence(wrapped), '{"facts": ["a"]}');
});

test('stripJsonCodeFence: strips bare ``` fence', () => {
	const wrapped = '```\n{"facts": ["a"]}\n```';
	assert.equal(stripJsonCodeFence(wrapped), '{"facts": ["a"]}');
});

test('stripJsonCodeFence: case-insensitive language tag', () => {
	assert.equal(stripJsonCodeFence('```JSON\n{}\n```'), '{}');
	assert.equal(stripJsonCodeFence('```Json\n{}\n```'), '{}');
});

// ---------------------------------------------------------------------------
// parseCitation -- per-kind narrowing
// ---------------------------------------------------------------------------

test('parseCitation: rdbms with all fields', () => {
	const cit = parseCitation({
		kind:         'rdbms',
		connectionId: 'pg-primary',
		schema:       'public',
		table:        'orders',
		column:       'amount',
		sampleValue:  '42.50',
	});
	assert.deepEqual(cit, {
		kind:         'rdbms',
		connectionId: 'pg-primary',
		schema:       'public',
		table:        'orders',
		column:       'amount',
		sampleValue:  '42.50',
	});
});

test('parseCitation: rdbms minimal (only required fields)', () => {
	const cit = parseCitation({ kind: 'rdbms', connectionId: 'pg', table: 'users' });
	assert.deepEqual(cit, { kind: 'rdbms', connectionId: 'pg', table: 'users' });
});

test('parseCitation: rdbms rejects missing connectionId', () => {
	const cit = parseCitation({ kind: 'rdbms', table: 'orders' });
	assert.equal(cit, undefined);
});

test('parseCitation: rdbms rejects missing table', () => {
	const cit = parseCitation({ kind: 'rdbms', connectionId: 'pg' });
	assert.equal(cit, undefined);
});

test('parseCitation: kv full shape', () => {
	const cit = parseCitation({
		kind:         'kv',
		connectionId: 'redis-1',
		keyPattern:   'user:{id}:profile',
		fieldPath:    '$.email',
		sampleValue:  'a@b.com',
	});
	assert.deepEqual(cit, {
		kind:         'kv',
		connectionId: 'redis-1',
		keyPattern:   'user:{id}:profile',
		fieldPath:    '$.email',
		sampleValue:  'a@b.com',
	});
});

test('parseCitation: file-source', () => {
	const cit = parseCitation({
		kind:         'file-source',
		connectionId: 'parquet-1',
		path:         's3://bucket/data.parquet',
		column:       'event_ts',
	});
	assert.deepEqual(cit, {
		kind:         'file-source',
		connectionId: 'parquet-1',
		path:         's3://bucket/data.parquet',
		column:       'event_ts',
	});
});

test('parseCitation: code-ref', () => {
	const cit = parseCitation({
		kind:      'code-ref',
		path:      'src/orders/repo.ts',
		lineStart: 42,
		lineEnd:   58,
	});
	assert.deepEqual(cit, {
		kind:      'code-ref',
		path:      'src/orders/repo.ts',
		lineStart: 42,
		lineEnd:   58,
	});
});

test('parseCitation: unknown kind returns undefined', () => {
	const cit = parseCitation({ kind: 'mystery', connectionId: 'x' });
	assert.equal(cit, undefined);
});

test('parseCitation: non-object returns undefined', () => {
	assert.equal(parseCitation('rdbms'), undefined);
	assert.equal(parseCitation(null), undefined);
	assert.equal(parseCitation(undefined), undefined);
	assert.equal(parseCitation(42), undefined);
});

test('parseCitation: rdbms truncates sampleValue at 1024 chars', () => {
	const long = 'x'.repeat(2000);
	const cit = parseCitation({ kind: 'rdbms', connectionId: 'pg', table: 't', sampleValue: long });
	assert.equal(cit?.kind, 'rdbms');
	if (cit?.kind === 'rdbms') {
		assert.equal(cit.sampleValue?.length, 1024);
	}
});

// ---------------------------------------------------------------------------
// summarizeResult -- end-to-end with fake provider
// ---------------------------------------------------------------------------

test('summarizeResult: happy path with rdbms citation + numericFacts', async () => {
	const json = JSON.stringify({
		facts: ['orders.amount has p99 = 5000', 'null ratio is 2%'],
		citations: [
			{ kind: 'rdbms', connectionId: 'pg-primary', schema: 'public', table: 'orders', column: 'amount' },
		],
		numericFacts: [
			{ name: 'p50',       value: 100 },
			{ name: 'p99',       value: 5000 },
			{ name: 'nullRatio', value: 0.02, unit: 'fraction' },
		],
		confidence: 'high',
	});
	const result = await summarizeResult(fakeProvider(json), baseInput);
	assert.equal(result.skillId, 'data.profile.numeric-rdbms');
	assert.equal(result.confidence, 'high');
	assert.equal(result.facts.length, 2);
	assert.equal(result.citations.length, 1);
	assert.equal(result.citations[0]?.kind, 'rdbms');
	assert.equal(result.numericFacts?.length, 3);
	assert.equal(result.numericFacts?.[2]?.unit, 'fraction');
});

test('summarizeResult: strips ```json fence (Haiku live repro)', async () => {
	const wrapped = '```json\n' + JSON.stringify({
		facts: ['ok'],
		citations: [],
		confidence: 'medium',
	}) + '\n```';
	const result = await summarizeResult(fakeProvider(wrapped), baseInput);
	assert.equal(result.confidence, 'medium');
	assert.deepEqual(result.facts, ['ok']);
});

test('summarizeResult: parse failure → low-confidence with synthetic fact', async () => {
	const result = await summarizeResult(fakeProvider('not json at all'), baseInput);
	assert.equal(result.confidence, 'low');
	assert.equal(result.facts.length, 1);
	assert.match(result.facts[0]!, /no facts extracted/);
	assert.deepEqual(result.citations, []);
	assert.equal(result.numericFacts, undefined);
});

test('summarizeResult: drops malformed citations silently', async () => {
	const json = JSON.stringify({
		facts: ['mixed bag'],
		citations: [
			{ kind: 'rdbms', connectionId: 'pg', table: 'orders' },   // OK
			{ kind: 'rdbms', table: 'no_conn_id' },                   // dropped (missing connectionId)
			{ kind: 'unknown', foo: 'bar' },                          // dropped (bad kind)
			null,                                                     // dropped (not object)
			{ kind: 'kv', connectionId: 'redis', keyPattern: 'k:{}' }, // OK
		],
		confidence: 'high',
	});
	const result = await summarizeResult(fakeProvider(json), baseInput);
	assert.equal(result.citations.length, 2);
	assert.equal(result.citations[0]?.kind, 'rdbms');
	assert.equal(result.citations[1]?.kind, 'kv');
});

test('summarizeResult: drops malformed numericFacts entries', async () => {
	const json = JSON.stringify({
		facts: ['x'],
		citations: [],
		numericFacts: [
			{ name: 'good',     value: 1.5 },           // OK
			{ name: 'no-value' },                       // dropped (missing value)
			{ value: 99 },                              // dropped (missing name)
			{ name: 'inf',      value: Infinity },      // serializes to null; dropped
			{ name: 'nan',      value: 'string-val' },  // dropped (value not number)
		],
		confidence: 'high',
	});
	const result = await summarizeResult(fakeProvider(json), baseInput);
	assert.equal(result.numericFacts?.length, 1);
	assert.equal(result.numericFacts?.[0]?.name, 'good');
});

test('summarizeResult: numericFacts omitted entirely when none survive', async () => {
	const json = JSON.stringify({
		facts: ['no numerics here'],
		citations: [],
		numericFacts: [{ name: 'bad' }], // dropped
		confidence: 'low',
	});
	const result = await summarizeResult(fakeProvider(json), baseInput);
	// Empty arrays are omitted to keep the shape clean.
	assert.equal(result.numericFacts, undefined);
});

test('summarizeResult: confidence enum gates other values to low', async () => {
	const json = JSON.stringify({
		facts: ['x'],
		citations: [],
		confidence: 'super-high', // not in enum
	});
	const result = await summarizeResult(fakeProvider(json), baseInput);
	assert.equal(result.confidence, 'low');
});

test('summarizeResult: facts capped at 4 entries', async () => {
	const json = JSON.stringify({
		facts: ['a', 'b', 'c', 'd', 'e', 'f'],
		citations: [],
		confidence: 'high',
	});
	const result = await summarizeResult(fakeProvider(json), baseInput);
	assert.equal(result.facts.length, 4);
	assert.deepEqual(result.facts, ['a', 'b', 'c', 'd']);
});

test('summarizeResult: empty facts → synthetic prose fact', async () => {
	const json = JSON.stringify({
		facts: [],
		citations: [],
		confidence: 'low',
	});
	const result = await summarizeResult(fakeProvider(json), baseInput);
	assert.equal(result.facts.length, 1);
	assert.match(result.facts[0]!, /no facts extracted from data.profile.numeric-rdbms/);
});
