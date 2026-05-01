import kuzu from 'kuzu';
import * as lancedb from '@lancedb/lancedb';
import { mkdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname } from 'node:path';
import { PATHS } from '../shared/paths.js';
import { KUZU_STATEMENTS } from './schema.js';
import { DUCKDB_GRAPH_STATEMENTS } from './duckdb-graph-schema.js';
import {
  getDuckDBGraphClient,
  resetDuckDBGraphClient,
  type GraphClient,
} from './duckdb-graph-client.js';

/**
 * Cap on internal worker threads per Kuzu Connection. The default
 * (`nproc`) over-parallelises single-Cypher queries internally;
 * thread-state samples on the indexer's resolver pass showed
 * `futex_wait_queue` activity (workers waiting on shared internal
 * locks). Capping at `min(8, nproc/2)` eliminates the contention
 * without serialising queries that genuinely benefit from internal
 * parallelism. On a 32-CPU box this resolves to 8; on a 4-CPU dev
 * box to 2; on 2-CPU to 1.
 *
 * See `plans/analyzers/code-analyzer.md` Phase 1 follow-up F7.
 */
const KUZU_THREADS = Math.min(8, Math.max(1, Math.floor(cpus().length / 2)));

/** Defensive query-timeout cap on the reader connection. */
const KUZU_READER_QUERY_TIMEOUT_MS = 30_000;

export interface DbClients {
  /**
   * Kuzu writer connection -- used by the indexer + cross-file resolver
   * for all WAL-mutating Cypher (CREATE / MERGE / DELETE / SET).
   */
  graph: kuzu.Connection;
  /**
   * Kuzu reader connection -- intended for analyzer / UI consumers
   * (read-only tool calls, todos.subscribe, status RPCs). Sharing
   * one Database across two Connections eliminates the contention
   * F2 on the single shared connection that the resolver pass +
   * concurrent /code-analyze runs surfaced. Auto-aborts queries
   * past 30 s as a defensive guard against runaways.
   *
   * Same Database backing as `graph` -- writes through `graph` are
   * visible to `graphReader` immediately.
   */
  graphReader: kuzu.Connection;
  /**
   * DuckDB-backed graph client -- the Kuzu replacement landing in
   * Phase A of plans/storage-migration-duckdb.md. During the dual-
   * track / dual-write phases this is populated alongside `graph` /
   * `graphReader`; per-file rewrites in A.3-A.6 issue writes to
   * both, reads still come from Kuzu (A.8) until the read cutover
   * in A.9. After A.10 the Kuzu fields are removed entirely.
   *
   * v1 uses one client for both reads and writes; DuckDB's MVCC
   * makes a separate reader connection unnecessary.
   */
  duck: GraphClient;
  /** LanceDB connection — entity data with embeddings and BM25 FTS */
  lance: lancedb.Connection;
}

export type DbClient = DbClients;

// Keep references alive to prevent premature GC of the Kuzu Database object
let _kuzuDb: kuzu.Database | null = null;
let _clients: DbClients | null = null;

/**
 * Opens (or returns the cached) Kuzu + LanceDB connections.
 * Only the daemon should call this — the CLI communicates via IPC.
 */
export async function getDb(): Promise<DbClients> {
  if (_clients !== null) return _clients;

  // Kuzu creates the DB directory itself — only ensure the parent exists
  mkdirSync(dirname(PATHS.graph), { recursive: true });
  mkdirSync(PATHS.lance, { recursive: true });

  // Buffer pool + autoCheckpoint sized aggressively to bound WAL growth.
  // Earlier configs ran with 8 GB buffer + 512 MB checkpoint threshold;
  // on a 12k+-file resolver pass the WAL still hit ~500 MB before the
  // checkpoint fired, exhausted the buffer pool, and left the DB
  // unrecoverable -- WAL replay on restart can't fit a 500 MB log
  // alongside the working set even at 8 GB. The fix is the opposite of
  // "bigger buffer": keep the WAL small enough that replay is cheap,
  // and let the working set live within a 1 GB pool that a typical
  // code-graph never approaches anyway.
  _kuzuDb = new kuzu.Database(
    PATHS.graph,
    /* bufferManagerSize     */ 1 * 1024 * 1024 * 1024,
    /* enableCompression     */ undefined,
    /* readOnly              */ false,
    /* maxDBSize             */ undefined,
    /* autoCheckpoint        */ true,
    /* checkpointThreshold   */ 128 * 1024 * 1024,
  );
  const graph = new kuzu.Connection(_kuzuDb, KUZU_THREADS);
  const graphReader = new kuzu.Connection(_kuzuDb, KUZU_THREADS);
  graphReader.setQueryTimeout(KUZU_READER_QUERY_TIMEOUT_MS);

  const lance = await lancedb.connect(PATHS.lance);

  // DuckDB graph client is daemon-wide singleton from
  // duckdb-graph-client.ts; the underlying DuckDB instance is the
  // shared one from daemon/db/duckdb-pool.ts (lazy-init on first
  // query). We just return the GraphClient handle here; opening
  // the DuckDB instance happens on first use.
  const duck = getDuckDBGraphClient();

  _clients = { graph, graphReader, duck, lance };
  return _clients;
}

/**
 * Runs Kuzu DDL + DuckDB graph DDL + ensures LanceDB tables exist.
 * Idempotent -- safe to call on every daemon startup.
 *
 * During the dual-track phase (A.1-A.7) both schemas apply; once
 * the Kuzu cutover lands (A.10) the Kuzu DDL block goes away.
 */
export async function initDb(db: DbClients): Promise<void> {
  for (const stmt of KUZU_STATEMENTS) {
    await db.graph.query(stmt);
  }
  // Apply DuckDB graph schema. Failure here is non-fatal during the
  // dual-track phase -- the daemon can still serve Kuzu-backed
  // reads/writes -- but it does mean the dual-write path will fail
  // on first use, surfacing the schema problem loudly enough to
  // notice. We log + propagate.
  for (const stmt of DUCKDB_GRAPH_STATEMENTS) {
    await db.duck.exec(stmt);
  }
}

/**
 * Clears the singleton references.
 * Note: do NOT call kuzu close() — the 0.11.x Node.js binding segfaults on
 * explicit close; GC handles cleanup safely. The underlying DuckDB
 * instance is closed separately by `closeDuckDB` in daemon/db/duckdb-pool.ts
 * via the daemon's graceful-shutdown handler; we just clear the
 * cached GraphClient handle here.
 */
export async function closeDb(): Promise<void> {
  _clients = null;
  _kuzuDb  = null;
  resetDuckDBGraphClient();
}
