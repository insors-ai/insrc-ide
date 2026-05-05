/**
 * Phase 3.2 integration tests: entities.ts <-> Lance entity_vec wiring.
 *
 * Verifies that updateEmbedding and the cascade paths
 * (deleteEntitiesForFile / deleteEntitiesForRepo / reindexFile)
 * correctly write to / clean up from the Lance entity_vec table
 * alongside the LMDB graph.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { closeGraphStore, setGraphStorePath } from '../graph/store.js';
import { closeLanceConn, setLanceConnPath } from '../lance/conn.js';
import { _resetEntityVecCache, searchEntityVecs } from '../lance/entity-vec.js';
import {
	upsertEntities,
	updateEmbedding,
	deleteEntitiesForFile,
	deleteEntitiesForRepo,
	reindexFile,
} from '../entities.js';
import { searchEntities } from '../search.js';
import { loadConfig } from '../../agent/config.js';
import type { Entity, EntityKind } from '../../shared/types.js';

const DIM = loadConfig().models.providers.local.embeddingDim;
const REPO = '/repo/foo';
const NOW = '2026-05-05T10:00:00.000Z';

let dir: string;

function makeEntityId(repo: string, file: string, kind: string, name: string): string {
	return createHash('sha256')
		.update(`${repo}\x00${file}\x00${kind}\x00${name}`)
		.digest('hex')
		.slice(0, 32);
}

function makeEntity(overrides: Partial<Entity> = {}): Entity {
	const repo = overrides.repo ?? REPO;
	const file = overrides.file ?? `${repo}/src/foo.ts`;
	const kind = (overrides.kind ?? 'function') as EntityKind;
	const name = overrides.name ?? 'foo';
	return {
		id:        overrides.id ?? makeEntityId(repo, file, kind, name),
		kind, name,
		language:  overrides.language ?? 'typescript',
		repo, file,
		startLine: 1, endLine: 5,
		body:      `function ${name}() {}`,
		embedding: [],
		indexedAt: NOW,
	};
}

function vec(seed: number): number[] {
	const v: number[] = new Array(DIM);
	for (let i = 0; i < DIM; i++) {
		v[i] = Math.sin(seed * (i + 1) * 0.001) * 0.1;
	}
	return v;
}

test.beforeEach(async () => {
	await closeGraphStore();
	await closeLanceConn();
	_resetEntityVecCache();
	dir = mkdtempSync(join(tmpdir(), 'insrc-entities-lance-3.2-'));
	setGraphStorePath(join(dir, 'graph.lmdb'));
	setLanceConnPath(join(dir, 'lance'));
});
test.afterEach(async () => {
	await closeGraphStore();
	await closeLanceConn();
	_resetEntityVecCache();
	rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// updateEmbedding writes to Lance
// ---------------------------------------------------------------------------

test('updateEmbedding persists vector to entity_vec', async () => {
	const e = makeEntity();
	await upsertEntities(null, [e]);
	await updateEmbedding(null, e.id, vec(1), 'qwen3-embedding:0.6b');

	const hits = await searchEntityVecs(vec(1), [REPO], 5);
	assert.equal(hits.length, 1);
	assert.equal(hits[0]!.id, e.id);
	assert.equal(hits[0]!.repo, REPO);
});

test('updateEmbedding on unknown entity is silent no-op', async () => {
	await updateEmbedding(null, 'nonexistent-id', vec(1), 'qwen3-embedding:0.6b');
	const hits = await searchEntityVecs(vec(1), [REPO], 5);
	assert.equal(hits.length, 0);
});

test('updateEmbedding with empty embedding only updates LMDB model field', async () => {
	const e = makeEntity();
	await upsertEntities(null, [e]);
	// Empty embedding -> model written to LMDB but no Lance row
	await updateEmbedding(null, e.id, [], 'qwen3-embedding:0.6b');
	const hits = await searchEntityVecs(vec(1), [REPO], 5);
	assert.equal(hits.length, 0);
});

// ---------------------------------------------------------------------------
// searchEntities (Lance ANN + LMDB hydration)
// ---------------------------------------------------------------------------

test('searchEntities returns hydrated Entity objects via Lance ANN', async () => {
	const a = makeEntity({ name: 'near' });
	const b = makeEntity({ name: 'far'  });
	await upsertEntities(null, [a, b]);
	await updateEmbedding(null, a.id, vec(1),  'qwen3-embedding:0.6b');
	await updateEmbedding(null, b.id, vec(50), 'qwen3-embedding:0.6b');

	const hits = await searchEntities(null!, vec(1), [REPO], 5);
	assert.equal(hits.length, 2);
	// Lance returns near before far
	assert.equal(hits[0]!.name, 'near');
	// Hydrated rows include the full Entity body from LMDB
	assert.equal(hits[0]!.body, 'function near() {}');
});

test('searchEntities returns [] for empty query vector', async () => {
	const hits = await searchEntities(null!, [], [REPO], 5);
	assert.deepEqual(hits, []);
});

test('searchEntities returns [] for empty closure', async () => {
	const hits = await searchEntities(null!, vec(1), [], 5);
	assert.deepEqual(hits, []);
});

test('searchEntities respects closure-repo scope', async () => {
	const a = makeEntity({ repo: '/repo/x', file: '/repo/x/a.ts', name: 'a' });
	const b = makeEntity({ repo: '/repo/y', file: '/repo/y/b.ts', name: 'b' });
	await upsertEntities(null, [a, b]);
	await updateEmbedding(null, a.id, vec(1), 'qwen3-embedding:0.6b');
	await updateEmbedding(null, b.id, vec(1), 'qwen3-embedding:0.6b');

	const onlyX = await searchEntities(null!, vec(1), ['/repo/x'], 5);
	assert.equal(onlyX.length, 1);
	assert.equal(onlyX[0]!.repo, '/repo/x');
});

// ---------------------------------------------------------------------------
// Cascade: Lance row cleanup on delete
// ---------------------------------------------------------------------------

test('deleteEntitiesForFile cascades Lance rows', async () => {
	const e = makeEntity();
	await upsertEntities(null, [e]);
	await updateEmbedding(null, e.id, vec(1), 'qwen3-embedding:0.6b');

	// Sanity: Lance row exists
	let hits = await searchEntityVecs(vec(1), [REPO], 5);
	assert.equal(hits.length, 1);

	await deleteEntitiesForFile(null, e.file);

	hits = await searchEntityVecs(vec(1), [REPO], 5);
	assert.equal(hits.length, 0, 'Lance row should be cascaded away');
});

test('deleteEntitiesForRepo cascades all Lance rows for the repo', async () => {
	const a = makeEntity({ name: 'a', file: '/repo/foo/src/a.ts' });
	const b = makeEntity({ name: 'b', file: '/repo/foo/src/b.ts' });
	const c = makeEntity({ name: 'c', repo: '/repo/bar', file: '/repo/bar/c.ts' });
	await upsertEntities(null, [a, b, c]);
	await updateEmbedding(null, a.id, vec(1), 'qwen3-embedding:0.6b');
	await updateEmbedding(null, b.id, vec(2), 'qwen3-embedding:0.6b');
	await updateEmbedding(null, c.id, vec(3), 'qwen3-embedding:0.6b');

	await deleteEntitiesForRepo(null, REPO);

	const fooHits = await searchEntityVecs(vec(1), [REPO], 10);
	assert.equal(fooHits.length, 0, 'all repo entries cascaded');
	const barHits = await searchEntityVecs(vec(3), ['/repo/bar'], 10);
	assert.equal(barHits.length, 1, 'other repos unaffected');
});

test('reindexFile cascades Lance rows for tombstoned entities', async () => {
	const a = makeEntity({ name: 'a' });
	const b = makeEntity({ name: 'b' });
	await upsertEntities(null, [a, b]);
	await updateEmbedding(null, a.id, vec(1), 'qwen3-embedding:0.6b');
	await updateEmbedding(null, b.id, vec(2), 'qwen3-embedding:0.6b');

	// Re-parse without `b` -> b should be tombstoned in both LMDB and Lance
	await reindexFile(null, REPO, a.file, [a]);

	const hits = await searchEntityVecs(vec(2), [REPO], 5);
	const bHits = hits.filter(h => h.id === b.id);
	assert.equal(bHits.length, 0, 'tombstoned entity should be removed from Lance');
});
