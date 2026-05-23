/**
 * Phase 10.B tests for plans/code-analyzer-hallucination-mitigation.md.
 *
 * Cover the candidate-extraction NER. The probe itself depends on
 * the live LMDB graph, so it's covered in an integration test
 * elsewhere -- here we test the pure-helper that decides what to
 * probe. Bad candidates = bad probe outcomes downstream.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _extractCandidateNamesForTest as extract } from '../verify-planned-actions.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('extractCandidateNames: pulls PascalCase identifiers from title', () => {
	const c = extract('NameNode Server: FSImage & Checkpoint Persistence', '');
	assert.ok(c.includes('FSImage'), `expected FSImage in ${JSON.stringify(c)}`);
	assert.ok(!c.includes('Server'), `excluded word leaked: ${JSON.stringify(c)}`);
	assert.ok(!c.includes('Persistence'), `excluded word leaked: ${JSON.stringify(c)}`);
});

test('extractCandidateNames: pulls multi-token compounds from objective', () => {
	const c = extract(
		'Block Management & DataNode Coordination',
		'Trace how `BlockManager` and `BlockPlacementPolicyDefault` coordinate with `DatanodeManager`.',
	);
	assert.ok(c.includes('BlockManager'));
	assert.ok(c.includes('BlockPlacementPolicyDefault'));
	assert.ok(c.includes('DatanodeManager'));
});

test('extractCandidateNames: pulls Java file basenames', () => {
	const c = extract('Lease Tracking Internals', 'Reviewing `LeaseManager.java` and `Lease.java`.');
	assert.ok(c.includes('LeaseManager'));
	assert.ok(c.includes('Lease'));
});

test('extractCandidateNames: sorts by length descending (anchor longest)', () => {
	const c = extract('Block Placement', 'Trace `BlockPlacementPolicyDefault` from `Block`.');
	assert.equal(c[0], 'BlockPlacementPolicyDefault', `expected longest first, got ${JSON.stringify(c)}`);
});

test('extractCandidateNames: returns empty for loose generic titles', () => {
	const c = extract('Operational Observability', 'Discuss metrics and monitoring approaches.');
	// "Operational" and "Observability" are not PascalCase compounds
	// (they're single capitalized words). The objective has no
	// concrete anchors. Empty list -> verify-planned-actions skips
	// the probe and keeps the action.
	assert.equal(c.length, 0, `expected empty for loose title, got ${JSON.stringify(c)}`);
});

test('extractCandidateNames: dedupes repeated mentions', () => {
	const c = extract(
		'`BlockManager` review',
		'`BlockManager` does X. `BlockManager` does Y. Compare with `BlockInfo`.',
	);
	// BlockManager appears 3 times but should be deduped
	assert.equal(c.filter(x => x === 'BlockManager').length, 1);
	assert.ok(c.includes('BlockInfo'));
});

test('extractCandidateNames: excludes pure single-cap English words', () => {
	const c = extract('Server Architecture & Pipeline Management', '');
	assert.equal(c.length, 0, `expected no candidates for all-axis-label title, got ${JSON.stringify(c)}`);
});

test('extractCandidateNames: handles dotted Java identifiers (last segment)', () => {
	const c = extract(
		'HDFS RPC',
		'Look at `org.apache.hadoop.hdfs.protocol.ClientProtocol` and its handlers.',
	);
	// PascalCase regex picks up "ClientProtocol" from inside the dotted path
	assert.ok(c.includes('ClientProtocol'));
});
