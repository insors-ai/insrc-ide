/**
 * Dual-write repo-registry round-trip on the DuckDB side (Phase A.5).
 *
 * Exercises the three SQL patterns the repos.ts dual-write path uses:
 *   - addRepo: INSERT ... ON CONFLICT DO UPDATE
 *   - removeRepo: DELETE
 *   - updateRepoStatus: UPDATE WHERE id = ?
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

test('addRepo: insert when absent', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  await c.exec(
    `INSERT INTO repo (id, path, name, added_at, last_indexed, status, error_msg)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       path = excluded.path,
       name = excluded.name,
       added_at = excluded.added_at,
       last_indexed = excluded.last_indexed,
       status = excluded.status,
       error_msg = excluded.error_msg`,
    ['/r1', '/r1', 'r1', '2026-05-02', '', 'pending', ''],
  );
  const rows = await c.query<{
    id: string; path: string; name: string; status: string;
  }>('SELECT id, path, name, status FROM repo');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { id: '/r1', path: '/r1', name: 'r1', status: 'pending' });
});

test('addRepo: upsert overwrites existing fields', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  // Initial insert
  await c.exec(
    `INSERT INTO repo (id, path, name, added_at, last_indexed, status, error_msg)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       path = excluded.path,
       name = excluded.name,
       added_at = excluded.added_at,
       last_indexed = excluded.last_indexed,
       status = excluded.status,
       error_msg = excluded.error_msg`,
    ['/r1', '/r1', 'old-name', '2026-05-02', '', 'pending', ''],
  );
  // Re-add with new name and status
  await c.exec(
    `INSERT INTO repo (id, path, name, added_at, last_indexed, status, error_msg)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       path = excluded.path,
       name = excluded.name,
       added_at = excluded.added_at,
       last_indexed = excluded.last_indexed,
       status = excluded.status,
       error_msg = excluded.error_msg`,
    ['/r1', '/r1', 'new-name', '2026-05-02', '2026-05-02T10:00', 'ready', ''],
  );
  const rows = await c.query<{ name: string; status: string; last_indexed: string }>(
    'SELECT name, status, last_indexed FROM repo',
  );
  assert.equal(rows.length, 1, 'upsert must not duplicate');
  assert.equal(rows[0]!.name, 'new-name');
  assert.equal(rows[0]!.status, 'ready');
  assert.equal(rows[0]!.last_indexed, '2026-05-02T10:00');
});

test('removeRepo: deletes the registry row', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  await c.exec(
    `INSERT INTO repo (id, path, name, added_at, last_indexed, status, error_msg)
     VALUES ('/r1', '/r1', 'r1', '2026-05-02', '', 'pending', '')`,
  );
  await c.exec(
    `INSERT INTO repo (id, path, name, added_at, last_indexed, status, error_msg)
     VALUES ('/r2', '/r2', 'r2', '2026-05-02', '', 'pending', '')`,
  );
  await c.exec('DELETE FROM repo WHERE id = ?', ['/r1']);
  const rows = await c.query<{ id: string }>('SELECT id FROM repo ORDER BY id');
  assert.deepEqual(rows.map(r => r.id), ['/r2']);
});

test('removeRepo on missing path: idempotent (no error)', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  await c.exec('DELETE FROM repo WHERE id = ?', ['/nonexistent']);
  const rows = await c.query('SELECT * FROM repo');
  assert.equal(rows.length, 0);
});

test('updateRepoStatus: status / last_indexed / error_msg all update', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  await c.exec(
    `INSERT INTO repo (id, path, name, added_at, last_indexed, status, error_msg)
     VALUES ('/r1', '/r1', 'r1', '2026-05-02', '', 'pending', '')`,
  );
  await c.exec(
    'UPDATE repo SET status = ?, last_indexed = ?, error_msg = ? WHERE id = ?',
    ['error', '2026-05-02T11:00', 'something failed', '/r1'],
  );
  const rows = await c.query<{ status: string; last_indexed: string; error_msg: string }>(
    'SELECT status, last_indexed, error_msg FROM repo WHERE id = ?',
    ['/r1'],
  );
  assert.equal(rows[0]!.status, 'error');
  assert.equal(rows[0]!.last_indexed, '2026-05-02T11:00');
  assert.equal(rows[0]!.error_msg, 'something failed');
});

test('updateRepoStatus on missing path: no-op (no rows updated, no error)', async () => {
  await setupSchema();
  const c = getDuckDBGraphClient();
  // Cypher's MATCH ... SET is also a no-op on missing nodes; replicate.
  await c.exec(
    'UPDATE repo SET status = ?, last_indexed = ?, error_msg = ? WHERE id = ?',
    ['ready', '', '', '/nonexistent'],
  );
  // Confirm the table is still empty rather than the missing row being created.
  const rows = await c.query('SELECT * FROM repo');
  assert.equal(rows.length, 0);
});
