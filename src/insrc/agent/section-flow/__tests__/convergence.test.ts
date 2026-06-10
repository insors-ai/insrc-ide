/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the convergence signals -- Phase 4 batch 4.2 of
 * plans/section-flow-architecture-redesign.md.
 *
 * The dynamic loop's three termination signals all live here:
 *
 *   - closure-marker scan (per-summary regex)
 *   - coverage check (allClosed when every gap has a CLOSES marker)
 *   - no-progress accounting (contributed evidence iff CLOSES or PARTIALLY)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	scanClosureMarkers,
	scanAllClosureMarkers,
	computeCoverage,
	stepContributedEvidence,
	type ClosureClaim,
} from '../convergence.js';

const GAPS = new Set(['ingrn-fields', 'json-shape']);

// ---------------------------------------------------------------------------
// scanClosureMarkers
// ---------------------------------------------------------------------------

test('scanClosureMarkers: CLOSES marker -> closes-fully verdict', () => {
	const claims = scanClosureMarkers(
		'INGRN has 21 fields. CLOSES ingrn-fields fully',
		'step-1', 's1.a', GAPS,
	);
	assert.equal(claims.length, 1);
	assert.deepEqual(claims[0], { stepId: 'step-1', callId: 's1.a', gapId: 'ingrn-fields', verdict: 'closes-fully' });
});

test('scanClosureMarkers: PARTIALLY marker -> partial verdict', () => {
	const claims = scanClosureMarkers(
		'sampled one row. PARTIALLY supports json-shape',
		'step-2', 's2.a', GAPS,
	);
	assert.equal(claims.length, 1);
	assert.deepEqual(claims[0], { stepId: 'step-2', callId: 's2.a', gapId: 'json-shape', verdict: 'partial' });
});

test('scanClosureMarkers: OFF-TOPIC marker -> off-topic verdict with gapId null', () => {
	const claims = scanClosureMarkers(
		'returned empty. OFF-TOPIC',
		'step-1', 's1.b', GAPS,
	);
	assert.equal(claims.length, 1);
	assert.deepEqual(claims[0], { stepId: 'step-1', callId: 's1.b', gapId: null, verdict: 'off-topic' });
});

test('scanClosureMarkers: chained markers in one summary -> multiple claims', () => {
	const claims = scanClosureMarkers(
		'INGRN imports GRNItem. PARTIALLY supports ingrn-fields; PARTIALLY supports json-shape',
		'step-1', 's1.a', GAPS,
	);
	assert.equal(claims.length, 2);
	const gapIds = claims.map(c => c.gapId).sort();
	assert.deepEqual(gapIds, ['ingrn-fields', 'json-shape']);
});

test('scanClosureMarkers: unknown gap-id dropped silently', () => {
	const claims = scanClosureMarkers(
		'CLOSES not-a-real-gap fully',
		'step-1', 's1.a', GAPS,
	);
	assert.equal(claims.length, 0);
});

test('scanClosureMarkers: case-insensitive on keyword', () => {
	const claims = scanClosureMarkers(
		'observed. closes ingrn-fields fully',
		'step-1', 's1.a', GAPS,
	);
	assert.equal(claims.length, 1);
	assert.equal(claims[0]!.verdict, 'closes-fully');
});

test('scanClosureMarkers: no marker at all -> empty list', () => {
	const claims = scanClosureMarkers(
		'a sentence with no marker keyword',
		'step-1', 's1.a', GAPS,
	);
	assert.equal(claims.length, 0);
});

// ---------------------------------------------------------------------------
// scanAllClosureMarkers
// ---------------------------------------------------------------------------

test('scanAllClosureMarkers: walks the nested map and flattens', () => {
	const summaries = {
		'step-1': { 's1.a': 'CLOSES ingrn-fields fully' },
		'step-2': { 's2.a': 'PARTIALLY supports json-shape' },
	};
	const claims = scanAllClosureMarkers(summaries, GAPS);
	assert.equal(claims.length, 2);
	const ids = claims.map(c => `${c.stepId}/${c.gapId}`).sort();
	assert.deepEqual(ids, ['step-1/ingrn-fields', 'step-2/json-shape']);
});

// ---------------------------------------------------------------------------
// computeCoverage
// ---------------------------------------------------------------------------

test('computeCoverage: every gap CLOSES -> allClosed=true', () => {
	const claims: ClosureClaim[] = [
		{ stepId: 'step-1', callId: 's1.a', gapId: 'ingrn-fields', verdict: 'closes-fully' },
		{ stepId: 'step-2', callId: 's2.a', gapId: 'json-shape',   verdict: 'closes-fully' },
	];
	const r = computeCoverage(['ingrn-fields', 'json-shape'], claims);
	assert.equal(r.allClosed, true);
	for (const g of r.perGap) { assert.equal(g.status, 'covered'); }
});

test('computeCoverage: mixed closes/partial/empty -> per-gap status correct', () => {
	const claims: ClosureClaim[] = [
		{ stepId: 'step-1', callId: 's1.a', gapId: 'ingrn-fields', verdict: 'closes-fully' },
		{ stepId: 'step-2', callId: 's2.a', gapId: 'json-shape',   verdict: 'partial' },
	];
	const r = computeCoverage(['ingrn-fields', 'json-shape', 'third-gap'], claims);
	assert.equal(r.allClosed, false);
	const byGap = new Map(r.perGap.map(g => [g.gapId, g.status]));
	assert.equal(byGap.get('ingrn-fields'), 'covered');
	assert.equal(byGap.get('json-shape'),   'partial');
	assert.equal(byGap.get('third-gap'),    'open');
});

test('computeCoverage: off-topic claims do NOT cover any gap', () => {
	const claims: ClosureClaim[] = [
		{ stepId: 'step-1', callId: 's1.a', gapId: null, verdict: 'off-topic' },
	];
	const r = computeCoverage(['ingrn-fields'], claims);
	assert.equal(r.allClosed, false);
	assert.equal(r.perGap[0]!.status, 'open');
});

// ---------------------------------------------------------------------------
// stepContributedEvidence
// ---------------------------------------------------------------------------

test('stepContributedEvidence: any CLOSES or PARTIALLY counts', () => {
	assert.equal(stepContributedEvidence([
		{ stepId: 's', callId: 'a', gapId: 'x', verdict: 'closes-fully' },
	]), true);
	assert.equal(stepContributedEvidence([
		{ stepId: 's', callId: 'a', gapId: 'x', verdict: 'partial' },
	]), true);
});

test('stepContributedEvidence: OFF-TOPIC or empty does NOT count', () => {
	assert.equal(stepContributedEvidence([
		{ stepId: 's', callId: 'a', gapId: null, verdict: 'off-topic' },
	]), false);
	assert.equal(stepContributedEvidence([]), false);
});
