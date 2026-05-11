/**
 * Phase 3 tests for `retrieveClassifierMemory`.
 *
 * Uses real LMDB + Lance instances per test (mirrors the
 * conversations-lance-integration test pattern) but injects a
 * deterministic `embed` function so the suite never depends on a
 * live Ollama. Production callers leave `embed` unset and pick up
 * the default `embedQuery` from `indexer/embedder.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeGraphStore, setGraphStorePath } from '../../../db/graph/store.js';
import { closeLanceConn, setLanceConnPath }    from '../../../db/lance/conn.js';
import { _resetTurnVecCache, writeTurnEmbedding }   from '../../../db/lance/turn-vec.js';
import {
	_resetResponseSegmentVecCache,
	upsertResponseSegmentVec,
} from '../../../db/lance/response-segment-vec.js';
import { saveSession, saveTurn } from '../../../db/conversations.js';
import { loadConfig } from '../../config.js';
import {
	retrieveClassifierMemory,
} from '../classifier-memory.js';
import type { Session } from '../../session.js';

const DIM = loadConfig().models.providers.local.embeddingDim;
const REPO = '/repo/foo';

let dir: string;

function vec(seed: number): number[] {
	const v: number[] = new Array(DIM);
	for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed * (i + 1) * 0.001) * 0.1;
	return v;
}

function fakeEmbed(seed: number): (text: string) => Promise<number[]> {
	return async () => vec(seed);
}

function fakeSession(id: string): Session {
	// retrieveClassifierMemory only reads `session.id`; everything
	// else is unused. Cast through unknown to satisfy the wider
	// Session shape.
	return { id } as unknown as Session;
}

test.beforeEach(async () => {
	await closeGraphStore();
	await closeLanceConn();
	_resetTurnVecCache();
	_resetResponseSegmentVecCache();
	dir = mkdtempSync(join(tmpdir(), 'insrc-classifier-mem-'));
	setGraphStorePath(join(dir, 'graph.lmdb'));
	setLanceConnPath(join(dir, 'lance'));
});
test.afterEach(async () => {
	await closeGraphStore();
	await closeLanceConn();
	_resetTurnVecCache();
	_resetResponseSegmentVecCache();
	rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Empty / edge cases
// ---------------------------------------------------------------------------

test('empty sessionId -> empty memory, no throw, no embed call', async () => {
	let calls = 0;
	const r = await retrieveClassifierMemory(
		fakeSession(''),
		'describe HDFS',
		{ embed: async () => { calls++; return vec(1); } },
	);
	assert.deepEqual(r, { turns: [], segments: [] });
	assert.equal(calls, 0);
});

test('empty message -> empty memory, no embed call', async () => {
	let calls = 0;
	const r = await retrieveClassifierMemory(
		fakeSession('s1'),
		'   ',
		{ embed: async () => { calls++; return vec(1); } },
	);
	assert.deepEqual(r, { turns: [], segments: [] });
	assert.equal(calls, 0);
});

test('embed returns empty vec (Ollama down) -> empty memory, no Lance query', async () => {
	const r = await retrieveClassifierMemory(
		fakeSession('s1'),
		'hello',
		{ embed: async () => [] },
	);
	assert.deepEqual(r, { turns: [], segments: [] });
});

test('embed throws -> empty memory, no rethrow', async () => {
	const r = await retrieveClassifierMemory(
		fakeSession('s1'),
		'hello',
		{ embed: async () => { throw new Error('ollama down'); } },
	);
	assert.deepEqual(r, { turns: [], segments: [] });
});

test('session with no turns / no segments -> empty memory', async () => {
	await saveSession(null, { id: 's1', repo: REPO, summary: '' });
	const r = await retrieveClassifierMemory(
		fakeSession('s1'),
		'hello',
		{ embed: fakeEmbed(1) },
	);
	assert.deepEqual(r, { turns: [], segments: [] });
});

// ---------------------------------------------------------------------------
// Happy-path retrieval
// ---------------------------------------------------------------------------

test('retrieves up to 3 turn hits, recencyRank stamped 1..N, both user+assistant sides surface', async () => {
	await saveSession(null, { id: 's1', repo: REPO, summary: '' });

	// Three turns at increasing timestamps. Same vector means all
	// three rank as ANN hits; each turn yields TWO candidates (user
	// + assistant side) per the plan's example layout, so the
	// retriever has 6 candidates and keeps the 3 most recent.
	await saveTurn(null, {
		sessionId: 's1', idx: 0,
		user: 'describe what this repo does', assistant: 'Apache Hadoop is a distributed framework.',
		entities: [], vector: vec(1), repo: REPO,
		createdAt: '2026-05-11T10:00:00.000Z',
	});
	await saveTurn(null, {
		sessionId: 's1', idx: 1,
		user: 'tell me about NameNode HA', assistant: 'NameNode HA uses a quorum of journal nodes.',
		entities: [], vector: vec(1), repo: REPO,
		createdAt: '2026-05-11T10:05:00.000Z',
	});
	await saveTurn(null, {
		sessionId: 's1', idx: 2,
		user: 'now describe HDFS Core', assistant: 'HDFS Core is the distributed filesystem layer.',
		entities: [], vector: vec(1), repo: REPO,
		createdAt: '2026-05-11T10:10:00.000Z',
	});

	const r = await retrieveClassifierMemory(
		fakeSession('s1'),
		'elaborate on the core filesystem',
		{ embed: fakeEmbed(1) },
	);

	assert.equal(r.turns.length, 3);
	// Most-recent turn (idx=2) fills BOTH its sides into the top of
	// the recency-sorted list before any older turn appears. So
	// rank 1 + rank 2 are both s1:2 (one user, one assistant). Rank
	// 3 is s1:1's user side (assistant of s1:1 just barely doesn't
	// make the cut at top-3).
	assert.deepEqual(r.turns.map(t => t.recencyRank), [1, 2, 3]);
	assert.equal(r.turns[0]!.turnId, 's1:2', 'rank 1 must be the most recent turn');
	assert.equal(r.turns[1]!.turnId, 's1:2', 'rank 2 also from the most recent turn (other side)');
	assert.equal(r.turns[2]!.turnId, 's1:1', 'rank 3 is the next-most-recent turn');
	const rolesForS1_2 = new Set(r.turns.filter(t => t.turnId === 's1:2').map(t => t.role));
	assert.deepEqual(rolesForS1_2, new Set(['user', 'assistant']),
		'both sides of the most recent turn must surface');
	for (const t of r.turns) {
		assert.ok(t.relevance > 0 && t.relevance <= 1);
		assert.ok(t.excerpt.length > 0);
	}
});

test('hydrate skips Lance hits whose LMDB row is missing (race with delete)', async () => {
	await saveSession(null, { id: 's1', repo: REPO, summary: '' });

	// One real turn (LMDB + Lance both have the row).
	await saveTurn(null, {
		sessionId: 's1', idx: 0,
		user: 'real turn', assistant: 'real reply',
		entities: [], vector: vec(1), repo: REPO,
		createdAt: '2026-05-11T10:00:00.000Z',
	});

	// One orphan in Lance only -- simulates a delete-race where the
	// LMDB row went away but the Lance row hasn't been cleaned up.
	await writeTurnEmbedding({
		id: 's1:99', embedding: new Float32Array(vec(1)), repo: REPO,
		sessionId: 's1', type: 'turn', tier: 'hot',
	});

	const r = await retrieveClassifierMemory(
		fakeSession('s1'),
		'anything',
		{ embed: fakeEmbed(1) },
	);

	// Real turn surfaces; orphan dropped silently.
	const ids = new Set(r.turns.map(t => t.turnId));
	assert.ok(ids.has('s1:0'));
	assert.ok(!ids.has('s1:99'));
});

test('retrieves up to 3 segment hits with text excerpt + recencyRank', async () => {
	await saveSession(null, { id: 's1', repo: REPO, summary: '' });

	// Three segments, slightly different vectors so ANN orders them.
	// Note: segments use the seed value's order to control ranking.
	await upsertResponseSegmentVec({
		id: 's1:0:0', embedding: new Float32Array(vec(1)),
		sessionId: 's1', turnId: 's1:0', segmentIdx: 0,
		text: 'HDFS Core is the distributed filesystem layer responsible for block storage.',
		timestamp: BigInt(Date.parse('2026-05-11T10:00:00Z')),
	});
	await upsertResponseSegmentVec({
		id: 's1:0:1', embedding: new Float32Array(vec(2)),
		sessionId: 's1', turnId: 's1:0', segmentIdx: 1,
		text: 'NameNode owns the filesystem namespace and the file-to-block mapping.',
		timestamp: BigInt(Date.parse('2026-05-11T10:01:00Z')),
	});
	await upsertResponseSegmentVec({
		id: 's1:1:0', embedding: new Float32Array(vec(3)),
		sessionId: 's1', turnId: 's1:1', segmentIdx: 0,
		text: 'YARN handles cluster resource scheduling.',
		timestamp: BigInt(Date.parse('2026-05-11T10:05:00Z')),
	});

	const r = await retrieveClassifierMemory(
		fakeSession('s1'),
		'elaborate on the core filesystem',
		{ embed: fakeEmbed(1) },
	);

	assert.equal(r.segments.length, 3);
	// First (best ANN match) -- vector seed=1.
	assert.equal(r.segments[0]!.segmentId, 's1:0:0');
	assert.equal(r.segments[0]!.turnId,    's1:0');
	assert.match(r.segments[0]!.text, /HDFS Core/);
	assert.ok(r.segments[0]!.relevance >= r.segments[2]!.relevance,
		'segments must be returned in descending relevance');
	// recencyRank stamped (1..3 across the kept set, by timestamp).
	const ranks = r.segments.map(s => s.recencyRank).sort();
	assert.deepEqual(ranks, [1, 2, 3]);
});

test('segment scoping: hits from other sessions are excluded', async () => {
	await saveSession(null, { id: 's1', repo: REPO, summary: '' });
	await saveSession(null, { id: 's2', repo: REPO, summary: '' });

	await upsertResponseSegmentVec({
		id: 's1:0:0', embedding: new Float32Array(vec(1)),
		sessionId: 's1', turnId: 's1:0', segmentIdx: 0,
		text: 'session-1 segment',
		timestamp: BigInt(Date.now()),
	});
	await upsertResponseSegmentVec({
		id: 's2:0:0', embedding: new Float32Array(vec(1)),
		sessionId: 's2', turnId: 's2:0', segmentIdx: 0,
		text: 'session-2 segment (must not leak)',
		timestamp: BigInt(Date.now()),
	});

	const r = await retrieveClassifierMemory(
		fakeSession('s1'),
		'anything',
		{ embed: fakeEmbed(1) },
	);
	assert.equal(r.segments.length, 1);
	assert.equal(r.segments[0]!.segmentId, 's1:0:0');
});

test('long segment text is trimmed at sentence boundary with ellipsis', async () => {
	await saveSession(null, { id: 's1', repo: REPO, summary: '' });

	// 1500-char text with ample sentence terminators -- should trim
	// to ≤ ~800 chars at a `. ` boundary.
	const sentence = 'This is a sentence about the distributed filesystem layer. ';
	const longText = sentence.repeat(30);                  // ~1800 chars
	await upsertResponseSegmentVec({
		id: 's1:0:0', embedding: new Float32Array(vec(1)),
		sessionId: 's1', turnId: 's1:0', segmentIdx: 0,
		text: longText, timestamp: BigInt(Date.now()),
	});

	const r = await retrieveClassifierMemory(
		fakeSession('s1'),
		'anything',
		{ embed: fakeEmbed(1) },
	);
	assert.equal(r.segments.length, 1);
	assert.ok(r.segments[0]!.text.length <= 810, `expected ≤ 810 chars, got ${r.segments[0]!.text.length}`);
	assert.match(r.segments[0]!.text, /\.\.\.$/);
});
