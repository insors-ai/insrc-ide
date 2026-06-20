/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the summarize-step caller -- parser, structural validation,
 * callId -> artifactId substitution, and gap-id leniency.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	_parseForTest             as parse,
	_substituteCallIdsForTest as substituteCallIds,
} from '../step-summarize-step.js';

const VALID_CALL_IDS = new Set(['s1.a', 's1.b']);
const VALID_GAP_IDS  = new Set(['ingrn-fields', 'json-shape']);

// ---------------------------------------------------------------------------
// parse() happy paths
// ---------------------------------------------------------------------------

test('parse: minimal valid response -> ok', () => {
	const r = parse({
		summaries: [{
			callId:      's1.a',
			summary:     'class INGRN extracted',
			claims:      [],
			gapClosures: [],
		}],
	}, VALID_CALL_IDS, VALID_GAP_IDS);
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.value.length, 1);
		assert.equal(r.value[0]!.callId, 's1.a');
	}
});

test('parse: claims + gapClosures preserved', () => {
	const r = parse({
		summaries: [{
			callId:  's1.a',
			summary: 'class INGRN extracted',
			claims: [{
				claim:     'has vendor field',
				evidence:  'cited',
				citations: [{ callId: 's1.a', span: 'vendor: Optional[INPartyDetails]' }],
			}],
			gapClosures: [{
				gapId:     'ingrn-fields',
				verdict:   'closes',
				claim:     'fields are listed',
				evidence:  'cited',
				citations: [{ callId: 's1.a', span: 'vendor: Optional[INPartyDetails]' }],
			}],
		}],
	}, VALID_CALL_IDS, VALID_GAP_IDS);
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.value[0]!.claims.length, 1);
		assert.equal(r.value[0]!.gapClosures.length, 1);
		assert.equal(r.value[0]!.gapClosures[0]!.verdict, 'closes');
	}
});

test('parse: countAssertion preserved when present', () => {
	const r = parse({
		summaries: [{
			callId:  's1.a',
			summary: 'class INGRN has 2 fields',
			claims: [{
				claim:           'INGRN has 2 fields',
				evidence:        'cited',
				countAssertion:  2,
				citations: [
					{ callId: 's1.a', span: 'vendor:' },
					{ callId: 's1.a', span: 'buyer:' },
				],
			}],
			gapClosures: [],
		}],
	}, VALID_CALL_IDS, VALID_GAP_IDS);
	assert.equal(r.ok, true);
	if (r.ok) { assert.equal(r.value[0]!.claims[0]!.countAssertion, 2); }
});

// ---------------------------------------------------------------------------
// parse() structural rejections
// ---------------------------------------------------------------------------

test('parse: non-object -> rejected', () => {
	const r = parse('not json', VALID_CALL_IDS, VALID_GAP_IDS);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /JSON object/); }
});

test('parse: top-level array -> rejected', () => {
	const r = parse([], VALID_CALL_IDS, VALID_GAP_IDS);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /JSON object/); }
});

test('parse: missing summaries field -> rejected', () => {
	const r = parse({}, VALID_CALL_IDS, VALID_GAP_IDS);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /summaries.*array/); }
});

test('parse: callId not in valid set -> rejected', () => {
	const r = parse({
		summaries: [{ callId: 's9.z', summary: 'x', claims: [], gapClosures: [] }],
	}, VALID_CALL_IDS, VALID_GAP_IDS);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /not one of the declared callIds/); }
});

test('parse: claim with bad evidence type -> rejected', () => {
	const r = parse({
		summaries: [{
			callId: 's1.a', summary: 'x',
			claims: [{ claim: 'x', evidence: 'guess', citations: [] }],
			gapClosures: [],
		}],
	}, VALID_CALL_IDS, VALID_GAP_IDS);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /evidence must be/); }
});

test('parse: citation callId not in valid set -> rejected', () => {
	const r = parse({
		summaries: [{
			callId: 's1.a', summary: 'x',
			claims: [{
				claim: 'x', evidence: 'cited',
				citations: [{ callId: 's9.z', span: 'something' }],
			}],
			gapClosures: [],
		}],
	}, VALID_CALL_IDS, VALID_GAP_IDS);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /not one of the declared callIds/); }
});

test('parse: countAssertion non-integer -> rejected', () => {
	const r = parse({
		summaries: [{
			callId: 's1.a', summary: 'x',
			claims: [{
				claim: 'x', evidence: 'cited', countAssertion: 3.5,
				citations: [{ callId: 's1.a', span: 'x' }],
			}],
			gapClosures: [],
		}],
	}, VALID_CALL_IDS, VALID_GAP_IDS);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /non-negative integer/); }
});

// ---------------------------------------------------------------------------
// Gap-id leniency (unknown gap-id silently dropped)
// ---------------------------------------------------------------------------

test('parse: unknown gapId -> closure silently dropped, summary still parses', () => {
	const r = parse({
		summaries: [{
			callId: 's1.a', summary: 'x',
			claims: [],
			gapClosures: [{
				gapId:     'invented-gap',
				verdict:   'closes',
				claim:     'x',
				evidence:  'cited',
				citations: [{ callId: 's1.a', span: 'x' }],
			}],
		}],
	}, VALID_CALL_IDS, VALID_GAP_IDS);
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.value[0]!.gapClosures.length, 0, 'invented gap-id should be dropped');
	}
});

test('parse: gap closure with bad verdict -> rejected', () => {
	const r = parse({
		summaries: [{
			callId: 's1.a', summary: 'x', claims: [],
			gapClosures: [{
				gapId: 'ingrn-fields', verdict: 'maybe',
				claim: 'x', evidence: 'cited',
				citations: [{ callId: 's1.a', span: 'x' }],
			}],
		}],
	}, VALID_CALL_IDS, VALID_GAP_IDS);
	assert.equal(r.ok, false);
	if (!r.ok) { assert.match(r.reason, /closes.*partially.*off-topic/); }
});

// ---------------------------------------------------------------------------
// callId -> artifactId substitution
// ---------------------------------------------------------------------------

test('substituteCallIds: maps citation callIds to artifactIds', () => {
	const parsed = [{
		callId:  's1.a',
		summary: 'x',
		claims: [{
			claim:     'x',
			evidence:  'cited' as const,
			citations: [
				{ callId: 's1.a', span: 'span-1' },
				{ callId: 's1.b', span: 'span-2' },
			],
		}],
		gapClosures: [],
	}];
	const map = new Map([
		['s1.a', 'art:1:locate'],
		['s1.b', 'art:2:summary'],
	]);
	const out = substituteCallIds(parsed, map);
	assert.equal(out.length, 1);
	assert.equal(out[0]!.artifactId, 'art:1:locate');
	assert.equal(out[0]!.claims[0]!.citations[0]!.artifactId, 'art:1:locate');
	assert.equal(out[0]!.claims[0]!.citations[1]!.artifactId, 'art:2:summary');
});

