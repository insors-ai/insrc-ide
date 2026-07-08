/**
 * plans/exploration-based-context-build.md Phase 1. Unit tests for
 * concept.resolve's tokenisation + scoring internals. These tests
 * do NOT require an LMDB fixture -- they exercise the pure helper
 * functions directly.
 *
 * The critical assertion is Test 3 from the live-test session:
 * "payable extraction module" should score `insors/extraction/payable/`
 * higher than `insors/core/model/invoice/payable.py`. That's the
 * bug F8 fix.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	_scoreCandidateForTest,
	_splitIdentifierForTest,
	_tokeniseForTest,
} from '../concept-resolve.js';

// ---------------------------------------------------------------------------
// tokenise
// ---------------------------------------------------------------------------

test('tokenise drops stopwords + short tokens', () => {
	assert.deepEqual(_tokeniseForTest('what is the classifier module'), ['classifier', 'module']);
});

test('tokenise lowercases + splits on non-alphanumeric', () => {
	assert.deepEqual(_tokeniseForTest('Map the Payable-Extraction Module'), ['map', 'payable', 'extraction', 'module']);
});

test('tokenise handles snake_case + dot-separated', () => {
	assert.deepEqual(
		_tokeniseForTest('extract insors.extraction.payable module'),
		['extract', 'insors', 'extraction', 'payable', 'module'],
	);
});

test('tokenise drops framework-generic jargon', () => {
	// 'framework' + 'system' are dropped as framework jargon
	assert.deepEqual(_tokeniseForTest('the payable framework system'), ['payable']);
});

// ---------------------------------------------------------------------------
// splitIdentifier
// ---------------------------------------------------------------------------

test('splitIdentifier handles snake_case', () => {
	assert.deepEqual(_splitIdentifierForTest('payable_extraction_module'), ['payable', 'extraction', 'module']);
});

test('splitIdentifier handles camelCase', () => {
	assert.deepEqual(_splitIdentifierForTest('PayableExtractionModule'), ['payable', 'extraction', 'module']);
});

test('splitIdentifier handles kebab-case', () => {
	assert.deepEqual(_splitIdentifierForTest('payable-extraction-module'), ['payable', 'extraction', 'module']);
});

test('splitIdentifier splits letter/digit boundary + drops single-char tokens', () => {
	// The implementation forces a letter/digit split THEN drops any
	// token with length < 2. 'v', '2' individually don't survive.
	assert.deepEqual(_splitIdentifierForTest('v2Endpoint'), ['endpoint']);
	// httpV2Router -> http, V, 2, Router -> http, router (single-char dropped)
	assert.deepEqual(_splitIdentifierForTest('httpV2Router'), ['http', 'router']);
});

test('splitIdentifier handles filename with extension', () => {
	assert.deepEqual(_splitIdentifierForTest('payable_matching_rules.py'), ['payable', 'matching', 'rules', 'py']);
});

// ---------------------------------------------------------------------------
// scoreCandidate -- the load-bearing bit for Test 3 fix
// ---------------------------------------------------------------------------

const REPO = '/repo/insors-extraction';

test('directory match beats file match on same token count (Test 3 case)', () => {
	const tokens = _tokeniseForTest('payable extraction module');
	// The core failure mode from live Test 3: LLM went to
	// insors/core/model/invoice/payable.py (1 path token match)
	// instead of insors/extraction/payable/ (2 path token match).
	const dirHit = _scoreCandidateForTest(
		{ kind: 'dir', path: `${REPO}/insors/extraction/payable`, name: 'payable' },
		tokens, REPO, /* structuralBoost */ true,
	);
	const fileHit = _scoreCandidateForTest(
		{ kind: 'file', path: `${REPO}/insors/core/model/invoice/payable.py`, name: 'payable.py' },
		tokens, REPO, true,
	);
	assert.ok(dirHit !== null && fileHit !== null);
	assert.ok(
		dirHit.score > fileHit.score,
		`dir score ${dirHit.score} should beat file score ${fileHit.score}`,
	);
});

test('shallower path scores higher when token match is equal', () => {
	const tokens = _tokeniseForTest('payable module');
	const shallow = _scoreCandidateForTest(
		{ kind: 'dir', path: `${REPO}/payable`, name: 'payable' },
		tokens, REPO, true,
	);
	const deep = _scoreCandidateForTest(
		{ kind: 'dir', path: `${REPO}/a/b/c/d/e/payable`, name: 'payable' },
		tokens, REPO, true,
	);
	assert.ok(shallow !== null && deep !== null);
	assert.ok(shallow.score > deep.score);
});

test('zero token hits returns null (dropped)', () => {
	const tokens = _tokeniseForTest('quantum encryption module');
	const noHit = _scoreCandidateForTest(
		{ kind: 'dir', path: `${REPO}/insors/extraction/payable`, name: 'payable' },
		tokens, REPO, true,
	);
	assert.equal(noHit, null);
});

test('structural boost lifts dir scores over the same non-boosted case', () => {
	// Same tokens, same candidate. Only the boost flag changes.
	const tokens = _tokeniseForTest('payable module');
	const dirCand = { kind: 'dir' as const, path: `${REPO}/insors/payable`, name: 'payable' };
	const withBoost    = _scoreCandidateForTest(dirCand, tokens, REPO, /* structural */ true);
	const withoutBoost = _scoreCandidateForTest(dirCand, tokens, REPO, /* structural */ false);
	assert.ok(withBoost !== null && withoutBoost !== null);
	assert.ok(withBoost.score > withoutBoost.score,
		`with boost ${withBoost.score} should beat without boost ${withoutBoost.score}`);
});

test('score is bounded to [0, 1]', () => {
	const tokens = _tokeniseForTest('payable payable payable payable');
	const hit = _scoreCandidateForTest(
		{ kind: 'dir', path: `${REPO}/payable`, name: 'payable' },
		tokens, REPO, true,
	);
	assert.ok(hit !== null);
	assert.ok(hit.score >= 0 && hit.score <= 1);
});

test('name-token match contributes to score', () => {
	const tokens = _tokeniseForTest('validator');
	const pathOnlyMatch = _scoreCandidateForTest(
		{ kind: 'file', path: `${REPO}/pkg/validator.py`, name: 'other.py' },
		tokens, REPO, false,
	);
	const nameOnlyMatch = _scoreCandidateForTest(
		{ kind: 'file', path: `${REPO}/pkg/other.py`, name: 'validator.py' },
		tokens, REPO, false,
	);
	assert.ok(pathOnlyMatch !== null && nameOnlyMatch !== null);
	// Both should score above 0; both should be non-null.
	assert.ok(pathOnlyMatch.score > 0);
	assert.ok(nameOnlyMatch.score > 0);
});
