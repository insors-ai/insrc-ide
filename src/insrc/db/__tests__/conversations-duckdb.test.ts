/**
 * DuckDB-backed conversations smoke tests (Phase B.6).
 *
 * Covers session + turn CRUD, lifecycle transitions, vector seeding /
 * search, pruning (TTL + per-repo cap), the deleteSession cascade,
 * and the compacted-turns write path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  closeDuckDBStorage,
  setStorageDuckDBPath,
  withStorageConnection,
} from '../../daemon/db/duckdb-storage-pool.js';
import {
  getDuckDBGraphClient,
  resetDuckDBGraphClient,
} from '../duckdb-graph-client.js';
import { applyDuckDBGraphSchema } from '../duckdb-graph-schema.js';
import {
  saveTurn, saveSession, closeSession,
  setSessionAgent, setSessionStatus, bumpSessionActivity,
  deleteSession, deleteSessionsForRepo, deleteTurnsForRepo, deleteTurnsByIds,
  seedFromPrior, searchTurnsByRepo,
  getAllTurns, getAllTurnsForRepo, getConversationStats,
  getSessionById, getTurnsForSession, listSessions, listSessionRecords,
  pruneConversations, addCompactedTurns,
  type TurnRecord, type SessionRecord,
} from '../conversations.js';
import type { DbClient } from '../client.js';
import { loadConfig } from '../../agent/config.js';

const DIM = loadConfig().models.providers.local.embeddingDim;

function vec(seed: number): number[] {
  const v = new Array<number>(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed * 0.7 + i * 0.0013);
  return v;
}

test.beforeEach(async () => {
  resetDuckDBGraphClient();
  setStorageDuckDBPath(':memory:');
  await closeDuckDBStorage();
});
test.afterEach(async () => {
  resetDuckDBGraphClient();
  await closeDuckDBStorage();
});

async function setup(): Promise<DbClient> {
  await withStorageConnection(async (conn) => applyDuckDBGraphSchema(conn));
  return { duck: getDuckDBGraphClient() } satisfies DbClient;
}

const NOW_DATE = '2026-05-02T00:00:00Z';

function mkTurn(s: string, idx: number, overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    sessionId: s, idx,
    user:      `u${idx}`,
    assistant: `a${idx}`,
    entities:  [],
    vector:    [],
    repo:      '/repo',
    type: 'turn', tier: 'hot',
    createdAt: NOW_DATE,
    ...overrides,
  };
}

test('saveSession + getSessionById round-trip with sentinels for missing optionals', async () => {
  const db = await setup();
  await saveSession(db, { id: 'S1', repo: '/repo', summary: 'first' });
  const back = await getSessionById(db, 'S1');
  assert.equal(back?.id, 'S1');
  assert.equal(back?.summary, 'first');
  assert.equal(back?.agent, 'chat');
  assert.equal(back?.status, 'active');
  assert.deepEqual(back?.seenEntities, []);
});

test('saveSession upsert: second call updates summary, preserves status if not set', async () => {
  const db = await setup();
  await saveSession(db, { id: 'S1', repo: '/repo', summary: 'v1', agent: 'planner', status: 'active' });
  await saveSession(db, { id: 'S1', repo: '/repo', summary: 'v2' });
  const back = await getSessionById(db, 'S1');
  assert.equal(back?.summary, 'v2');
  assert.equal(back?.agent, 'planner', 'agent should be preserved if not in second call');
});

test('saveTurn writes turn row and bumps last_activity_at on its session', async () => {
  const db = await setup();
  await saveSession(db, { id: 'S1', repo: '/repo', summary: 's' });
  const beforeBump = await getSessionById(db, 'S1');
  await new Promise(r => setTimeout(r, 10));
  await saveTurn(db, mkTurn('S1', 0));
  const afterBump = await getSessionById(db, 'S1');
  assert.notEqual(afterBump?.lastActivityAt, beforeBump?.lastActivityAt, 'lastActivityAt should bump');

  const turns = await getTurnsForSession(db, 'S1');
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.user, 'u0');
});

test('getTurnsForSession returns turns sorted by idx (and skips non-"turn" types)', async () => {
  const db = await setup();
  await saveSession(db, { id: 'S1', repo: '/repo', summary: 's' });
  await saveTurn(db, mkTurn('S1', 2));
  await saveTurn(db, mkTurn('S1', 0));
  await saveTurn(db, mkTurn('S1', 1));
  await saveTurn(db, mkTurn('S1', 5, { type: 'summary' })); // should be filtered out
  const out = await getTurnsForSession(db, 'S1');
  assert.deepEqual(out.map(t => t.idx), [0, 1, 2]);
});

test('setSessionAgent + setSessionStatus + bumpSessionActivity each update the row', async () => {
  const db = await setup();
  await saveSession(db, { id: 'S1', repo: '/repo', summary: 's' });
  await setSessionAgent(db, 'S1', 'designer', 'design');
  await setSessionStatus(db, 'S1', 'paused');
  await bumpSessionActivity(db, 'S1');
  const back = await getSessionById(db, 'S1');
  assert.equal(back?.agent, 'designer');
  assert.equal(back?.category, 'design');
  assert.equal(back?.status, 'paused');
});

test('closeSession persists summary + sets status=completed', async () => {
  const db = await setup();
  await saveSession(db, { id: 'S1', repo: '/repo', summary: 'orig' });
  await closeSession(db, { id: 'S1', repo: '/repo', summary: 'final', seenEntities: ['e1'] }, vec(1));
  const back = await getSessionById(db, 'S1');
  assert.equal(back?.summary, 'final');
  assert.equal(back?.status, 'completed');
  assert.deepEqual(back?.seenEntities, ['e1']);
});

test('seedFromPrior ranks by cosine then re-sorts by recency', async () => {
  const db = await setup();
  // Create two sessions: S1 with closer embedding, S2 with farther
  await closeSession(db, { id: 'S1', repo: '/repo', summary: 'a', seenEntities: [] }, vec(1));
  await new Promise(r => setTimeout(r, 5));
  await closeSession(db, { id: 'S2', repo: '/repo', summary: 'b', seenEntities: [] }, vec(99));

  const out = await seedFromPrior(db, '/repo', vec(1), 5);
  // Both candidates returned (under 30-day TTL); recency sort puts
  // S2 first since it was inserted last.
  assert.deepEqual(out.map(s => s.id), ['S2', 'S1']);
});

test('searchTurnsByRepo returns nearest by cosine, only turn/directive/merged types', async () => {
  const db = await setup();
  await saveSession(db, { id: 'S1', repo: '/repo', summary: 's' });
  await saveTurn(db, mkTurn('S1', 0, { vector: vec(1), type: 'turn' }));
  await saveTurn(db, mkTurn('S1', 1, { vector: vec(2), type: 'directive' }));
  await saveTurn(db, mkTurn('S1', 2, { vector: vec(3), type: 'summary' })); // excluded by type filter

  const top = await searchTurnsByRepo(db, '/repo', vec(1), 5);
  assert.equal(top.length, 2, 'summary type filtered out; turn + directive remain');
  assert.equal(top[0]!.idx, 0, 'idx=0 closest by cosine');
});

test('pruneConversations: drops expired + caps per-repo at 20', async () => {
  const db = await setup();
  // 3 expired (in the past) + 22 fresh -- expect 3 dropped, 2 capped
  const past = new Date(Date.now() - 86_400_000).toISOString();
  for (let i = 0; i < 3; i++) {
    await db.duck.exec(
      `INSERT INTO conversation_session (id, repo, summary, seen_entities, created_at, expires_at,
        agent, category, status, last_activity_at, embedding)
       VALUES (?, '/repo', 's', '[]', ?, ?, 'chat', '', 'completed', ?, NULL)`,
      [`E${i}`, past, past, past],
    );
  }
  for (let i = 0; i < 22; i++) {
    await saveSession(db, { id: `F${i}`, repo: '/repo', summary: `fresh-${i}` });
    await new Promise(r => setTimeout(r, 1));
  }
  const result = await pruneConversations(db);
  assert.equal(result.expired, 3);
  assert.equal(result.capped, 2);
  const left = await listSessions(db, '/repo');
  assert.equal(left.length, 20);
});

test('deleteSession cascades to turns and reports counts', async () => {
  const db = await setup();
  await saveSession(db, { id: 'S1', repo: '/repo', summary: 's' });
  await saveTurn(db, mkTurn('S1', 0));
  await saveTurn(db, mkTurn('S1', 1));
  const result = await deleteSession(db, 'S1');
  assert.equal(result.sessionRows, 1);
  assert.equal(result.turnRows, 2);
  assert.equal(await getSessionById(db, 'S1'), null);
  assert.deepEqual(await getTurnsForSession(db, 'S1'), []);
});

test('deleteTurnsByIds removes only the specified turns', async () => {
  const db = await setup();
  await saveSession(db, { id: 'S1', repo: '/repo', summary: 's' });
  await saveTurn(db, mkTurn('S1', 0));
  await saveTurn(db, mkTurn('S1', 1));
  await saveTurn(db, mkTurn('S1', 2));
  await deleteTurnsByIds(db, ['S1:0', 'S1:2']);
  const left = await getTurnsForSession(db, 'S1');
  assert.deepEqual(left.map(t => t.idx), [1]);
});

test('addCompactedTurns: defaults to merged/cold, but honors caller-supplied type/tier', async () => {
  const db = await setup();
  await saveSession(db, { id: 'S1', repo: '/repo', summary: 's' });
  // mkTurn sets type='turn' / tier='hot' by default; pass undefined
  // to exercise the merged/cold defaults path.
  await addCompactedTurns(db, [{
    sessionId: 'S1', idx: 0, user: 'u', assistant: 'a',
    entities: [], vector: vec(1),
    repo: '/repo',
    sourceIds: ['S1:0', 'S1:1'],
  }]);
  const all = await getAllTurnsForRepo(db, '/repo');
  assert.equal(all.length, 1);
  assert.equal(all[0]!.type, 'merged');
  assert.equal(all[0]!.tier, 'cold');
  assert.notEqual(all[0]!.compactedAt, '');
  assert.deepEqual(all[0]!.sourceIds, ['S1:0', 'S1:1']);
});

test('listSessionRecords sorts by last_activity_at desc; status filter narrows', async () => {
  const db = await setup();
  await saveSession(db, { id: 'S1', repo: '/repo', summary: 's', status: 'active' });
  await new Promise(r => setTimeout(r, 5));
  await saveSession(db, { id: 'S2', repo: '/repo', summary: 's', status: 'paused' });
  await new Promise(r => setTimeout(r, 5));
  await saveSession(db, { id: 'S3', repo: '/repo', summary: 's', status: 'completed' });

  const all = await listSessionRecords(db);
  // newest first by lastActivityAt
  assert.equal(all[0]!.id, 'S3');

  const onlyPaused: SessionRecord[] = await listSessionRecords(db, { statuses: ['paused'] });
  assert.deepEqual(onlyPaused.map(s => s.id), ['S2']);
});

test('getConversationStats counts turns by type / tier / repo + sessions', async () => {
  const db = await setup();
  await saveSession(db, { id: 'S1', repo: '/r1', summary: 's' });
  await saveSession(db, { id: 'S2', repo: '/r2', summary: 's' });
  await saveTurn(db, mkTurn('S1', 0, { repo: '/r1' }));
  await saveTurn(db, mkTurn('S1', 1, { repo: '/r1', type: 'directive' }));
  await saveTurn(db, mkTurn('S2', 0, { repo: '/r2', tier: 'cold' }));

  const all = await getConversationStats(db);
  assert.equal(all.totalTurns, 3);
  assert.equal(all.sessions, 2);
  assert.equal(all.byRepo['/r1'], 2);
  assert.equal(all.byType['directive'], 1);
  assert.equal(all.byTier['cold'], 1);

  const r1 = await getConversationStats(db, '/r1');
  assert.equal(r1.totalTurns, 2);
  assert.equal(r1.sessions, 1);
});

test('deleteTurnsForRepo + deleteSessionsForRepo wipe everything for a repo', async () => {
  const db = await setup();
  await saveSession(db, { id: 'S1', repo: '/keep', summary: 's' });
  await saveSession(db, { id: 'S2', repo: '/wipe', summary: 's' });
  await saveTurn(db, mkTurn('S1', 0, { repo: '/keep' }));
  await saveTurn(db, mkTurn('S2', 0, { repo: '/wipe' }));
  await deleteTurnsForRepo(db, '/wipe');
  await deleteSessionsForRepo(db, '/wipe');
  assert.equal((await getAllTurns(db)).length, 1);
  assert.equal((await listSessions(db)).length, 1);
});
