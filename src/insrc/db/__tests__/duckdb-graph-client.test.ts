/**
 * Smoke test for the DuckDB GraphClient (Phase A.2).
 *
 * Verifies the client wraps the DuckDB pool correctly: query
 * round-trip, exec round-trip, parameter binding (positional +
 * named), error propagation, idempotent acquisition.
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
  // The pool's lazy-init applies on first connect, but the schema
  // doesn't apply automatically -- callers (initDb in client.ts)
  // own that. Apply it here so query tests have tables.
  await withConnection(async (conn) => applyDuckDBGraphSchema(conn));
}

test('getDuckDBGraphClient returns a stable singleton', () => {
  const a = getDuckDBGraphClient();
  const b = getDuckDBGraphClient();
  assert.equal(a, b);
});

test('exec + query round-trip', async () => {
  await setupSchema();
  const client = getDuckDBGraphClient();
  await client.exec("INSERT INTO entity (id, kind) VALUES ('e1', 'function'), ('e2', 'class')");
  const rows = await client.query<{ id: string; kind: string }>(
    "SELECT id, kind FROM entity ORDER BY id",
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: 'e1', kind: 'function' });
  assert.deepEqual(rows[1], { id: 'e2', kind: 'class' });
});

test('positional parameters bind correctly', async () => {
  await setupSchema();
  const client = getDuckDBGraphClient();
  await client.exec("INSERT INTO entity (id, kind) VALUES (?, ?)", ['e1', 'function']);
  const rows = await client.query<{ id: string }>(
    "SELECT id FROM entity WHERE kind = ?",
    ['function'],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, 'e1');
});

test('named parameters bind correctly', async () => {
  await setupSchema();
  const client = getDuckDBGraphClient();
  await client.exec(
    "INSERT INTO entity (id, kind) VALUES ($id, $kind)",
    { id: 'e1', kind: 'function' },
  );
  const rows = await client.query<{ id: string }>(
    "SELECT id FROM entity WHERE kind = $kind",
    { kind: 'function' },
  );
  assert.equal(rows.length, 1);
});

test('query returns empty array on no matches (not null/undefined)', async () => {
  await setupSchema();
  const client = getDuckDBGraphClient();
  const rows = await client.query("SELECT id FROM entity WHERE id = 'nonexistent'");
  assert.deepEqual(rows, []);
});

test('SQL errors propagate as rejected promises', async () => {
  await setupSchema();
  const client = getDuckDBGraphClient();
  await assert.rejects(
    () => client.query("SELECT * FROM nonexistent_table"),
    /nonexistent_table|catalog/i,
  );
});

test('relation-table round-trip via GraphClient', async () => {
  await setupSchema();
  const client = getDuckDBGraphClient();
  await client.exec("INSERT INTO entity (id, kind) VALUES ('a', 'fn'), ('b', 'fn')");
  await client.exec("INSERT INTO relation (src, dst, kind) VALUES (?, ?, ?)", ['a', 'b', 'CALLS']);
  const rows = await client.query<{ dst: string }>(
    "SELECT dst FROM relation WHERE src = ? AND kind = ?",
    ['a', 'CALLS'],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.dst, 'b');
});
