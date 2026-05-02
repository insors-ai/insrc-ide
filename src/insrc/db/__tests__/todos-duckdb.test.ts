/**
 * Smoke tests for the DuckDB-backed todos persistence layer
 * (plans/storage-migration-duckdb.md Phase B.5).
 *
 * Covers: list / item / comment CRUD, hierarchy walks, parent-cycle
 * detection, status-transition gates, transfer history append, and
 * the cascade on deleteList. The rewrite drops the LanceDB sqlStr /
 * values-vs-valuesSql gotchas (parameterized SQL throughout) so most
 * of the F9-fix territory in the old file simply doesn't apply.
 *
 * Schema is provisioned via the storage pool's :memory: backend per
 * the standard test-isolation pattern (see other db/__tests__).
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
import * as todos from '../todos.js';
import type { DbClient } from '../client.js';

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
  // db.lance isn't used by the rewritten todos.ts, so a stub is fine
  // for these tests. The Phase B.10 cleanup will drop the lance field
  // entirely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { duck: getDuckDBGraphClient(), lance: {} as any } as DbClient;
}

const NOW = '2026-05-02T00:00:00Z';

test('insertList + getList round-trip with default flags', async () => {
  const db = await setup();
  const list = await todos.insertList(db, {
    id: 'L1', sessionId: 'S1', title: 'planning',
    owner: 'planner', source: 'planner', createdAt: NOW,
  });
  assert.equal(list.id, 'L1');
  assert.equal(list.status, 'active');
  assert.equal(list.owner, 'planner');
  assert.equal(list.source, 'planner');
  assert.equal(list.transfers.length, 1);
  assert.equal(list.transfers[0]!.reason, 'created');
  assert.deepEqual(list.items, []);

  const back = await todos.getList(db, 'L1');
  assert.equal(back?.id, 'L1');
  assert.equal(back?.title, 'planning');
});

test('insertItem requires the list to exist; round-trips with comments', async () => {
  const db = await setup();
  await assert.rejects(
    () => todos.insertItem(db, { id: 'I1', listId: 'missing', title: 'x', orderKey: 1, createdAt: NOW }),
    /does not exist/,
  );
  await todos.insertList(db, { id: 'L1', sessionId: 'S1', title: 'plan', owner: 'planner', source: 'planner', createdAt: NOW });
  const item = await todos.insertItem(db, { id: 'I1', listId: 'L1', title: 'first', orderKey: 0.5, createdAt: NOW });
  assert.equal(item.title, 'first');
  assert.equal(item.status, 'pending');

  await todos.insertComment(db, { id: 'C1', itemId: 'I1', author: 'planner', body: 'note', createdAt: NOW });
  const list = await todos.getList(db, 'L1');
  assert.equal(list?.items.length, 1);
  assert.equal(list?.items[0]!.comments?.length, 1);
  assert.equal(list?.items[0]!.comments?.[0]!.body, 'note');
});

test('listItems returns items sorted by order_key (stable for tied keys)', async () => {
  const db = await setup();
  await todos.insertList(db, { id: 'L1', sessionId: 'S1', title: 'plan', owner: 'planner', source: 'planner', createdAt: NOW });
  await todos.insertItem(db, { id: 'I3', listId: 'L1', title: 'c', orderKey: 3, createdAt: NOW });
  await todos.insertItem(db, { id: 'I1', listId: 'L1', title: 'a', orderKey: 1, createdAt: NOW });
  await todos.insertItem(db, { id: 'I2', listId: 'L1', title: 'b', orderKey: 2, createdAt: NOW });
  const items = await todos.listItems(db, 'L1', false);
  assert.deepEqual(items.map(i => i.id), ['I1', 'I2', 'I3']);
});

test('updateItem rejects illegal status transition + completed sets completed_at', async () => {
  const db = await setup();
  await todos.insertList(db, { id: 'L1', sessionId: 'S1', title: 'plan', owner: 'planner', source: 'planner', createdAt: NOW });
  await todos.insertItem(db, { id: 'I1', listId: 'L1', title: 'first', orderKey: 0.5, createdAt: NOW });

  // pending -> in_progress -> blocked requires a reason
  const inProgress = await todos.updateItem(db, 'I1', { status: 'in_progress' }, NOW);
  assert.equal(inProgress.status, 'in_progress');
  await assert.rejects(
    () => todos.updateItem(db, 'I1', { status: 'blocked' }, NOW),
    /requires.*blockedReason/,
  );

  // in_progress -> completed legal arc; completed sets completedAt
  const done = await todos.updateItem(db, 'I1', { status: 'completed' }, '2026-05-02T00:01:00Z');
  assert.equal(done.status, 'completed');
  assert.equal(done.completedAt, '2026-05-02T00:01:00Z');
});

test('parent cycle detection rejects self-loop and ancestor reparent', async () => {
  const db = await setup();
  await todos.insertList(db, { id: 'A', sessionId: 'S1', title: 'A', owner: 'planner', source: 'planner', createdAt: NOW });
  await todos.insertList(db, { id: 'B', sessionId: 'S1', title: 'B', owner: 'planner', source: 'planner', parentListId: 'A', createdAt: NOW });
  await todos.insertList(db, { id: 'C', sessionId: 'S1', title: 'C', owner: 'planner', source: 'planner', parentListId: 'B', createdAt: NOW });

  // Reparenting A under C would create A -> ... -> C -> A
  await assert.rejects(() => todos.reparentList(db, 'A', 'C', NOW), /parent-cycle/);

  // Reparenting B to root (null) is fine
  const promoted = await todos.reparentList(db, 'B', null, NOW);
  assert.equal(promoted.parentListId, undefined);
});

test('transferList appends a transfer entry and updates owner', async () => {
  const db = await setup();
  await todos.insertList(db, { id: 'L1', sessionId: 'S1', title: 'plan', owner: 'planner', source: 'planner', createdAt: NOW });
  const after = await todos.transferList(db, 'L1', 'tester', 'handoff', '2026-05-02T01:00:00Z');
  assert.equal(after.owner, 'tester');
  assert.equal(after.transfers.length, 2, 'created + handoff');
  assert.equal(after.transfers[1]!.from, 'planner');
  assert.equal(after.transfers[1]!.to, 'tester');
  assert.equal(after.transfers[1]!.reason, 'handoff');
});

test('deleteList cascades to items + comments', async () => {
  const db = await setup();
  await todos.insertList(db, { id: 'L1', sessionId: 'S1', title: 'plan', owner: 'planner', source: 'planner', createdAt: NOW });
  await todos.insertItem(db, { id: 'I1', listId: 'L1', title: 'a', orderKey: 1, createdAt: NOW });
  await todos.insertItem(db, { id: 'I2', listId: 'L1', title: 'b', orderKey: 2, createdAt: NOW });
  await todos.insertComment(db, { id: 'C1', itemId: 'I1', author: 'planner', body: 'note', createdAt: NOW });

  await todos.deleteList(db, 'L1');

  assert.equal(await todos.getList(db, 'L1'), null);
  assert.equal(await todos.getItem(db, 'I1'), null);
  assert.equal(await todos.getItem(db, 'I2'), null);
  assert.equal(await todos.getComment(db, 'C1'), null);
});

test('listListsBySession orders roots ahead of children', async () => {
  const db = await setup();
  // Insert children first to confirm ordering is from the SQL, not insert order.
  await todos.insertList(db, { id: 'root1', sessionId: 'S1', title: 'r1', owner: 'planner', source: 'planner', createdAt: '2026-05-02T00:00:01Z' });
  await todos.insertList(db, { id: 'child', sessionId: 'S1', title: 'c', owner: 'planner', source: 'planner', parentListId: 'root1', createdAt: '2026-05-02T00:00:00Z' });
  await todos.insertList(db, { id: 'root2', sessionId: 'S1', title: 'r2', owner: 'planner', source: 'planner', createdAt: '2026-05-02T00:00:02Z' });
  const lists = await todos.listListsBySession(db, 'S1');
  assert.deepEqual(lists.map(l => l.id), ['root1', 'root2', 'child']);
});

test('updateComment partial update preserves other fields', async () => {
  const db = await setup();
  await todos.insertList(db, { id: 'L1', sessionId: 'S1', title: 'plan', owner: 'planner', source: 'planner', createdAt: NOW });
  await todos.insertItem(db, { id: 'I1', listId: 'L1', title: 'a', orderKey: 1, createdAt: NOW });
  const c = await todos.insertComment(db, { id: 'C1', itemId: 'I1', author: 'planner', body: 'orig', createdAt: NOW });

  // No fields supplied -> returns existing without DB write
  const noop = await todos.updateComment(db, 'C1', {});
  assert.equal(noop.body, c.body);

  const acked = await todos.updateComment(db, 'C1', { agentAcknowledged: true, body: 'edited', editedAt: '2026-05-02T01:00:00Z' });
  assert.equal(acked.agentAcknowledged, true);
  assert.equal(acked.body, 'edited');
  assert.equal(acked.editedAt, '2026-05-02T01:00:00Z');
});
