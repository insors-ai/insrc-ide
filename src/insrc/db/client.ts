import * as lancedb from '@lancedb/lancedb';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PATHS } from '../shared/paths.js';
import { DUCKDB_GRAPH_STATEMENTS } from './duckdb-graph-schema.js';
import {
  getDuckDBGraphClient,
  resetDuckDBGraphClient,
  type GraphClient,
} from './duckdb-graph-client.js';

/**
 * Daemon-side database clients.
 *
 * Post Kuzu → DuckDB migration (plans/storage-migration-duckdb.md
 * Phase A.8-A.11): the graph layer runs on DuckDB only. The legacy
 * `graph` / `graphReader` Kuzu connections are gone; callers go
 * through `duck` (a `GraphClient` over the daemon's shared DuckDB
 * instance from daemon/db/duckdb-pool.ts).
 *
 * `lance` stays through Phase A; it migrates to DuckDB VSS in
 * Phase B.
 */
export interface DbClients {
  /**
   * DuckDB-backed graph client. v1 uses one client for both reads
   * and writes; DuckDB's MVCC makes a separate reader connection
   * unnecessary. The 30-second query-timeout guard from the old
   * Kuzu reader connection isn't replicated here -- query timeouts
   * are a per-call concern in DuckDB; the few callers that needed
   * it can wrap their query in a per-connection timeout if it
   * comes up.
   */
  duck: GraphClient;
  /** LanceDB connection — entity data with embeddings and BM25 FTS */
  lance: lancedb.Connection;
}

export type DbClient = DbClients;

let _clients: DbClients | null = null;

/**
 * Opens (or returns the cached) DuckDB graph + LanceDB connections.
 * Only the daemon should call this -- the CLI communicates via IPC.
 */
export async function getDb(): Promise<DbClients> {
  if (_clients !== null) return _clients;

  // Ensure the LanceDB directory exists; DuckDB graph state is
  // in-memory in the singleton (daemon/db/duckdb-pool.ts) and has no
  // on-disk parent of its own.
  mkdirSync(dirname(PATHS.graph), { recursive: true });
  mkdirSync(PATHS.lance, { recursive: true });

  // DuckDB graph client is daemon-wide singleton from
  // duckdb-graph-client.ts; the underlying DuckDB instance is the
  // shared one from daemon/db/duckdb-pool.ts (lazy-init on first
  // query). We just return the GraphClient handle here; opening
  // the DuckDB instance happens on first use.
  const duck = getDuckDBGraphClient();

  const lance = await lancedb.connect(PATHS.lance);

  _clients = { duck, lance };
  return _clients;
}

/**
 * Apply DuckDB graph DDL + ensure LanceDB tables exist.
 * Idempotent -- safe to call on every daemon startup.
 */
export async function initDb(db: DbClients): Promise<void> {
  for (const stmt of DUCKDB_GRAPH_STATEMENTS) {
    await db.duck.exec(stmt);
  }
}

/**
 * Clears the singleton references. The underlying DuckDB instance is
 * closed separately by `closeDuckDB` in daemon/db/duckdb-pool.ts via
 * the daemon's graceful-shutdown handler; we just clear the cached
 * GraphClient handle here.
 */
export async function closeDb(): Promise<void> {
  _clients = null;
  resetDuckDBGraphClient();
}
