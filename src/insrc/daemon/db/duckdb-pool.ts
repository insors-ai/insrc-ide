/**
 * DuckDB process-wide singleton + per-query connection handle.
 *
 * Plans/data-driver-duckdb-files.md Phase 0.2.
 *
 * Lifecycle: lazy-init singleton, daemon-lifetime. The first call to
 * `getDuckDB()` opens an in-memory DuckDB instance, sets the memory
 * cap (`PRAGMA memory_limit`), locks down extension installs, and
 * loads the `arrow` extension for `.arrow` IPC reads. Subsequent
 * calls share the instance; concurrent first-callers collapse onto
 * the same init promise via `_initPromise`. Closed in the daemon's
 * graceful-shutdown handler alongside Kuzu / LanceDB.
 *
 * Per-query: `withConnection<T>(fn)` is the canonical entry point.
 * DuckDB Connections are sub-millisecond; we acquire a fresh one per
 * query for isolation + per-query cancel and close it before the
 * helper returns.
 *
 * Memory: the `memory_limit` PRAGMA is a per-query CAP, not a
 * reservation. Idle resident size is ~50-100 MB (prepared-statement
 * cache + extension binaries); under-load usage scales up to the
 * cap. The 512 MB default sits within the daemon's overall budget
 * alongside Kuzu (1 GB pool) + Ollama (~3 GB resident) + Node
 * (4-8 GB during indexing). Bumpable via `~/.insrc/config.json`
 * `duckdb.memoryMb` (handled by the loader; this module just reads
 * the resolved value).
 */

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('duckdb-pool');

// 512 MB default per the plan's memory-budget table. Configurable via
// daemon settings (`duckdb.memoryMb`); env-var override (`INSRC_DUCKDB_MEMORY_MB`)
// is provided as an escape hatch for ops scenarios without a config push.
const DEFAULT_MEMORY_MB = 512;

let _instance: DuckDBInstance | null = null;
let _initPromise: Promise<DuckDBInstance> | null = null;

/**
 * Lazy-init the daemon-wide DuckDB singleton. Concurrent first-callers
 * share the same init promise so the Database is created exactly once
 * even when two skills hit `getDuckDB()` in parallel on a cold daemon.
 *
 * On init failure the cached promise is cleared so the next caller
 * re-attempts (avoids permanently-rejected-promise reuse). Production
 * callers should not need to inspect the failure -- the underlying
 * driver / converter surfaces the SQL error from the first query
 * after a failed init.
 */
export async function getDuckDB(): Promise<DuckDBInstance> {
  if (_instance !== null) return _instance;
  if (_initPromise !== null) return _initPromise;

  _initPromise = (async (): Promise<DuckDBInstance> => {
    const t0 = Date.now();
    const memoryMb = readMemoryBudget();
    // `:memory:` ensures no on-disk DuckDB state is created. The Parquet
    // cache (Phase 3) is a separate, file-backed concern.
    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();
    try {
      // Per-query buffer-pool cap. Sized in the plan; user can override.
      await conn.run(`SET memory_limit = '${memoryMb}MB'`);
      // Load the `arrow` extension FIRST -- INSTALL touches the
      // filesystem (downloads / unpacks the .duckdb_extension binary),
      // which the lockdown below would block. Best-effort: missing
      // extension is non-fatal at startup; .arrow file connections
      // will surface the failure on first query.
      try {
        await conn.run('INSTALL arrow');
        await conn.run('LOAD arrow');
      } catch (e) {
        log.warn(
          { err: errMessage(e) },
          'arrow extension unavailable; .arrow file connections will fail to read until installed',
        );
      }
      // Now that approved extensions are loaded, block ATTACH /
      // httpfs / load_extension / further INSTALL at runtime. Only
      // the extensions loaded above are usable from here on.
      await conn.run('SET enable_external_access = false');
    } finally {
      conn.disconnectSync();
    }
    log.info({ initMs: Date.now() - t0, memoryMb }, 'duckdb singleton initialised');
    _instance = instance;
    return instance;
  })();

  try {
    return await _initPromise;
  } catch (e) {
    // Clear the cached promise so the next caller can retry instead
    // of awaiting a permanently-rejected promise.
    _initPromise = null;
    throw e;
  }
}

/**
 * Close the singleton. Called by the daemon's graceful-shutdown
 * handler alongside Kuzu / LanceDB. DuckDB has no on-disk state to
 * flush (the Parquet cache is a build artifact, not a write target),
 * so this is fast. Errors during close are logged but not re-thrown
 * -- the daemon is on the way down anyway.
 */
export async function closeDuckDB(): Promise<void> {
  const inst = _instance;
  _instance = null;
  _initPromise = null;
  if (inst === null) return;
  try {
    inst.closeSync();
  } catch (e) {
    log.warn({ err: errMessage(e) }, 'duckdb close failed');
  }
}

/**
 * Acquire a fresh Connection, run `fn` against it, close the
 * Connection. The canonical entry point for any DuckDB usage in the
 * daemon: file-driver reads, converter writes, the
 * `db_file_aggregate` tool. Every callsite goes through this helper
 * so query isolation + cleanup stay consistent.
 *
 * Connections are cheap (sub-millisecond). The Database singleton is
 * shared; only the per-call Connection state lives inside `fn`.
 */
export async function withConnection<T>(
  fn: (conn: DuckDBConnection) => Promise<T>,
): Promise<T> {
  const instance = await getDuckDB();
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
  // Env-var override is the primary path for ops; daemon-config push
  // (Phase 4 of this plan integrates the `duckdb.memoryMb` setting
  // into ~/.insrc/config.json) lands later. Until then env-var is
  // sufficient for tuning. Default 512 MB.
  const raw = process.env['INSRC_DUCKDB_MEMORY_MB'];
  if (raw === undefined || raw.length === 0) return DEFAULT_MEMORY_MB;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 64) {
    log.warn({ raw }, 'INSRC_DUCKDB_MEMORY_MB invalid; falling back to default');
    return DEFAULT_MEMORY_MB;
  }
  return parsed;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
