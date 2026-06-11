/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for citation-render -- the bridge between JSON-encoded
 * CitedStepSummary (in artifact_vec.summary) and the prompt-ready
 * text consumed by section-synth + section-review.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	tryParseCitedSummary,
	renderCitedSummaryForPrompt,
} from '../citation-render.js';
import type { CitedStepSummary } from '../citation-types.js';

// ---------------------------------------------------------------------------
// tryParseCitedSummary
// ---------------------------------------------------------------------------

test('tryParseCitedSummary: legacy plain-text -> undefined', () => {
	assert.equal(tryParseCitedSummary('INGRN has 27 fields. CLOSES ingrn-fields fully'), undefined);
});

test('tryParseCitedSummary: empty -> undefined', () => {
	assert.equal(tryParseCitedSummary(''), undefined);
	assert.equal(tryParseCitedSummary('   '), undefined);
});

test('tryParseCitedSummary: malformed JSON -> undefined', () => {
	assert.equal(tryParseCitedSummary('{not json'), undefined);
});

test('tryParseCitedSummary: JSON object missing required keys -> undefined', () => {
	assert.equal(tryParseCitedSummary(JSON.stringify({ summary: 'x' })), undefined);
	assert.equal(tryParseCitedSummary(JSON.stringify({ callId: 's1.a', summary: 'x' })), undefined);
});

test('tryParseCitedSummary: valid JSON -> CitedStepSummary', () => {
	const cited: CitedStepSummary = {
		callId:     's1.a',
		skillId:    'code.class.extract-fields',
		artifactId: 'art:1:locate',
		summary:    'class INGRN extracted',
		claims:     [],
		gapClosures: [],
	};
	const out = tryParseCitedSummary(JSON.stringify(cited));
	assert.notEqual(out, undefined);
	assert.equal(out?.callId, 's1.a');
	assert.equal(out?.summary, 'class INGRN extracted');
});

// ---------------------------------------------------------------------------
// renderCitedSummaryForPrompt -- structural
// ---------------------------------------------------------------------------

const BARE_SUMMARY: CitedStepSummary = {
	callId:     's1.a',
	skillId:    'code.class.extract-fields',
	artifactId: 'art:1:extract',
	summary:    'extracted INGRN class fields',
	claims:     [],
	gapClosures: [],
};

test('renderCitedSummaryForPrompt: bare summary -> narrative only', () => {
	const out = renderCitedSummaryForPrompt(BARE_SUMMARY);
	assert.equal(out, 'extracted INGRN class fields');
});

test('renderCitedSummaryForPrompt: with claims -> claims block appears', () => {
	const out = renderCitedSummaryForPrompt({
		...BARE_SUMMARY,
		claims: [
			{ claim: 'has vendor field', evidence: 'cited',
			  citations: [{ artifactId: 'art:1:extract', span: 'vendor: Optional[INPartyDetails]' }] },
			{ claim: 'has buyer field', evidence: 'cited',
			  citations: [{ artifactId: 'art:1:extract', span: 'buyer: Optional[INPartyDetails]' }] },
		],
	});
	assert.match(out, /claims:/);
	assert.match(out, /has vendor field \[cited\]/);
	assert.match(out, /"vendor: Optional\[INPartyDetails\]"/);
	assert.match(out, /has buyer field \[cited\]/);
});

test('renderCitedSummaryForPrompt: countAssertion shown in claim tag', () => {
	const out = renderCitedSummaryForPrompt({
		...BARE_SUMMARY,
		claims: [{
			claim: 'has 27 fields', evidence: 'cited', countAssertion: 27,
			citations: Array.from({ length: 27 }, (_, i) => ({ artifactId: 'art:1:extract', span: `field_${i}` })),
		}],
	});
	assert.match(out, /\[cited\] \(count=27\)/);
});

test('renderCitedSummaryForPrompt: confirmed-null evidence renders empty:tag', () => {
	const out = renderCitedSummaryForPrompt({
		...BARE_SUMMARY,
		claims: [{
			claim: 'directory is empty', evidence: 'confirmed-null',
			citations: [{ artifactId: 'sess:12345:shared.fs.list-files', span: '' }],
		}],
	});
	assert.match(out, /\[confirmed-null\]/);
	assert.match(out, /empty:.+shared\.fs\.list-files/);
});

test('renderCitedSummaryForPrompt: gap closures with CLOSES verdict', () => {
	const out = renderCitedSummaryForPrompt({
		...BARE_SUMMARY,
		gapClosures: [{
			gapId: 'ingrn-fields', verdict: 'closes',
			claim: 'all 27 fields located', evidence: 'cited',
			citations: [{ artifactId: 'art:1:extract', span: 'class INGRN' }],
		}],
	});
	assert.match(out, /closures:/);
	assert.match(out, /CLOSES ingrn-fields -- all 27 fields located/);
});

test('renderCitedSummaryForPrompt: PARTIALLY + OFF-TOPIC verdicts render', () => {
	const out = renderCitedSummaryForPrompt({
		...BARE_SUMMARY,
		gapClosures: [
			{ gapId: 'ingrn-fields', verdict: 'partially',
			  claim: 'core fields located, validators missing', evidence: 'cited',
			  citations: [{ artifactId: 'art:1:extract', span: 'vendor:' }] },
			{ gapId: 'json-shape', verdict: 'off-topic',
			  claim: 'extract-fields doesn\'t address JSON shape', evidence: 'cited',
			  citations: [{ artifactId: 'art:1:extract', span: 'class INGRN' }] },
		],
	});
	assert.match(out, /PARTIALLY ingrn-fields/);
	assert.match(out, /OFF-TOPIC json-shape/);
});

test('renderCitedSummaryForPrompt: claim count cap (>6) -> truncated with count note', () => {
	const out = renderCitedSummaryForPrompt({
		...BARE_SUMMARY,
		claims: Array.from({ length: 10 }, (_, i) => ({
			claim: `claim ${i}`, evidence: 'cited' as const,
			citations: [{ artifactId: 'art:1:extract', span: `span_${i}` }],
		})),
	});
	const claimLines = out.split('\n').filter(l => l.includes('[cited]'));
	assert.equal(claimLines.length, 6, 'should render 6 claims');
	assert.match(out, /\+ 4 more cited claims/);
});

test('renderCitedSummaryForPrompt: long span truncated to preview cap', () => {
	const longSpan = 'a'.repeat(500);
	const out = renderCitedSummaryForPrompt({
		...BARE_SUMMARY,
		claims: [{ claim: 'long', evidence: 'cited',
			citations: [{ artifactId: 'art:1:extract', span: longSpan }] }],
	});
	const claimLine = out.split('\n').find(l => l.includes('[cited]'))!;
	assert.ok(claimLine.length < longSpan.length, 'long span must be truncated');
	assert.match(claimLine, /\.\.\."$/);
});
