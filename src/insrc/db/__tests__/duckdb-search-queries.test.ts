/**
 * DuckDB-side read queries for search.ts (Phase A.6).
 *
 * Validates the SQL patterns that replace Kuzu Cypher:
 *
 *   1-hop neighbour lookups (findCallers / findCallees / findDefinedIn /
 *   findImports collapse to one neighborIds helper) -- forward and
 *   reverse direction; index-served via idx_relation_fwd / idx_relation_rev.
 *
 *   resolveClosure: recursive CTE walking DEPENDS_ON up to depth 10,
 *   matching Kuzu's `*0..10` semantics. Includes the root + cycle handling
 *   via SELECT DISTINCT.
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
    await c.exec("INSERT INTO entity (id, kind) VALUES (?, 'fn')", [id]);
  }
}

test('1-hop outbound: SELECT dst WHERE src = ? AND kind = ?', async () => {
  await setupSchema();
  await seedEntities(['a', 'b', 'c', 'd']);
  const c = getDuckDBGraphClient();
  await c.exec("INSERT INTO relation (src, dst, kind) VALUES ('a','b','CALLS'),('a','c','CALLS'),('a','d','IMPORTS')");
  // findCallees('a') -- should see b and c (CALLS only, not d which is IMPORTS)
  const rows = await c.query<{ id: string }>(
    'SELECT dst AS id FROM relation WHERE src = ? AND kind = ?',
    ['a', 'CALLS'],
  );
  const ids = rows.map(r => r.id).sort();
  assert.deepEqual(ids, ['b', 'c']);
});

test('1-hop inbound: SELECT src WHERE dst = ? AND kind = ?', async () => {
  await setupSchema();
  await seedEntities(['a', 'b', 'c']);
  const c = getDuckDBGraphClient();
  await c.exec("INSERT INTO relation (src, dst, kind) VALUES ('a','c','CALLS'),('b','c','CALLS')");
  // findCallers('c') -- should see a and b
  const rows = await c.query<{ id: string }>(
    'SELECT src AS id FROM relation WHERE dst = ? AND kind = ?',
    ['c', 'CALLS'],
  );
  const ids = rows.map(r => r.id).sort();
  assert.deepEqual(ids, ['a', 'b']);
});

test('1-hop with no matches: empty array', async () => {
  await setupSchema();
  await seedEntities(['a']);
  const c = getDuckDBGraphClient();
  const rows = await c.query<{ id: string }>(
    'SELECT dst AS id FROM relation WHERE src = ? AND kind = ?',
    ['a', 'CALLS'],
  );
  assert.deepEqual(rows, []);
});

test('1-hop kind filter: only matching edges returned', async () => {
  await setupSchema();
  await seedEntities(['file', 'fn1', 'fn2', 'cls1']);
  const c = getDuckDBGraphClient();
  // file DEFINES fn1, fn2, cls1; file IMPORTS something else
  await c.exec(`
    INSERT INTO relation (src, dst, kind) VALUES
      ('file', 'fn1', 'DEFINES'),
      ('file', 'fn2', 'DEFINES'),
      ('file', 'cls1', 'DEFINES'),
      ('file', 'somemodule', 'IMPORTS')
  `);
  // findDefinedIn('file') -- should see fn1, fn2, cls1 (not somemodule)
  const rows = await c.query<{ id: string }>(
    'SELECT dst AS id FROM relation WHERE src = ? AND kind = ?',
    ['file', 'DEFINES'],
  );
  const ids = rows.map(r => r.id).sort();
  assert.deepEqual(ids, ['cls1', 'fn1', 'fn2']);
});

test('resolveClosure: includes root even with no DEPENDS_ON edges', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  // The recursive CTE itself includes the root (depth 0).
  const rows = await c.query<{ id: string }>(
    `WITH RECURSIVE closure(id, depth) AS (
       SELECT ?, 0
       UNION ALL
       SELECT r.dst, c.depth + 1
       FROM closure c
       JOIN relation r ON r.src = c.id
       WHERE r.kind = 'DEPENDS_ON' AND c.depth < ?
     )
     SELECT DISTINCT id FROM closure WHERE id IS NOT NULL`,
    ['/root-repo', 10],
  );
  assert.deepEqual(rows.map(r => r.id), ['/root-repo']);
});

test('resolveClosure: walks transitive DEPENDS_ON', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  // Build: /a -> /b -> /c -> /d  (linear chain)
  await c.exec(`
    INSERT INTO relation (src, dst, kind) VALUES
      ('/a', '/b', 'DEPENDS_ON'),
      ('/b', '/c', 'DEPENDS_ON'),
      ('/c', '/d', 'DEPENDS_ON')
  `);
  const rows = await c.query<{ id: string }>(
    `WITH RECURSIVE closure(id, depth) AS (
       SELECT ?, 0
       UNION ALL
       SELECT r.dst, c.depth + 1
       FROM closure c
       JOIN relation r ON r.src = c.id
       WHERE r.kind = 'DEPENDS_ON' AND c.depth < ?
     )
     SELECT DISTINCT id FROM closure WHERE id IS NOT NULL`,
    ['/a', 10],
  );
  const ids = rows.map(r => r.id).sort();
  assert.deepEqual(ids, ['/a', '/b', '/c', '/d']);
});

test('resolveClosure: handles cycles via DISTINCT', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  // Cycle: /a -> /b -> /a
  await c.exec(`
    INSERT INTO relation (src, dst, kind) VALUES
      ('/a', '/b', 'DEPENDS_ON'),
      ('/b', '/a', 'DEPENDS_ON')
  `);
  const rows = await c.query<{ id: string }>(
    `WITH RECURSIVE closure(id, depth) AS (
       SELECT ?, 0
       UNION ALL
       SELECT r.dst, c.depth + 1
       FROM closure c
       JOIN relation r ON r.src = c.id
       WHERE r.kind = 'DEPENDS_ON' AND c.depth < ?
     )
     SELECT DISTINCT id FROM closure WHERE id IS NOT NULL`,
    ['/a', 10],
  );
  const ids = rows.map(r => r.id).sort();
  // Both /a and /b appear; DISTINCT collapses revisits even though the
  // recursive walk reaches them at depths 0/2/4/... and 1/3/5/...
  assert.deepEqual(ids, ['/a', '/b']);
});

test('resolveClosure: depth cap honoured at 10', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  // Build a 12-deep chain: /r0 -> /r1 -> ... -> /r12
  for (let i = 0; i < 12; i++) {
    await c.exec(
      `INSERT INTO relation (src, dst, kind) VALUES (?, ?, 'DEPENDS_ON')`,
      [`/r${i}`, `/r${i + 1}`],
    );
  }
  const rows = await c.query<{ id: string }>(
    `WITH RECURSIVE closure(id, depth) AS (
       SELECT ?, 0
       UNION ALL
       SELECT r.dst, c.depth + 1
       FROM closure c
       JOIN relation r ON r.src = c.id
       WHERE r.kind = 'DEPENDS_ON' AND c.depth < ?
     )
     SELECT DISTINCT id FROM closure WHERE id IS NOT NULL`,
    ['/r0', 10],
  );
  const ids = rows.map(r => r.id);
  // Should reach /r0 through /r10 (11 nodes); /r11 and /r12 are past the cap.
  // Note: depth < 10 means the recursive step fires up to 10 times,
  // producing edges of depth 1..10, so destination ids /r1../r10 plus
  // the root /r0 = 11 ids.
  assert.equal(ids.length, 11);
  assert.ok(ids.includes('/r0'));
  assert.ok(ids.includes('/r10'));
  assert.ok(!ids.includes('/r11'));
  assert.ok(!ids.includes('/r12'));
});

test('resolveClosure: ignores edges of other kinds', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  // /a CALLS /b and /a IMPORTS /c -- neither is DEPENDS_ON, so should
  // not contribute to closure of /a.
  await c.exec(`
    INSERT INTO relation (src, dst, kind) VALUES
      ('/a', '/b', 'CALLS'),
      ('/a', '/c', 'IMPORTS')
  `);
  const rows = await c.query<{ id: string }>(
    `WITH RECURSIVE closure(id, depth) AS (
       SELECT ?, 0
       UNION ALL
       SELECT r.dst, c.depth + 1
       FROM closure c
       JOIN relation r ON r.src = c.id
       WHERE r.kind = 'DEPENDS_ON' AND c.depth < ?
     )
     SELECT DISTINCT id FROM closure WHERE id IS NOT NULL`,
    ['/a', 10],
  );
  assert.deepEqual(rows.map(r => r.id), ['/a']);
});
