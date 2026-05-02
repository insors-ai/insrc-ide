/**
 * Smoke tests for the DuckDB storage pool (Phase B persistence
 * layer). The goal is to catch obvious wiring failures: singleton
 * initialises against the right backing path, file persistence works
 * across close/reopen cycles, the vss extension actually loaded so
 * HNSW indexes can be created, withStorageConnection cleans up after
 * itself.
 *
 * Tests use `:memory:` paths via `setStorageDuckDBPath` so they don't
 * touch the user's `~/.insrc/duckdb.db`. The persistence test uses a
 * tmp-file path so we can prove the file-backed mode actually
 * persists across close.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  closeDuckDBStorage,
  getDuckDBStorage,
  setStorageDuckDBPath,
  withStorageConnection,
} from '../duckdb-storage-pool.js';

test.beforeEach(async () => {
  setStorageDuckDBPath(':memory:');
  await closeDuckDBStorage();
});
test.afterEach(async () => { await closeDuckDBStorage(); });

test('getDuckDBStorage lazy-inits a singleton and returns the same instance', async () => {
  const a = await getDuckDBStorage();
  const b = await getDuckDBStorage();
  assert.equal(a, b, 'getDuckDBStorage should return the same instance on repeat calls');
});

test('withStorageConnection runs a query and disposes the connection', async () => {
  const result = await withStorageConnection(async (conn) => {
    const reader = await conn.runAndReadAll('SELECT 1 + 1 AS sum');
    return reader.getRowObjects()[0]!['sum'];
  });
  assert.equal(Number(result), 2);
});

test('vss extension loaded on the storage pool; HNSW + array_distance both work', async () => {
  // Phase B.1/B.3 prerequisite: the vector tables in the daemon's
  // schema need HNSW indexes. If vss didn't load on the storage
  // pool, CREATE INDEX ... USING HNSW raises "Unknown index type:
  // HNSW" -- this test catches that wiring failure separately from
  // any specific schema apply.
  await withStorageConnection(async (conn) => {
    await conn.run('CREATE TABLE vss_smoke (id INTEGER, embedding FLOAT[3])');
    await conn.run(
      "INSERT INTO vss_smoke VALUES (1, [1.0, 0.0, 0.0]::FLOAT[3]), (2, [0.0, 1.0, 0.0]::FLOAT[3]), (3, [0.5, 0.5, 0.0]::FLOAT[3])",
    );
    await conn.run(
      "CREATE INDEX idx_vss_smoke ON vss_smoke USING HNSW (embedding) WITH (metric = 'cosine')",
    );
    const reader = await conn.runAndReadAll(
      "SELECT id FROM vss_smoke ORDER BY array_distance(embedding, [1.0, 0.0, 0.0]::FLOAT[3]) LIMIT 1",
    );
    assert.equal(Number(reader.getRowObjects()[0]!['id']), 1);
  });
});

test('file-backed mode persists data across close/reopen', async () => {
  // The whole point of this pool: state survives daemon restart.
  // Write a row, close the singleton, reopen, read the row back.
  const tmp = mkdtempSync(join(tmpdir(), 'insrc-storage-pool-'));
  const path = join(tmp, 'duckdb.db');
  try {
    setStorageDuckDBPath(path);
    await closeDuckDBStorage();

    await withStorageConnection(async (conn) => {
      await conn.run('CREATE TABLE persisted (id INTEGER, label VARCHAR)');
      await conn.run("INSERT INTO persisted VALUES (1, 'before-restart')");
    });

    // Simulate daemon restart -- close the singleton, then re-init
    // (path still points at the same tmp file).
    await closeDuckDBStorage();

    const rows = await withStorageConnection(async (conn) => {
      const reader = await conn.runAndReadAll('SELECT id, label FROM persisted');
      return reader.getRowObjects();
    });
    assert.equal(rows.length, 1, 'row should survive close/reopen');
    assert.equal(rows[0]!['label'], 'before-restart');
  } finally {
    await closeDuckDBStorage();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('external-access lockdown blocks ATTACH on the storage pool', async () => {
  await assert.rejects(
    () => withStorageConnection(async (conn) => {
      await conn.run("ATTACH 'dummy.db' AS x");
    }),
    /access|extension|attach/i,
  );
});
