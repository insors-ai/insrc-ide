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

test('file-backed HNSW: CREATE INDEX works on a fresh connection after init', async () => {
  // Regression for a daemon-startup crash: SET <flag> was connection-
  // scoped, so the persistence flag set during init died with the init
  // connection. The next CREATE INDEX (via the GraphClient -> a fresh
  // Connection from withStorageConnection) hit "HNSW indexes can only
  // be created in in-memory databases, or when the configuration
  // option 'hnsw_enable_experimental_persistence' is set to true."
  //
  // The :memory: smoke test above does NOT catch this because :memory:
  // is the OTHER condition that satisfies HNSW's check; the failure
  // mode is file-backed-specific.
  const tmp = mkdtempSync(join(tmpdir(), 'insrc-storage-pool-hnsw-'));
  const path = join(tmp, 'duckdb.db');
  try {
    setStorageDuckDBPath(path);
    await closeDuckDBStorage();

    // Force pool init + close. Subsequent withStorageConnection calls
    // get fresh connections that must still see the persistence flag.
    await withStorageConnection(async (conn) => {
      await conn.run('SELECT 1');
    });

    await withStorageConnection(async (conn) => {
      await conn.run('CREATE TABLE hnsw_test (id INTEGER, embedding FLOAT[3])');
      await conn.run(
        "CREATE INDEX idx_hnsw_test ON hnsw_test USING HNSW (embedding) WITH (metric = 'cosine')",
      );
      await conn.run(
        "INSERT INTO hnsw_test VALUES (1, [1.0, 0.0, 0.0]::FLOAT[3]), (2, [0.0, 1.0, 0.0]::FLOAT[3])",
      );
      const reader = await conn.runAndReadAll(
        "SELECT id FROM hnsw_test ORDER BY array_distance(embedding, [1.0, 0.0, 0.0]::FLOAT[3]) LIMIT 1",
      );
      assert.equal(Number(reader.getRowObjects()[0]!['id']), 1);
    });
  } finally {
    await closeDuckDBStorage();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
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
