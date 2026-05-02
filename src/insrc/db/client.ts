import * as lancedb from '@lancedb/lancedb';
import { mkdirSync } from 'node:fs';
import { PATHS } from '../shared/paths.js';
import { buildDuckDBSchema } from './duckdb-graph-schema.js';
import {
  getDuckDBGraphClient,
  resetDuckDBGraphClient,
  type GraphClient,
} from './duckdb-graph-client.js';
import { loadConfig } from '../agent/config.js';

/**
 * Daemon-side database clients.
 *
 * Post Kuzu → DuckDB migration (plans/storage-migration-duckdb.md
 * Phase A.8-A.11): the graph layer runs on the file-backed DuckDB
 * storage pool (daemon/db/duckdb-storage-pool.ts) via the shared
 * `GraphClient`. The legacy `graph` / `graphReader` Kuzu connections
 * are gone.
 *
 * `lance` stays through Phase A; Phase B.6 replaces it with DuckDB
 * VSS tables on the same storage pool.
 */
export interface DbClients {
  /**
   * DuckDB-backed graph client. Storage-pool-backed; one client for
   * both reads and writes. DuckDB's MVCC makes a separate reader
   * connection unnecessary.
   */
  duck: GraphClient;
  /** LanceDB connection — entity data with embeddings (removed in B.10). */
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

  // Ensure required directories exist. The DuckDB storage pool
  // creates its own parent (`~/.insrc/`) on first init; we only need
  // to seed the Lance directory here. Phase B.10 drops this.
  mkdirSync(PATHS.lance, { recursive: true });

  const duck = getDuckDBGraphClient();
  const lance = await lancedb.connect(PATHS.lance);

  _clients = { duck, lance };
  return _clients;
}

/**
 * Apply the DuckDB schema (graph + Phase B vector tables).
 * Idempotent -- safe to call on every daemon startup.
 */
export async function initDb(db: DbClients): Promise<void> {
  const dim = loadConfig().models.providers.local.embeddingDim;
  for (const stmt of buildDuckDBSchema(dim)) {
    await db.duck.exec(stmt);
  }
}

/**
 * Clears the singleton references. The underlying DuckDB instance is
 * closed separately by `closeDuckDBStorage` in
 * daemon/db/duckdb-storage-pool.ts via the daemon's graceful-shutdown
 * handler; we just clear the cached GraphClient handle here.
 */
export async function closeDb(): Promise<void> {
  _clients = null;
  resetDuckDBGraphClient();
}
