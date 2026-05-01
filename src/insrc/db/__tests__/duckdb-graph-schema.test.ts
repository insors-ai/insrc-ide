/**
 * Smoke test for the DuckDB graph schema (Phase A.1).
 *
 * Verifies the DDL applies cleanly to a fresh DuckDB connection,
 * creates the expected tables + indexes, and is idempotent
 * (applying twice doesn't throw).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  closeDuckDB,
  withConnection,
} from '../../daemon/db/duckdb-pool.js';
import {
  DUCKDB_GRAPH_STATEMENTS,
  applyDuckDBGraphSchema,
} from '../duckdb-graph-schema.js';

test.beforeEach(async () => { await closeDuckDB(); });
test.afterEach(async () => { await closeDuckDB(); });

const EXPECTED_TABLES = [
  'entity',
  'repo',
  'relation',
  'unresolved_relation',
  'plan',
  'plan_step',
];

test('applyDuckDBGraphSchema creates every expected table', async () => {
  await withConnection(async (conn) => {
    await applyDuckDBGraphSchema(conn);
    const reader = await conn.runAndReadAll(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='main' ORDER BY table_name",
    );
    const tables = reader.getRowObjects().map(r => r['table_name']);
    for (const expected of EXPECTED_TABLES) {
      assert.ok(
        tables.includes(expected),
        `expected table '${expected}' to exist; got [${tables.join(', ')}]`,
      );
    }
  });
});

test('applyDuckDBGraphSchema is idempotent', async () => {
  await withConnection(async (conn) => {
    await applyDuckDBGraphSchema(conn);
    // Second application must not throw -- daemon restart applies on
    // every cold start; non-idempotent DDL would break that.
    await applyDuckDBGraphSchema(conn);
  });
});

test('relation table is keyed (src, dst, kind)', async () => {
  await withConnection(async (conn) => {
    await applyDuckDBGraphSchema(conn);
    // Insert one edge; second insert with same (src, dst, kind)
    // should fail under the primary-key constraint, but inserts
    // with a different kind for the same src/dst should succeed.
    await conn.run("INSERT INTO entity (id, kind) VALUES ('a', 'function'), ('b', 'function')");
    await conn.run("INSERT INTO relation (src, dst, kind) VALUES ('a', 'b', 'CALLS')");
    await conn.run("INSERT INTO relation (src, dst, kind) VALUES ('a', 'b', 'IMPORTS')");

    await assert.rejects(
      () => conn.run("INSERT INTO relation (src, dst, kind) VALUES ('a', 'b', 'CALLS')"),
      /constraint|duplicate|primary key/i,
      'duplicate (src, dst, kind) should violate primary key',
    );

    const reader = await conn.runAndReadAll(
      "SELECT COUNT(*)::INTEGER AS n FROM relation WHERE src='a' AND dst='b'",
    );
    assert.equal(Number(reader.getRowObjects()[0]!['n']), 2, 'should have two edges (CALLS + IMPORTS)');
  });
});

test('forward index makes 1-hop traversal index-served', async () => {
  // Sanity-check the index exists; we don't assert plan-level usage
  // (DuckDB's planner decides per query), just that the index is
  // declared and queryable.
  await withConnection(async (conn) => {
    await applyDuckDBGraphSchema(conn);
    const reader = await conn.runAndReadAll(
      "SELECT index_name FROM duckdb_indexes() WHERE table_name='relation'",
    );
    const indexes = reader.getRowObjects().map(r => r['index_name']);
    assert.ok(indexes.includes('idx_relation_fwd'), `missing idx_relation_fwd; got [${indexes.join(', ')}]`);
    assert.ok(indexes.includes('idx_relation_rev'), `missing idx_relation_rev; got [${indexes.join(', ')}]`);
  });
});

test('plan graph tables accept plan + step + CONTAINS edge', async () => {
  await withConnection(async (conn) => {
    await applyDuckDBGraphSchema(conn);
    await conn.run(`
      INSERT INTO plan (id, repo_path, title, status, created_at, updated_at)
      VALUES ('p1', '/tmp/repo', 'Test plan', 'pending', '2026-05-01', '2026-05-01')
    `);
    await conn.run(`
      INSERT INTO plan_step (id, plan_id, idx, title, status, created_at, updated_at)
      VALUES ('s1', 'p1', 0, 'First step', 'pending', '2026-05-01', '2026-05-01')
    `);
    await conn.run("INSERT INTO relation (src, dst, kind) VALUES ('p1', 's1', 'CONTAINS')");

    // Listing a plan's steps via the same `relation` table that holds
    // entity edges -- one query path for both kinds of edge.
    const reader = await conn.runAndReadAll(`
      SELECT ps.id, ps.title
      FROM relation r
      JOIN plan_step ps ON ps.id = r.dst
      WHERE r.src = 'p1' AND r.kind = 'CONTAINS'
      ORDER BY ps.idx
    `);
    const rows = reader.getRowObjects();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!['id'], 's1');
    assert.equal(rows[0]!['title'], 'First step');
  });
});

test('all DDL statements produce a unique table or index name', async () => {
  // Catches accidental duplicate DDL during plan iteration.
  const names: string[] = [];
  for (const stmt of DUCKDB_GRAPH_STATEMENTS) {
    const m = stmt.match(/CREATE\s+(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
    if (m !== null) names.push(m[1]!);
  }
  const seen = new Set<string>();
  for (const name of names) {
    assert.ok(!seen.has(name), `duplicate DDL target name '${name}'`);
    seen.add(name);
  }
  assert.ok(names.length >= EXPECTED_TABLES.length, 'unexpectedly few DDL statements');
});
