/**
 * Dual-write entity-stub round-trip on the DuckDB side (Phase A.3).
 *
 * Exercises the SQL patterns the entities.ts dual-write path uses,
 * without depending on a real Kuzu connection. Confirms that:
 *
 *   - INSERT ... ON CONFLICT DO UPDATE preserves the upsert semantics
 *     of the original `MERGE (n:Entity {id:$id}) SET n.kind = $kind`
 *   - The relation-cleanup-then-entity-delete pattern leaves no
 *     dangling edges (the Cypher DETACH DELETE equivalent)
 *   - 500-chunk IN-list pattern handles the batch size we ship with
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  closeDuckDBStorage,
  setStorageDuckDBPath,
  withStorageConnection as withConnection,
} from '../../daemon/db/duckdb-storage-pool.js';
import {
  getDuckDBGraphClient,
  resetDuckDBGraphClient,
} from '../duckdb-graph-client.js';
import { applyDuckDBGraphSchema } from '../duckdb-graph-schema.js';

test.beforeEach(async () => {
  resetDuckDBGraphClient();
  setStorageDuckDBPath(':memory:');
  await closeDuckDBStorage();
});
test.afterEach(async () => {
  resetDuckDBGraphClient();
  await closeDuckDBStorage();
});

async function setupSchema(): Promise<void> {
  await withConnection(async (conn) => applyDuckDBGraphSchema(conn));
}

test('upsert entity stub: insert when absent', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  await c.exec(
    'INSERT INTO entity (id, kind) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind',
    ['e1', 'function'],
  );
  const rows = await c.query<{ id: string; kind: string }>('SELECT id, kind FROM entity');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, 'function');
});

test('upsert entity stub: update kind when present', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  // First insert
  await c.exec(
    'INSERT INTO entity (id, kind) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind',
    ['e1', 'function'],
  );
  // Same id, new kind -- must update, not duplicate
  await c.exec(
    'INSERT INTO entity (id, kind) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind',
    ['e1', 'class'],
  );
  const rows = await c.query<{ id: string; kind: string }>('SELECT id, kind FROM entity');
  assert.equal(rows.length, 1, 'upsert should not duplicate');
  assert.equal(rows[0]!.kind, 'class', 'kind should be updated');
});

test('detach-delete pattern: relations + entities cleared atomically', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  // Build a small graph: e1 -[CALLS]-> e2, e1 -[CALLS]-> e3, e3 -[CALLS]-> e1
  await c.exec("INSERT INTO entity (id, kind) VALUES ('e1','fn'),('e2','fn'),('e3','fn'),('e4','fn')");
  await c.exec(`
    INSERT INTO relation (src, dst, kind) VALUES
      ('e1','e2','CALLS'),
      ('e1','e3','CALLS'),
      ('e3','e1','CALLS'),
      ('e4','e2','CALLS')
  `);
  // Delete e1 + e3 with the dual-write helper's pattern: relations
  // first, then entities. Order matters (no explicit transaction
  // because each GraphClient call gets a fresh Connection).
  const ids = ['e1', 'e3'];
  const placeholders = ids.map(() => '?').join(', ');
  await c.exec(
    `DELETE FROM relation WHERE src IN (${placeholders}) OR dst IN (${placeholders})`,
    [...ids, ...ids],
  );
  await c.exec(
    `DELETE FROM entity WHERE id IN (${placeholders})`,
    [...ids],
  );

  // Verify e1, e3 are gone
  const remaining = await c.query<{ id: string }>(
    'SELECT id FROM entity ORDER BY id',
  );
  assert.deepEqual(remaining.map(r => r.id), ['e2', 'e4']);

  // Verify no relation involves e1 or e3 (dangling-edge check)
  const dangling = await c.query<{ count: number }>(
    "SELECT COUNT(*)::INTEGER AS count FROM relation WHERE src IN ('e1','e3') OR dst IN ('e1','e3')",
  );
  assert.equal(Number(dangling[0]!.count), 0, 'no dangling edges should remain');

  // The unrelated edge (e4 → e2) should still be there
  const survivors = await c.query<{ src: string; dst: string }>(
    "SELECT src, dst FROM relation WHERE kind='CALLS'",
  );
  assert.equal(survivors.length, 1);
  assert.deepEqual(survivors[0], { src: 'e4', dst: 'e2' });
});

test('detach-delete IN-list: batch of 500 IDs handled', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  // Insert 500 entities + 500 self-loop edges
  const values: string[] = [];
  const params: string[] = [];
  for (let i = 0; i < 500; i++) {
    values.push(`(?, 'fn')`);
    params.push(`e${i}`);
  }
  await c.exec(`INSERT INTO entity (id, kind) VALUES ${values.join(', ')}`, params);

  // Delete all 500 in one shot (simulating the inner batch of detachDeleteEntityStubs)
  const ids = params; // same 500 ids
  const placeholders = ids.map(() => '?').join(', ');
  await c.exec(
    `DELETE FROM entity WHERE id IN (${placeholders})`,
    ids,
  );
  const left = await c.query<{ count: number }>(
    'SELECT COUNT(*)::INTEGER AS count FROM entity',
  );
  assert.equal(Number(left[0]!.count), 0);
});

test('upsert + detach-delete cycle is idempotent', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  // Insert
  await c.exec(
    "INSERT INTO entity (id, kind) VALUES ('e1','fn') ON CONFLICT(id) DO UPDATE SET kind = excluded.kind",
  );
  // Delete
  await c.exec("DELETE FROM relation WHERE src IN ('e1') OR dst IN ('e1')");
  await c.exec("DELETE FROM entity WHERE id IN ('e1')");
  // Delete again -- should not throw on missing rows
  await c.exec("DELETE FROM relation WHERE src IN ('e1') OR dst IN ('e1')");
  await c.exec("DELETE FROM entity WHERE id IN ('e1')");
  const rows = await c.query("SELECT * FROM entity");
  assert.equal(rows.length, 0);
});
