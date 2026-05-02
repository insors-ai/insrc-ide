import { buildDuckDBSchema } from './duckdb-graph-schema.js';
import {
  getDuckDBGraphClient,
  resetDuckDBGraphClient,
  type GraphClient,
} from './duckdb-graph-client.js';
import { loadConfig } from '../agent/config.js';

/**
 * Daemon-side database client.
 *
 * Post-Lance migration (plans/storage-migration-duckdb.md Phase
 * B.10): the only persistence layer is DuckDB. Graph + entity bodies
 * + embeddings + conversations + config-store + todos all live on
 * the file-backed storage pool (`daemon/db/duckdb-storage-pool.ts`).
 * The legacy `lance` field is gone.
 */
export interface DbClients {
  /**
   * DuckDB-backed graph + storage client. One client for both reads
   * and writes; DuckDB's MVCC makes a separate reader connection
   * unnecessary.
   */
  duck: GraphClient;
}

export type DbClient = DbClients;

let _clients: DbClients | null = null;

/**
 * Returns the cached daemon-side DB client. Lazy-init on first call.
 * Only the daemon should call this -- the CLI communicates via IPC.
 */
export async function getDb(): Promise<DbClients> {
  if (_clients !== null) return _clients;
  const duck = getDuckDBGraphClient();
  _clients = { duck };
  return _clients;
}

/**
 * Apply the DuckDB schema (graph + vector tables). Idempotent --
 * safe to call on every daemon startup.
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
