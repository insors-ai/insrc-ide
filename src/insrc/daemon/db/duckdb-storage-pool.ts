/**
 * DuckDB process-wide singleton -- the FILE-BACKED storage engine.
 *
 * plans/storage-migration-duckdb.md Phase B (the persistence layer
 * for the post-Kuzu / post-Lance world).
 *
 * **Scope.** This singleton is the *storage layer* for everything
 * that needs to survive a daemon restart:
 *   - Code knowledge graph (entity / relation / repo / unresolved /
 *     plan / plan_step) -- moved here from Kuzu in Phase A
 *   - Entity bodies + embeddings -- moved here from Lance in Phase B
 *   - Conversation history (sessions + turns) -- ditto
 *   - Config-store entries -- ditto
 *   - TODO framework (lists / items / comments) -- ditto
 *
 * Backed by `~/.insrc/duckdb.db`. The file is created on first boot
 * and grows as state accumulates. DuckDB's MVCC + WAL handles
 * crash-consistency; no manual checkpointing required.
 *
 * **NOT for query-engine attaches.** The data-driver / `db_file_aggregate`
 * use case attaches CSV / JSON / Parquet files at query time and
 * doesn't want them living in the storage DB. That work goes through
 * `duckdb-pool.ts` (in-memory). Picking the wrong pool will either
 * lose data on restart (storage workload on the in-memory pool) or
 * pollute the storage file with single-use attaches (driver workload
 * on the storage pool).
 *
 * Lifecycle: lazy-init singleton, daemon-lifetime. The first call to
 * `getDuckDBStorage()` opens the file-backed instance, sets the
 * memory cap, loads the `arrow` + `vss` extensions, locks down
 * external access. Subsequent calls share the instance; concurrent
 * first-callers collapse onto the same init promise. Closed in the
 * daemon's graceful-shutdown handler.
 *
 * Per-query: `withStorageConnection<T>(fn)` is the canonical entry
 * point. Mirror of `withConnection` in the query-pool: fresh
 * Connection per call, sub-millisecond acquire, closed on return.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { getLogger } from '../../shared/logger.js';
import { PATHS } from '../../shared/paths.js';

const log = getLogger('duckdb-storage-pool');

// 2 GB default. The storage pool needs more headroom than the query
// engine because:
//   - DuckDB's block manager preallocates buffer-pool space on the
//     first FLOAT[N] CREATE TABLE; with N=2560 (qwen3-embedding) the
//     entity table alone wants ~350 MB at table-creation time.
//   - The HNSW index implementation keeps the search graph in-memory
//     for fast ANN.
//   - hadoop-12k stress-tests at ~700 MB working set for the graph
//     side alone, before vectors land.
// 2 GB absorbs both of these and matches the post-Kuzu +
// post-Lance budget in plans/storage-migration-duckdb.md Phase C.
// Bumpable via INSRC_DUCKDB_STORAGE_MEMORY_MB.
const DEFAULT_MEMORY_MB = 2048;

let _instance: DuckDBInstance | null = null;
let _initPromise: Promise<DuckDBInstance> | null = null;

/**
 * Backing-file path for the singleton. Tests override this via
 * `setStorageDuckDBPath(':memory:' or a tmpdir-relative path)` so
 * each test starts with a fresh, stateless DB without touching the
 * user's `~/.insrc/duckdb.db`.
 */
let _path: string = PATHS.duckdb;

/**
 * Override the backing file path. ONLY for tests -- production code
 * should never call this. Must be called BEFORE the first
 * `getDuckDBStorage()` of the test, otherwise the singleton is
 * already pinned to the old path. Pair with `closeDuckDBStorage()` in
 * test setup/teardown.
 */
export function setStorageDuckDBPath(path: string): void {
  _path = path;
}

/**
 * Lazy-init the daemon-wide storage DuckDB singleton. Concurrent
 * first-callers share the same init promise so the Database is
 * created exactly once even when two callsites hit
 * `getDuckDBStorage()` in parallel on a cold daemon.
 *
 * On init failure the cached promise is cleared so the next caller
 * re-attempts (avoids permanently-rejected-promise reuse).
 */
export async function getDuckDBStorage(): Promise<DuckDBInstance> {
  if (_instance !== null) return _instance;
  if (_initPromise !== null) return _initPromise;

  _initPromise = (async (): Promise<DuckDBInstance> => {
    const t0 = Date.now();
    const memoryMb = readMemoryBudget();

    // Ensure the parent directory exists -- the daemon usually
    // creates `~/.insrc/` elsewhere, but tests passing tmpdir paths
    // may not have done so yet, and a `:memory:` path is a no-op.
    if (_path !== ':memory:') {
      const parent = dirname(_path);
      if (!existsSync(parent)) {
        mkdirSync(parent, { recursive: true });
      }
    }

    const instance = await DuckDBInstance.create(_path);
    const conn = await instance.connect();
    try {
      await conn.run(`SET memory_limit = '${memoryMb}MB'`);
      // Load `arrow` first (Arrow IPC reads, used by data-driver
      // pipelines that flow Arrow record batches through the storage
      // layer). Best-effort; missing extension non-fatal at startup.
      try {
        await conn.run('INSTALL arrow');
        await conn.run('LOAD arrow');
      } catch (e) {
        log.warn(
          { err: errMessage(e) },
          'arrow extension unavailable on storage pool; arrow-IPC writers may fail until installed',
        );
      }
      // VSS is the HNSW vector-index extension. Core extension as of
      // DuckDB 1.4 (was community before), so plain `INSTALL vss`
      // suffices. The experimental-persistence flag MUST be GLOBAL --
      // file-backed databases reject HNSW index creation without it,
      // and `SET <flag>` (without GLOBAL) is connection-scoped, so it
      // would die when this init connection closes and any subsequent
      // CREATE INDEX (initDb, schema apply, etc.) would error with
      // "HNSW indexes can only be created in in-memory databases, or
      // when the configuration option ... is set to true."
      try {
        await conn.run('INSTALL vss');
        await conn.run('LOAD vss');
        await conn.run('SET GLOBAL hnsw_enable_experimental_persistence = true');
      } catch (e) {
        log.warn(
          { err: errMessage(e) },
          'vss extension unavailable; vector queries will fall back to brute-force array_distance scans',
        );
      }
      // Lock down ATTACH / httpfs / load_extension / further INSTALL
      // at runtime. The storage pool is for the daemon's own state;
      // user-supplied SQL must not be able to escape it.
      await conn.run('SET enable_external_access = false');
    } finally {
      conn.disconnectSync();
    }
    log.info(
      { initMs: Date.now() - t0, memoryMb, path: _path },
      'duckdb storage singleton initialised',
    );
    _instance = instance;
    return instance;
  })();

  try {
    return await _initPromise;
  } catch (e) {
    _initPromise = null;
    throw e;
  }
}

/**
 * Close the storage singleton. Called by the daemon's graceful-
 * shutdown handler. DuckDB flushes the WAL on close; errors during
 * close are logged but not re-thrown (the daemon is on the way down).
 */
export async function closeDuckDBStorage(): Promise<void> {
  const inst = _instance;
  _instance = null;
  _initPromise = null;
  if (inst === null) return;
  try {
    inst.closeSync();
  } catch (e) {
    log.warn({ err: errMessage(e) }, 'duckdb storage close failed');
  }
}

/**
 * Acquire a fresh Connection on the storage instance, run `fn`, close
 * the Connection. Mirror of `withConnection` for the query pool:
 * fresh Connection per call, sub-millisecond acquire, closed on
 * return. Every storage callsite (graph client, entities, conversations,
 * config-store, todos) goes through this helper.
 */
export async function withStorageConnection<T>(
  fn: (conn: DuckDBConnection) => Promise<T>,
): Promise<T> {
  const instance = await getDuckDBStorage();
  const conn = await instance.connect();
  try {
    return await fn(conn);
  } finally {
    conn.disconnectSync();
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function readMemoryBudget(): number {
  const raw = process.env['INSRC_DUCKDB_STORAGE_MEMORY_MB'];
  if (raw === undefined || raw.length === 0) return DEFAULT_MEMORY_MB;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 64) {
    log.warn(
      { raw },
      'INSRC_DUCKDB_STORAGE_MEMORY_MB invalid; falling back to default',
    );
    return DEFAULT_MEMORY_MB;
  }
  return parsed;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
