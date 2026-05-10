/**
 * Tests for the `artifact_vec` Lance table
 * (conversation-flow-refinement.md Phase 2). Mirrors the
 * `session_vec.test.ts` shape: tmpdir lance, deterministic seed
 * vectors, round-trip / filter / delete coverage.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeLanceConn, setLanceConnPath } from '../conn.js';
import {
	upsertArtifactVec,
	upsertArtifactVecBatch,
	queryArtifactVec,
	getArtifactById,
	deleteArtifactsForSession,
	_resetArtifactVecCache,
} from '../artifact-vec.js';
import { loadConfig } from '../../../agent/config.js';

const DIM = loadConfig().models.providers.local.embeddingDim;
let dir: string;

function vec(seed: number): Float32Array {
	const v = new Float32Array(DIM);
	for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed * (i + 1) * 0.001) * 0.1;
	return v;
}

test.beforeEach(async () => {
	await closeLanceConn();
	_resetArtifactVecCache();
	dir = mkdtempSync(join(tmpdir(), 'insrc-artifact-vec-'));
	setLanceConnPath(join(dir, 'lance'));
});
test.afterEach(async () => {
	await closeLanceConn();
	_resetArtifactVecCache();
	rmSync(dir, { recursive: true, force: true });
});

test('upsertArtifactVec + queryArtifactVec round-trip', async () => {
	await upsertArtifactVec({
		id:         's1:1000:code.source.repo.describe',
		embedding:  vec(1),
		session_id: 's1',
		intent:     'code-analysis',
		skill_id:   'code.source.repo.describe',
		timestamp:  BigInt(1000),
		path:       '/tmp/insrc/s1/1000-code.source.repo.describe.json',
		preview:    '{"fileCount":12500}',
	});
	const hits = await queryArtifactVec(Array.from(vec(1)), { sessionId: 's1', k: 5 });
	assert.equal(hits.length, 1);
	assert.equal(hits[0]!.id, 's1:1000:code.source.repo.describe');
	assert.equal(hits[0]!.intent, 'code-analysis');
	assert.equal(hits[0]!.timestamp, BigInt(1000));
	assert.match(hits[0]!.preview, /fileCount/);
});

test('queryArtifactVec scopes by sessionId', async () => {
	await upsertArtifactVecBatch([
		{ id: 's1:1:a', embedding: vec(1), session_id: 's1', intent: 'code-analysis', skill_id: 'a', timestamp: BigInt(1), path: '/p1', preview: 'p1' },
		{ id: 's2:1:a', embedding: vec(1), session_id: 's2', intent: 'code-analysis', skill_id: 'a', timestamp: BigInt(1), path: '/p2', preview: 'p2' },
	]);
	const hitsForS1 = await queryArtifactVec(Array.from(vec(1)), { sessionId: 's1', k: 5 });
	assert.equal(hitsForS1.length, 1);
	assert.equal(hitsForS1[0]!.session_id, 's1');
});

test('queryArtifactVec scopes by intent when provided', async () => {
	await upsertArtifactVecBatch([
		{ id: 's1:1:code-skill', embedding: vec(1), session_id: 's1', intent: 'code-analysis', skill_id: 's', timestamp: BigInt(1), path: '/p1', preview: 'p1' },
		{ id: 's1:2:data-skill', embedding: vec(1), session_id: 's1', intent: 'data-analysis', skill_id: 's', timestamp: BigInt(2), path: '/p2', preview: 'p2' },
	]);
	const codeOnly = await queryArtifactVec(Array.from(vec(1)), { sessionId: 's1', intent: 'code-analysis', k: 5 });
	assert.equal(codeOnly.length, 1);
	assert.equal(codeOnly[0]!.intent, 'code-analysis');
});

test('getArtifactById returns the row by exact id (no ANN)', async () => {
	await upsertArtifactVec({
		id: 's1:1:s', embedding: vec(2), session_id: 's1', intent: 'code-analysis',
		skill_id: 's', timestamp: BigInt(1), path: '/p', preview: 'preview',
	});
	const row = await getArtifactById('s1:1:s');
	assert.ok(row);
	assert.equal(row!.skill_id, 's');
	assert.equal(row!.preview, 'preview');
	const miss = await getArtifactById('does-not-exist');
	assert.equal(miss, null);
});

test('deleteArtifactsForSession removes all rows for a session and returns count', async () => {
	await upsertArtifactVecBatch([
		{ id: 's1:1:a', embedding: vec(1), session_id: 's1', intent: 'code-analysis', skill_id: 'a', timestamp: BigInt(1), path: '/p1', preview: 'p' },
		{ id: 's1:2:b', embedding: vec(1), session_id: 's1', intent: 'code-analysis', skill_id: 'b', timestamp: BigInt(2), path: '/p2', preview: 'p' },
		{ id: 's2:1:a', embedding: vec(1), session_id: 's2', intent: 'code-analysis', skill_id: 'a', timestamp: BigInt(1), path: '/p3', preview: 'p' },
	]);
	const removed = await deleteArtifactsForSession('s1');
	assert.equal(removed, 2);
	const remaining = await queryArtifactVec(Array.from(vec(1)), { sessionId: 's2', k: 5 });
	assert.equal(remaining.length, 1);
	assert.equal(remaining[0]!.session_id, 's2');
});

test('upsert: writing the same id replaces', async () => {
	await upsertArtifactVec({
		id: 's1:1:a', embedding: vec(1), session_id: 's1', intent: 'code-analysis',
		skill_id: 'a', timestamp: BigInt(1), path: '/p', preview: 'first',
	});
	await upsertArtifactVec({
		id: 's1:1:a', embedding: vec(2), session_id: 's1', intent: 'code-analysis',
		skill_id: 'a', timestamp: BigInt(1), path: '/p2', preview: 'second',
	});
	const row = await getArtifactById('s1:1:a');
	assert.equal(row!.preview, 'second');
	assert.equal(row!.path, '/p2');
});

test('returns [] for empty query / empty session / k=0', async () => {
	assert.deepEqual(await queryArtifactVec([], { sessionId: 's1', k: 5 }), []);
	assert.deepEqual(await queryArtifactVec(Array.from(vec(1)), { sessionId: '', k: 5 }), []);
	assert.deepEqual(await queryArtifactVec(Array.from(vec(1)), { sessionId: 's1', k: 0 }), []);
});

test('deleteArtifactsForSession on empty session returns 0 cleanly', async () => {
	const removed = await deleteArtifactsForSession('never-existed');
	assert.equal(removed, 0);
});
