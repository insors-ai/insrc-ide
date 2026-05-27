/**
 * Tests for claim-grounding-reviewer.ts (Phase E of
 * plans/analyzers/data-analyzer-parity.md).
 *
 * Coverage:
 *   - validateClaimGrounding: well-formed pass, missing fields,
 *     malformed entries dropped, claim list truncation at 400 chars
 *   - parseJsonStrict: bare JSON, fenced JSON, broken JSON
 *   - End-to-end via FakeProvider:
 *       * any 'low' claim -> verdict 'redraft' with notes
 *       * all 'high' / 'medium' -> verdict 'accept'
 *       * provider error -> soft-accept
 *       * schema violation on every attempt -> soft-accept
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	reviewDataClaimsGrounding,
	_validateClaimGroundingForTest as validateClaimGrounding,
	_parseJsonStrictForTest        as parseJsonStrict,
} from '../claim-grounding-reviewer.js';
import type { DataAnalysisTask, DataEvidenceEntry } from '../types.js';
import type { LLMProvider, LLMResponse } from '../../../../shared/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakeProvider(responses: readonly string[]): { provider: LLMProvider; calls: number } {
	let i = 0;
	const state = { calls: 0 };
	const provider: LLMProvider = {
		supportsTools: false,
		async complete(): Promise<LLMResponse> {
			state.calls++;
			const r = responses[i++];
			if (r === undefined) throw new Error('fake provider out of responses');
			return { text: r, stopReason: 'end_turn' };
		},
		async *stream() { return; },
		async embed() { return []; },
	} as unknown as LLMProvider;
	return { provider, get calls() { return state.calls; } };
}

function throwingProvider(): LLMProvider {
	return {
		supportsTools: false,
		async complete(): Promise<LLMResponse> {
			throw new Error('synthetic provider failure');
		},
		async *stream() { return; },
		async embed() { return []; },
	} as unknown as LLMProvider;
}

const fixtureTask: DataAnalysisTask = {
	itemId:   'task-1',
	kind:     'inspect-schema',
	question: 'describe the orders table',
	origin:   'plan',
};

const fixtureEvidence: DataEvidenceEntry[] = [
	{
		skillId:    'data.source.rdbms.describe-table',
		args:       {},
		facts:      ['orders has 12 columns', 'orders.amount is numeric'],
		citations:  [{ kind: 'rdbms', connectionId: 'pg', table: 'orders' }],
		confidence: 'high',
	},
];

// ---------------------------------------------------------------------------
// parseJsonStrict
// ---------------------------------------------------------------------------

test('parseJsonStrict: parses bare JSON', () => {
	const out = parseJsonStrict('{"a": 1}');
	assert.deepEqual(out, { a: 1 });
});

test('parseJsonStrict: strips ```json fence', () => {
	const out = parseJsonStrict('```json\n{"a": 1}\n```');
	assert.deepEqual(out, { a: 1 });
});

test('parseJsonStrict: strips bare ``` fence', () => {
	const out = parseJsonStrict('```\n{"a": 1}\n```');
	assert.deepEqual(out, { a: 1 });
});

test('parseJsonStrict: returns null on broken JSON', () => {
	assert.equal(parseJsonStrict('not json'), null);
});

// ---------------------------------------------------------------------------
// validateClaimGrounding
// ---------------------------------------------------------------------------

test('validateClaimGrounding: well-formed response', () => {
	const out = validateClaimGrounding({
		claims: [
			{ text: 'orders has 12 columns', evidenceMatch: 'high' },
			{ text: 'orders is partitioned',  evidenceMatch: 'low'  },
		],
		notes: ['some note'],
	});
	if (typeof out === 'string') {
		assert.fail(`expected ValidatedGrounding, got error: ${out}`);
	}
	assert.equal(out.claims.length, 2);
	assert.equal(out.claims[0]!.evidenceMatch, 'high');
	assert.equal(out.notes[0], 'some note');
});

test('validateClaimGrounding: missing claims -> error string', () => {
	const out = validateClaimGrounding({ notes: [] });
	assert.equal(typeof out, 'string');
});

test('validateClaimGrounding: missing notes -> error string', () => {
	const out = validateClaimGrounding({ claims: [] });
	assert.equal(typeof out, 'string');
});

test('validateClaimGrounding: drops malformed claim entries silently', () => {
	const out = validateClaimGrounding({
		claims: [
			{ text: 'ok one', evidenceMatch: 'high' },
			{ text: 'no match score' },                      // dropped
			{ text: 'bad score', evidenceMatch: 'super' },   // dropped
			{ evidenceMatch: 'low' },                        // dropped (no text)
			null,                                            // dropped
		],
		notes: [],
	});
	if (typeof out === 'string') assert.fail(`unexpected error: ${out}`);
	assert.equal(out.claims.length, 1);
	assert.equal(out.claims[0]!.text, 'ok one');
});

test('validateClaimGrounding: truncates claim text at 400 chars', () => {
	const longText = 'x'.repeat(800);
	const out = validateClaimGrounding({
		claims: [{ text: longText, evidenceMatch: 'low' }],
		notes:  [],
	});
	if (typeof out === 'string') assert.fail(`unexpected error: ${out}`);
	assert.equal(out.claims[0]!.text.length, 400);
});

test('validateClaimGrounding: notes capped at 6 entries', () => {
	const out = validateClaimGrounding({
		claims: [],
		notes:  ['1', '2', '3', '4', '5', '6', '7', '8'],
	});
	if (typeof out === 'string') assert.fail(`unexpected error: ${out}`);
	assert.equal(out.notes.length, 6);
});

// ---------------------------------------------------------------------------
// End-to-end via FakeProvider
// ---------------------------------------------------------------------------

test('reviewDataClaimsGrounding: low claim -> verdict redraft + note', async () => {
	const responseJson = JSON.stringify({
		claims: [
			{ text: 'orders has 12 columns',           evidenceMatch: 'high' },
			{ text: 'orders is partitioned monthly',   evidenceMatch: 'low'  },
		],
		notes: [],
	});
	const { provider } = fakeProvider([responseJson]);
	const out = await reviewDataClaimsGrounding(
		{ task: fixtureTask, prose: 'whatever', evidence: fixtureEvidence },
		provider,
	);
	assert.equal(out.verdict, 'redraft');
	assert.ok(out.notes.some(n => /flagged 1 claim/.test(n)));
	assert.ok(out.notes.some(n => /partitioned monthly/.test(n)));
});

test('reviewDataClaimsGrounding: all high/medium claims -> verdict accept', async () => {
	const responseJson = JSON.stringify({
		claims: [
			{ text: 'orders has 12 columns', evidenceMatch: 'high' },
			{ text: 'amount is numeric',     evidenceMatch: 'medium' },
		],
		notes: [],
	});
	const { provider } = fakeProvider([responseJson]);
	const out = await reviewDataClaimsGrounding(
		{ task: fixtureTask, prose: 'whatever', evidence: fixtureEvidence },
		provider,
	);
	assert.equal(out.verdict, 'accept');
});

test('reviewDataClaimsGrounding: provider error -> soft-accept', async () => {
	const provider = throwingProvider();
	const out = await reviewDataClaimsGrounding(
		{ task: fixtureTask, prose: 'whatever', evidence: fixtureEvidence },
		provider,
	);
	assert.equal(out.verdict, 'accept');
	assert.ok(out.notes.some(n => /soft-accepted/.test(n)));
	assert.equal(out.claims.length, 0);
});

test('reviewDataClaimsGrounding: schema violation on every attempt -> soft-accept', async () => {
	const { provider } = fakeProvider([
		'not valid json at all',
		'still not valid',
	]);
	const out = await reviewDataClaimsGrounding(
		{ task: fixtureTask, prose: 'whatever', evidence: fixtureEvidence },
		provider,
	);
	assert.equal(out.verdict, 'accept');
	assert.ok(out.notes.some(n => /soft-accepted/.test(n)));
});

test('reviewDataClaimsGrounding: multiple low claims surface in notes (max 4)', async () => {
	const responseJson = JSON.stringify({
		claims: [
			{ text: 'claim 1', evidenceMatch: 'low' },
			{ text: 'claim 2', evidenceMatch: 'low' },
			{ text: 'claim 3', evidenceMatch: 'low' },
			{ text: 'claim 4', evidenceMatch: 'low' },
			{ text: 'claim 5', evidenceMatch: 'low' },
			{ text: 'claim 6', evidenceMatch: 'low' },
		],
		notes: [],
	});
	const { provider } = fakeProvider([responseJson]);
	const out = await reviewDataClaimsGrounding(
		{ task: fixtureTask, prose: 'whatever', evidence: fixtureEvidence },
		provider,
	);
	assert.equal(out.verdict, 'redraft');
	assert.ok(out.notes.some(n => /\.\.\.and 2 more/.test(n)),
		`expected "...and 2 more" overflow note; got notes:\n${out.notes.join('\n')}`);
});
