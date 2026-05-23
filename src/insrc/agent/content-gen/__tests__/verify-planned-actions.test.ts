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

import {
	_extractCandidateNamesForTest as extract,
	verifyPlannedActions,
} from '../verify-planned-actions.js';
import type { PlannedAction } from '../plan-actions.js';
import type { Entity } from '../../../shared/types.js';

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

// ---------------------------------------------------------------------------
// verifyPlannedActions -- Phase 10.B.1 vector-fallback behaviour
// ---------------------------------------------------------------------------

function fakeEntity(name: string): Entity {
	return {
		id:        `id-${name}`,
		repo:      '/repo',
		file:      `/repo/${name}.java`,
		name,
		kind:      'class',
		language:  'java',
		startLine: 1,
		endLine:   100,
		children:  [],
	} as unknown as Entity;
}

const HA_SECTION: PlannedAction = {
	id:                'hdfs-ha',
	title:             'High Availability & State Synchronization',
	objective:         'Trace how NameNodes coordinate active/standby state via HA primitives.',
	maxBudgetTokens:   2000,
	reviewCriteria:    ['Names the HA classes'],
};

// Section with a concrete PascalCase anchor (`FooBarManager`) that
// doesn't exist in the repo. NER will extract it, the literal probe
// will miss, AND the vector search returns nothing -- the section
// should drop.
const NO_ANCHOR_SECTION: PlannedAction = {
	id:                'no-anchor',
	title:             'FooBarManager & Hypothetical Subsystem',
	objective:         'Survey the FooBarManager cache eviction logic.',
	maxBudgetTokens:   2000,
	reviewCriteria:    ['Names FooBarManager'],
};

test('verifyPlannedActions: vector fallback rescues a section when literal probe misses', async () => {
	const result = await verifyPlannedActions([HA_SECTION], {
		repoPath: '/repo',
		_internals: {
			// Literal probe always misses (no entity named "NameNodes" or "HA")
			findEntitiesByName: async () => [],
			// Embedder returns a non-empty vector
			embedQuery: async () => [0.1, 0.2, 0.3],
			// Vector search finds a real anchor entity semantically close to the title
			searchEntities: async () => [fakeEntity('HAServiceProtocol')],
		},
	});
	assert.equal(result.kept.length, 1);
	assert.equal(result.dropped.length, 0);
	assert.equal(result.kept[0]!.id, 'hdfs-ha');
});

test('verifyPlannedActions: vector fallback still drops when no semantic match either', async () => {
	const result = await verifyPlannedActions([NO_ANCHOR_SECTION], {
		repoPath: '/repo',
		_internals: {
			findEntitiesByName: async () => [],
			embedQuery: async () => [0.1, 0.2, 0.3],
			searchEntities: async () => [],   // no semantic hits
		},
	});
	assert.equal(result.kept.length, 0);
	assert.equal(result.dropped.length, 1);
	assert.match(result.dropped[0]!.reason, /vector fallback also returned no hits/);
});

test('verifyPlannedActions: vectorFallback=false disables the new behaviour (drops on literal miss)', async () => {
	const result = await verifyPlannedActions([HA_SECTION], {
		repoPath: '/repo',
		vectorFallback: false,
		_internals: {
			findEntitiesByName: async () => [],
			// embedder should not be called
			embedQuery: async () => { throw new Error('embedQuery should not be called'); },
			searchEntities: async () => { throw new Error('searchEntities should not be called'); },
		},
	});
	assert.equal(result.kept.length, 0);
	assert.equal(result.dropped.length, 1);
});

test('verifyPlannedActions: vector fallback errors -> conservative keep', async () => {
	const result = await verifyPlannedActions([HA_SECTION], {
		repoPath: '/repo',
		_internals: {
			findEntitiesByName: async () => [],
			embedQuery: async () => { throw new Error('embedder offline'); },
			searchEntities: async () => [],
		},
	});
	// Embedder error -> keep (don't drop a section on transient infra failure)
	assert.equal(result.kept.length, 1);
	assert.equal(result.dropped.length, 0);
});

test('verifyPlannedActions: empty queryVec from embedder -> skips vector hit check, drops section', async () => {
	const result = await verifyPlannedActions([HA_SECTION], {
		repoPath: '/repo',
		_internals: {
			findEntitiesByName: async () => [],
			embedQuery: async () => [],     // empty vec -> embedder unavailable
			searchEntities: async () => { throw new Error('searchEntities should not be called with empty vec'); },
		},
	});
	// Empty vec means searchEntities never runs -- falls through to drop
	assert.equal(result.kept.length, 0);
	assert.equal(result.dropped.length, 1);
});

test('verifyPlannedActions: literal hit -> vector fallback not needed', async () => {
	const result = await verifyPlannedActions([HA_SECTION], {
		repoPath: '/repo',
		_internals: {
			findEntitiesByName: async () => [fakeEntity('NameNodes')],   // literal hit (synthetic)
			embedQuery: async () => { throw new Error('embedder should not be called when literal probe succeeds'); },
			searchEntities: async () => [],
		},
	});
	assert.equal(result.kept.length, 1);
	assert.equal(result.dropped.length, 0);
});

test('verifyPlannedActions: vectorMinHits=2 -- single match no longer suffices', async () => {
	const result = await verifyPlannedActions([HA_SECTION], {
		repoPath: '/repo',
		vectorMinHits: 2,
		_internals: {
			findEntitiesByName: async () => [],
			embedQuery: async () => [0.1, 0.2, 0.3],
			searchEntities: async () => [fakeEntity('HAServiceProtocol')],   // only 1 hit
		},
	});
	assert.equal(result.kept.length, 0);
	assert.equal(result.dropped.length, 1);
});
