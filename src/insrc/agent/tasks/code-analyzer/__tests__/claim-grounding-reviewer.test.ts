/**
 * Phase 11.B tests for plans/code-analyzer-hallucination-mitigation.md.
 *
 * Covers:
 *   - Validator accepts well-shaped responses.
 *   - Validator rejects malformed scores / shapes.
 *   - The cloud-call path (reviewClaimsGrounding) with a fake
 *     provider that returns shaped JSON: verifies the 'low' ->
 *     redraft escalation and that notes are prepended.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	reviewClaimsGrounding,
	_validateClaimGroundingForTest as validate,
	_buildClaimGroundingMessagesForTest as buildMessages,
} from '../claim-grounding-reviewer.js';
import type { LLMProvider, LLMResponse, LLMMessage, CompletionOpts } from '../../../../shared/types.js';
import type { PlannedAction } from '../../../content-gen/plan-actions.js';
import type { EvidenceEntry } from '../summarize-result.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

function fakeProviderReturning(text: string): LLMProvider {
	return {
		async complete(_messages: LLMMessage[], _opts?: CompletionOpts): Promise<LLMResponse> {
			return { text, usage: { inputTokens: 100, outputTokens: 100 } };
		},
		async embed(): Promise<number[][]> { return []; },
	} as unknown as LLMProvider;
}

const SAMPLE_SECTION: PlannedAction = {
	id: 'sec-1',
	title: 'BlockManager Internals',
	objective: 'Review BlockManager state machine and replication queues.',
	maxBudgetTokens: 1500,
	reviewCriteria: ['Names the central class', 'Cites line spans'],
};

const SAMPLE_EVIDENCE: readonly EvidenceEntry[] = [
	{
		id:           'e1',
		skillId:      'code.entity.summary',
		args:         {},
		facts:        ['BlockManager is a class in BlockManager.java spanning lines 162-5558.'],
		citations:    [],
		citationObjs: [],
		confidence:   'high',
	},
];

// ---------------------------------------------------------------------------
// Validator tests
// ---------------------------------------------------------------------------

test('validateClaimGrounding: accepts well-shaped response', () => {
	const result = validate({
		claims: [
			{ text: 'BlockManager is a class.', evidenceMatch: 'high' },
			{ text: 'It has 5000 active threads.', evidenceMatch: 'low' },
		],
		notes: ['note 1'],
	});
	assert.notEqual(typeof result, 'string', `expected pass, got: ${result}`);
});

test('validateClaimGrounding: rejects unknown evidenceMatch value', () => {
	const result = validate({
		claims: [{ text: 'Foo', evidenceMatch: 'maybe' }],
		notes: [],
	});
	assert.equal(typeof result, 'string');
	assert.match(result as string, /evidenceMatch invalid/);
});

test('validateClaimGrounding: rejects missing claims array', () => {
	const result = validate({ notes: [] });
	assert.equal(typeof result, 'string');
});

test('validateClaimGrounding: rejects non-object', () => {
	assert.equal(typeof validate(null), 'string');
	assert.equal(typeof validate('not an object'), 'string');
});

// ---------------------------------------------------------------------------
// reviewClaimsGrounding: end-to-end with fake provider
// ---------------------------------------------------------------------------

test('reviewClaimsGrounding: low scores -> redraft verdict + prepended notes', async () => {
	const provider = fakeProviderReturning(JSON.stringify({
		claims: [
			{ text: 'BlockManager is a class in BlockManager.java.', evidenceMatch: 'high' },
			{ text: 'It uses LRU eviction with a 1000-entry bound.',   evidenceMatch: 'low' },
		],
		notes: ['some observation'],
	}));
	const result = await reviewClaimsGrounding({
		section:  SAMPLE_SECTION,
		prose:    'BlockManager is a class. It uses LRU eviction.',
		evidence: SAMPLE_EVIDENCE,
	}, provider);
	assert.equal(result.verdict, 'redraft');
	assert.ok(result.notes.length >= 2);
	// First note should be the "flagged N un-grounded claims" header
	assert.match(result.notes[0]!, /flagged 1 claim\(s\) without sufficient evidence/);
	// Should surface the un-grounded claim text in subsequent notes
	assert.ok(result.notes.some(n => n.includes('LRU eviction')));
});

test('reviewClaimsGrounding: all high/medium scores -> accept', async () => {
	const provider = fakeProviderReturning(JSON.stringify({
		claims: [
			{ text: 'BlockManager spans 162-5558.', evidenceMatch: 'high' },
			{ text: 'It coordinates replication.',   evidenceMatch: 'medium' },
		],
		notes: [],
	}));
	const result = await reviewClaimsGrounding({
		section:  SAMPLE_SECTION,
		prose:    'BlockManager spans lines 162-5558 and coordinates replication.',
		evidence: SAMPLE_EVIDENCE,
	}, provider);
	assert.equal(result.verdict, 'accept');
	assert.equal(result.claims.length, 2);
});

test('reviewClaimsGrounding: provider failure -> soft-accept', async () => {
	const provider = fakeProviderReturning('garbage not json');
	const result = await reviewClaimsGrounding({
		section:  SAMPLE_SECTION,
		prose:    'whatever',
		evidence: SAMPLE_EVIDENCE,
	}, provider);
	assert.equal(result.verdict, 'accept');
	assert.match(result.notes[0]!, /degraded; soft-accepted/);
});

// ---------------------------------------------------------------------------
// Prompt-shape sanity check
// ---------------------------------------------------------------------------

test('buildClaimGroundingMessages: surfaces section title, prose, evidence facts', () => {
	const msgs = buildMessages({
		section: SAMPLE_SECTION,
		prose:   'BlockManager spans 162-5558.',
		evidence: SAMPLE_EVIDENCE,
	});
	assert.equal(msgs.length, 2);
	assert.equal(msgs[0]!.role, 'system');
	assert.equal(msgs[1]!.role, 'user');
	const user = msgs[1]!.content as string;
	assert.match(user, /BlockManager Internals/);
	assert.match(user, /BlockManager spans 162-5558\./);
	// Evidence facts numbered
	assert.match(user, /1\. BlockManager is a class/);
});

test('buildClaimGroundingMessages: empty evidence reports the empty state to the reviewer', () => {
	const msgs = buildMessages({
		section: SAMPLE_SECTION,
		prose:   'foo',
		evidence: [],
	});
	const user = msgs[1]!.content as string;
	assert.match(user, /empty -- any factual claim/);
});
