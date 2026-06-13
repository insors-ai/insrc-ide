/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the citation verifier -- pins the deterministic
 * substring + count + confirmed-null checks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyCitedSummary, type ArtifactRawTextLookup } from '../audit/citation-verifier.js';
import type { CitedStepSummary } from '../citation-types.js';

function lookup(artifacts: Record<string, string>): ArtifactRawTextLookup {
	return async (id) => artifacts[id];
}

const STEP_INTENT = 'extract INGRN fields';

function summary(callId: string, claims: CitedStepSummary['claims'], gapClosures: CitedStepSummary['gapClosures'] = []): CitedStepSummary {
	return {
		callId, skillId: 'code.class.extract-fields',
		artifactId: `art-${callId}`,
		summary: STEP_INTENT, claims, gapClosures,
	};
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

test('verifyCitedSummary: empty summary -> ok', async () => {
	const r = await verifyCitedSummary(summary('s1.a', [], []), lookup({}));
	assert.equal(r.ok, true);
	assert.equal(r.badClaims.length, 0);
});

test('verifyCitedSummary: cited claim with matching substring -> ok', async () => {
	const r = await verifyCitedSummary(
		summary('s1.a', [
			{ claim: 'INGRN has field vendor', evidence: 'cited',
			  citations: [{ artifactId: 'art-s1.a', span: 'vendor: Optional[INPartyDetails]' }] },
		]),
		lookup({ 'art-s1.a': 'class INGRN:\n  vendor: Optional[INPartyDetails]\n  buyer: Optional[INPartyDetails]\n' }),
	);
	assert.equal(r.ok, true);
});

test('verifyCitedSummary: multiple citations all matching -> ok', async () => {
	const r = await verifyCitedSummary(
		summary('s1.a', [
			{ claim: 'INGRN has vendor + buyer', evidence: 'cited',
			  citations: [
			    { artifactId: 'art-s1.a', span: 'vendor: Optional[INPartyDetails]' },
			    { artifactId: 'art-s1.a', span: 'buyer: Optional[INPartyDetails]' },
			  ] },
		]),
		lookup({ 'art-s1.a': 'class INGRN:\n  vendor: Optional[INPartyDetails]\n  buyer: Optional[INPartyDetails]\n' }),
	);
	assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// Substring mismatch
// ---------------------------------------------------------------------------

test('verifyCitedSummary: span not in artifact -> bad claim', async () => {
	const r = await verifyCitedSummary(
		summary('s1.a', [
			{ claim: 'INGRN has field invented', evidence: 'cited',
			  citations: [{ artifactId: 'art-s1.a', span: 'invented_field: str' }] },
		]),
		lookup({ 'art-s1.a': 'class INGRN:\n  vendor: Optional[INPartyDetails]\n' }),
	);
	assert.equal(r.ok, false);
	assert.equal(r.badClaims.length, 1);
	assert.match(r.badClaims[0]!.reason, /span not found/);
});

test('verifyCitedSummary: missing artifact -> bad claim', async () => {
	const r = await verifyCitedSummary(
		summary('s1.a', [
			{ claim: 'cite missing artifact', evidence: 'cited',
			  citations: [{ artifactId: 'art-nope', span: 'whatever' }] },
		]),
		lookup({ 'art-s1.a': 'something' }),
	);
	assert.equal(r.ok, false);
	assert.match(r.badClaims[0]!.reason, /not found/);
});

test('verifyCitedSummary: cited claim with empty citations array -> bad', async () => {
	const r = await verifyCitedSummary(
		summary('s1.a', [{ claim: 'no citation', evidence: 'cited', citations: [] }]),
		lookup({ 'art-s1.a': 'x' }),
	);
	assert.equal(r.ok, false);
	assert.match(r.badClaims[0]!.reason, /at least one citation/);
});

test('verifyCitedSummary: empty span -> bad', async () => {
	const r = await verifyCitedSummary(
		summary('s1.a', [
			{ claim: 'empty span', evidence: 'cited',
			  citations: [{ artifactId: 'art-s1.a', span: '' }] },
		]),
		lookup({ 'art-s1.a': 'whatever' }),
	);
	assert.equal(r.ok, false);
	assert.match(r.badClaims[0]!.reason, /empty/);
});

// ---------------------------------------------------------------------------
// confirmed-null
// ---------------------------------------------------------------------------

test('verifyCitedSummary: confirmed-null on empty artifact -> ok', async () => {
	const r = await verifyCitedSummary(
		summary('s1.a', [
			{ claim: 'directory is empty', evidence: 'confirmed-null',
			  citations: [{ artifactId: 'art-empty', span: '' }] },
		]),
		lookup({ 'art-empty': '' }),
	);
	assert.equal(r.ok, true);
});

test('verifyCitedSummary: confirmed-null on non-empty artifact -> bad', async () => {
	const r = await verifyCitedSummary(
		summary('s1.a', [
			{ claim: 'pretending empty', evidence: 'confirmed-null',
			  citations: [{ artifactId: 'art-full', span: '' }] },
		]),
		lookup({ 'art-full': 'not empty' }),
	);
	assert.equal(r.ok, false);
	assert.match(r.badClaims[0]!.reason, /non-empty/);
});

test('verifyCitedSummary: confirmed-null with multiple citations -> bad', async () => {
	const r = await verifyCitedSummary(
		summary('s1.a', [
			{ claim: 'wrong', evidence: 'confirmed-null',
			  citations: [
			    { artifactId: 'art-a', span: '' },
			    { artifactId: 'art-b', span: '' },
			  ] },
		]),
		lookup({ 'art-a': '', 'art-b': '' }),
	);
	assert.equal(r.ok, false);
	assert.match(r.badClaims[0]!.reason, /exactly 1 citation/);
});

// ---------------------------------------------------------------------------
// countAssertion
// ---------------------------------------------------------------------------

test('verifyCitedSummary: countAssertion matches citations.length -> ok', async () => {
	const r = await verifyCitedSummary(
		summary('s1.a', [
			{ claim: 'has 3 fields', evidence: 'cited', countAssertion: 3,
			  citations: [
			    { artifactId: 'art-s1.a', span: 'vendor:' },
			    { artifactId: 'art-s1.a', span: 'buyer:' },
			    { artifactId: 'art-s1.a', span: 'items:' },
			  ] },
		]),
		lookup({ 'art-s1.a': 'vendor: x\nbuyer: x\nitems: x\n' }),
	);
	assert.equal(r.ok, true);
});

test('verifyCitedSummary: countAssertion mismatch -> bad', async () => {
	const r = await verifyCitedSummary(
		summary('s1.a', [
			{ claim: 'has 27 fields', evidence: 'cited', countAssertion: 27,
			  citations: [
			    { artifactId: 'art-s1.a', span: 'vendor:' },
			    { artifactId: 'art-s1.a', span: 'buyer:' },
			  ] },
		]),
		lookup({ 'art-s1.a': 'vendor: x\nbuyer: x\n' }),
	);
	assert.equal(r.ok, false);
	assert.match(r.badClaims[0]!.reason, /asserts 27 but citations list has 2/);
});

// ---------------------------------------------------------------------------
// Gap closures
// ---------------------------------------------------------------------------

test('verifyCitedSummary: gap closure with matching span + valid verdict -> ok', async () => {
	const r = await verifyCitedSummary(
		summary('s1.a', [], [
			{ claim: 'closed by extract-fields', evidence: 'cited', gapId: 'ingrn-fields', verdict: 'closes',
			  citations: [{ artifactId: 'art-s1.a', span: 'vendor: Optional[INPartyDetails]' }] },
		]),
		lookup({ 'art-s1.a': 'class INGRN:\n  vendor: Optional[INPartyDetails]\n' }),
	);
	assert.equal(r.ok, true);
});

test('verifyCitedSummary: gap closure with bad verdict -> bad', async () => {
	const r = await verifyCitedSummary(
		summary('s1.a', [], [
			{ claim: 'x', evidence: 'cited', gapId: 'ingrn-fields',
			  // @ts-expect-error -- intentionally invalid verdict
			  verdict: 'maybe',
			  citations: [{ artifactId: 'art-s1.a', span: 'vendor:' }] },
		]),
		lookup({ 'art-s1.a': 'vendor: x' }),
	);
	assert.equal(r.ok, false);
	assert.match(r.badClaims[0]!.reason, /invalid verdict/);
});

test('verifyCitedSummary: gap closure with empty gapId -> bad', async () => {
	const r = await verifyCitedSummary(
		summary('s1.a', [], [
			{ claim: 'x', evidence: 'cited', gapId: '', verdict: 'closes',
			  citations: [{ artifactId: 'art-s1.a', span: 'vendor:' }] },
		]),
		lookup({ 'art-s1.a': 'vendor: x' }),
	);
	assert.equal(r.ok, false);
	assert.match(r.badClaims[0]!.reason, /empty gapId/);
});

// ---------------------------------------------------------------------------
// Mixed pass / fail
// ---------------------------------------------------------------------------

test('verifyCitedSummary: one good + one bad -> bad list has 1 entry, ok=false', async () => {
	const r = await verifyCitedSummary(
		summary('s1.a', [
			{ claim: 'good', evidence: 'cited',
			  citations: [{ artifactId: 'art-s1.a', span: 'vendor:' }] },
			{ claim: 'bad', evidence: 'cited',
			  citations: [{ artifactId: 'art-s1.a', span: 'not-there' }] },
		]),
		lookup({ 'art-s1.a': 'vendor: x' }),
	);
	assert.equal(r.ok, false);
	assert.equal(r.badClaims.length, 1);
	assert.equal(r.badClaims[0]!.claimText, 'bad');
});
