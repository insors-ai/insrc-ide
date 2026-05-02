/**
 * Dual-write relation round-trip on the DuckDB side (Phase A.4).
 *
 * Exercises the SQL patterns the relations.ts dual-write path uses
 * for both `relation` (typed entity edges) and `unresolved_relation`
 * (cross-file resolver queue):
 *
 *   - Resolved-edge upsert via INSERT ... ON CONFLICT DO NOTHING
 *     (replaces the typed Cypher MERGE pattern across 8 REL TABLEs)
 *   - Unresolved-row upsert via INSERT ... ON CONFLICT DO UPDATE
 *   - Bulk-insert pattern (the promoteResolvedBatch shape)
 *   - DELETE-by-scope (file / repo / id-list)
 *   - promote-to-resolved sequence (insert + delete in order)
 *   - meta-update via plain UPDATE
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { closeDuckDB } from '../../daemon/db/duckdb-pool.js';
import {
  getDuckDBGraphClient,
  resetDuckDBGraphClient,
} from '../duckdb-graph-client.js';
import { applyDuckDBGraphSchema } from '../duckdb-graph-schema.js';
import { withConnection } from '../../daemon/db/duckdb-pool.js';

test.beforeEach(async () => {
  resetDuckDBGraphClient();
  await closeDuckDB();
});
test.afterEach(async () => {
  resetDuckDBGraphClient();
  await closeDuckDB();
});

async function setupSchema(): Promise<void> {
  await withConnection(async (conn) => applyDuckDBGraphSchema(conn));
}

async function seedEntities(ids: readonly string[]): Promise<void> {
  const c = getDuckDBGraphClient();
  for (const id of ids) {
    await c.exec(
      "INSERT INTO entity (id, kind) VALUES (?, 'fn') ON CONFLICT(id) DO UPDATE SET kind = excluded.kind",
      [id],
    );
  }
}

test('resolved relation upsert: insert then dedupe', async () => {
  await setupSchema();
  await seedEntities(['a', 'b']);
  const c = getDuckDBGraphClient();
  // Insert + repeat -- should dedupe via ON CONFLICT DO NOTHING
  await c.exec(
    'INSERT INTO relation (src, dst, kind) VALUES (?, ?, ?) ON CONFLICT (src, dst, kind) DO NOTHING',
    ['a', 'b', 'CALLS'],
  );
  await c.exec(
    'INSERT INTO relation (src, dst, kind) VALUES (?, ?, ?) ON CONFLICT (src, dst, kind) DO NOTHING',
    ['a', 'b', 'CALLS'],
  );
  // Same src/dst with different kind is allowed
  await c.exec(
    'INSERT INTO relation (src, dst, kind) VALUES (?, ?, ?) ON CONFLICT (src, dst, kind) DO NOTHING',
    ['a', 'b', 'IMPORTS'],
  );
  const rows = await c.query<{ kind: string }>(
    "SELECT kind FROM relation WHERE src='a' AND dst='b' ORDER BY kind",
  );
  assert.deepEqual(rows.map(r => r.kind), ['CALLS', 'IMPORTS']);
});

test('unresolved relation upsert: insert then update on second call', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  const id = 'abc123';
  await c.exec(
    `INSERT INTO unresolved_relation
       (id, repo, from_entity, from_file, kind, raw_to, meta, attempted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       repo = excluded.repo,
       from_entity = excluded.from_entity,
       from_file = excluded.from_file,
       kind = excluded.kind,
       raw_to = excluded.raw_to,
       meta = excluded.meta,
       attempted_at = excluded.attempted_at`,
    [id, '/r1', 'e1', '/r1/a.ts', 'CALLS', 'foo', '{}', '2026-05-01'],
  );
  // Re-upsert with new meta and a new file -- must overwrite, not duplicate
  await c.exec(
    `INSERT INTO unresolved_relation
       (id, repo, from_entity, from_file, kind, raw_to, meta, attempted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       repo = excluded.repo,
       from_entity = excluded.from_entity,
       from_file = excluded.from_file,
       kind = excluded.kind,
       raw_to = excluded.raw_to,
       meta = excluded.meta,
       attempted_at = excluded.attempted_at`,
    [id, '/r1', 'e1', '/r1/b.ts', 'CALLS', 'foo', '{"x":1}', '2026-05-02'],
  );
  const rows = await c.query<{
    from_file: string; meta: string; attempted_at: string;
  }>('SELECT from_file, meta, attempted_at FROM unresolved_relation');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.from_file, '/r1/b.ts');
  assert.equal(rows[0]!.meta, '{"x":1}');
  assert.equal(rows[0]!.attempted_at, '2026-05-02');
});

test('bulk-insert relations: 100 edges in one statement', async () => {
  await setupSchema();
  // Seed 100 entities
  const ids: string[] = Array.from({ length: 101 }, (_, i) => `e${i}`);
  await seedEntities(ids);
  const c = getDuckDBGraphClient();

  // Build a 100-row VALUES insert (the bulkInsertRelations pattern).
  const rows = Array.from({ length: 100 }, (_, i) => ({ from: `e${i}`, to: `e${i + 1}` }));
  const valuesSql = rows.map(() => '(?, ?, ?)').join(', ');
  const params: string[] = [];
  for (const r of rows) { params.push(r.from, r.to, 'CALLS'); }
  await c.exec(
    `INSERT INTO relation (src, dst, kind) VALUES ${valuesSql} ON CONFLICT (src, dst, kind) DO NOTHING`,
    params,
  );
  const result = await c.query<{ count: number }>(
    "SELECT COUNT(*)::INTEGER AS count FROM relation WHERE kind='CALLS'",
  );
  assert.equal(Number(result[0]!.count), 100);
});

test('delete unresolved by file: scoped removal', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  // Seed three rows: two for fileA, one for fileB
  for (const [id, file] of [['u1', '/a.ts'], ['u2', '/a.ts'], ['u3', '/b.ts']]) {
    await c.exec(
      `INSERT INTO unresolved_relation
         (id, repo, from_entity, from_file, kind, raw_to, meta, attempted_at)
       VALUES (?, '/r', 'e', ?, 'CALLS', 't', '{}', '2026-05-01')`,
      [id, file],
    );
  }
  await c.exec('DELETE FROM unresolved_relation WHERE from_file = ?', ['/a.ts']);
  const rows = await c.query<{ id: string }>(
    'SELECT id FROM unresolved_relation ORDER BY id',
  );
  assert.deepEqual(rows.map(r => r.id), ['u3']);
});

test('delete unresolved by repo: scoped removal', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  for (const [id, repo] of [['u1', '/r1'], ['u2', '/r1'], ['u3', '/r2']]) {
    await c.exec(
      `INSERT INTO unresolved_relation
         (id, repo, from_entity, from_file, kind, raw_to, meta, attempted_at)
       VALUES (?, ?, 'e', '/f', 'CALLS', 't', '{}', '2026-05-01')`,
      [id, repo],
    );
  }
  await c.exec('DELETE FROM unresolved_relation WHERE repo = ?', ['/r1']);
  const rows = await c.query<{ id: string }>(
    'SELECT id FROM unresolved_relation ORDER BY id',
  );
  assert.deepEqual(rows.map(r => r.id), ['u3']);
});

test('promote-to-resolved: relation insert + unresolved delete order', async () => {
  await setupSchema();
  await seedEntities(['e_from', 'e_to']);
  const c = getDuckDBGraphClient();
  await c.exec(
    `INSERT INTO unresolved_relation
       (id, repo, from_entity, from_file, kind, raw_to, meta, attempted_at)
     VALUES ('u1', '/r', 'e_from', '/f', 'CALLS', 't', '{}', '2026-05-01')`,
  );
  // The promoteToResolved sequence: insert resolved edge first, then
  // delete the unresolved row.
  await c.exec(
    'INSERT INTO relation (src, dst, kind) VALUES (?, ?, ?) ON CONFLICT (src, dst, kind) DO NOTHING',
    ['e_from', 'e_to', 'CALLS'],
  );
  await c.exec('DELETE FROM unresolved_relation WHERE id = ?', ['u1']);

  const r = await c.query("SELECT src, dst, kind FROM relation");
  assert.equal(r.length, 1);
  const u = await c.query("SELECT id FROM unresolved_relation");
  assert.equal(u.length, 0);
});

test('update unresolved meta: stamps new meta + attempted_at', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  await c.exec(
    `INSERT INTO unresolved_relation
       (id, repo, from_entity, from_file, kind, raw_to, meta, attempted_at)
     VALUES ('u1', '/r', 'e', '/f', 'CALLS', 't', '{"old":true}', '2026-05-01')`,
  );
  await c.exec(
    'UPDATE unresolved_relation SET meta = ?, attempted_at = ? WHERE id = ?',
    ['{"new":true}', '2026-05-02', 'u1'],
  );
  const rows = await c.query<{ meta: string; attempted_at: string }>(
    'SELECT meta, attempted_at FROM unresolved_relation WHERE id = ?',
    ['u1'],
  );
  assert.equal(rows[0]!.meta, '{"new":true}');
  assert.equal(rows[0]!.attempted_at, '2026-05-02');
});

test('IN-list delete of unresolved ids (the batched promote-to-resolved)', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  for (const id of ['u1', 'u2', 'u3', 'u4']) {
    await c.exec(
      `INSERT INTO unresolved_relation
         (id, repo, from_entity, from_file, kind, raw_to, meta, attempted_at)
       VALUES (?, '/r', 'e', '/f', 'CALLS', 't', '{}', '2026-05-01')`,
      [id],
    );
  }
  const ids = ['u1', 'u3'];
  const placeholders = ids.map(() => '?').join(', ');
  await c.exec(
    `DELETE FROM unresolved_relation WHERE id IN (${placeholders})`,
    ids,
  );
  const remaining = await c.query<{ id: string }>(
    'SELECT id FROM unresolved_relation ORDER BY id',
  );
  assert.deepEqual(remaining.map(r => r.id), ['u2', 'u4']);
});
