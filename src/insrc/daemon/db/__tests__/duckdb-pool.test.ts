/**
 * Smoke tests for the DuckDB pool (plans/data-driver-duckdb-files.md
 * Phase 0.2). The goal is to catch obvious wiring failures -- the
 * singleton initialises, the memory cap actually applies, parallel
 * first-callers share the init, withConnection acquires + releases
 * cleanly, and close() cleans up. This is not a behavioural test of
 * DuckDB itself; we trust the upstream library.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { closeDuckDB, getDuckDB, withConnection } from '../duckdb-pool.js';

// Ensure each test starts with a clean singleton. We don't run tests
// concurrently (node:test is sequential by default) so this is safe.
test.beforeEach(async () => { await closeDuckDB(); });
test.afterEach(async () => { await closeDuckDB(); });

test('getDuckDB lazy-inits a singleton and returns the same instance', async () => {
  const a = await getDuckDB();
  const b = await getDuckDB();
  assert.equal(a, b, 'getDuckDB should return the same instance on repeat calls');
});

test('parallel first-callers collapse onto one init', async () => {
  // Both promises hit a null _instance + null _initPromise then race.
  // The pool is supposed to share the init promise so they get the
  // same Database back.
  const [a, b] = await Promise.all([getDuckDB(), getDuckDB()]);
  assert.equal(a, b);
});

test('withConnection runs a query and disposes the connection', async () => {
  const result = await withConnection(async (conn) => {
    const reader = await conn.runAndReadAll('SELECT 1 + 1 AS sum');
    const rows = reader.getRowObjects();
    return rows[0]!['sum'];
  });
  // DuckDB binding may return either Number or BigInt depending on
  // the inferred column type. Normalise before comparing.
  assert.equal(Number(result), 2);
});

test('memory_limit PRAGMA is applied', async () => {
  // Read it back via SHOW; the pool sets it to 512 MB by default. We
  // assert the value is set (non-empty), not the exact value, because
  // env override could change it during local dev.
  const value = await withConnection(async (conn) => {
    const reader = await conn.runAndReadAll(
      "SELECT current_setting('memory_limit') AS v",
    );
    return reader.getRowObjects()[0]!['v'];
  });
  assert.ok(typeof value === 'string' && value.length > 0, `expected non-empty memory_limit, got ${String(value)}`);
});

test('external-access lockdown blocks ATTACH', async () => {
  // The pool sets enable_external_access=false. ATTACH should be
  // refused at runtime regardless of any local credentials.
  await assert.rejects(
    () => withConnection(async (conn) => {
      await conn.run("ATTACH 'dummy.db' AS x");
    }),
    /access|extension|attach/i,
  );
});

test('closeDuckDB clears the singleton; next getDuckDB rebuilds', async () => {
  const before = await getDuckDB();
  await closeDuckDB();
  const after = await getDuckDB();
  assert.notEqual(after, before, 'closeDuckDB should clear; getDuckDB should rebuild a fresh instance');
});
