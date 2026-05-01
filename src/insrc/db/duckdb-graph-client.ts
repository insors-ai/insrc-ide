/**
 * DuckDB-backed graph client.
 *
 * plans/storage-migration-duckdb.md Phase A.2.
 *
 * The replacement for `kuzu.Connection` in
 * [client.ts](./client.ts) DbClients. Mirrors the small surface area
 * the Kuzu helpers actually use (`prepare → execute`, `query`) but
 * with cleaner types: rows come back as `Record<string, unknown>[]`
 * directly, no `.getAll()` dance, no array-of-results unwrapping.
 *
 * Design notes:
 *
 * 1. **No separate writer / reader.** Kuzu had two Connections so
 *    long-running reads couldn't block writes; DuckDB's MVCC handles
 *    that natively without per-role connections. The `graph` and
 *    `graphReader` fields on DbClients can both point at the same
 *    GraphClient instance (or at two if we want differentiated
 *    timeouts; v1 uses one).
 *
 * 2. **No prepared-statement object.** The Kuzu helpers do
 *    `prepare → execute(prepared, params)` per call -- there's no
 *    reuse, so it was Kuzu's only path to parameterized queries.
 *    DuckDB's `conn.run(sql, params)` takes params natively; the
 *    GraphClient surface drops `prepare` entirely.
 *
 * 3. **Fresh Connection per call.** Each GraphClient call goes
 *    through `withConnection` from the duckdb-pool (Phase 0.2);
 *    Connections are sub-millisecond and per-call gives us query
 *    isolation + per-query cancel semantics.
 */

import { withConnection } from '../daemon/db/duckdb-pool.js';
import type { DuckDBValue } from '@duckdb/node-api';

/**
 * Parameter binding for queries. Accepts either positional (array)
 * or named (record). DuckDB's `conn.run(sql, values)` takes either.
 */
export type GraphParams = readonly DuckDBValue[] | Readonly<Record<string, DuckDBValue>>;

export interface GraphClient {
  /**
   * Run a SQL statement that returns rows. Returns the rows as plain
   * objects, column-name-keyed. Empty array when the query produces
   * no rows. Throws on SQL errors (invalid syntax, constraint
   * violations, missing tables, etc.) -- callers wrap in try/catch
   * where recovery makes sense.
   */
  query<T = Record<string, unknown>>(sql: string, params?: GraphParams): Promise<T[]>;

  /**
   * Run a SQL statement that doesn't return rows (DDL, INSERT,
   * UPDATE, DELETE). Returns `void`. Same error semantics as
   * `query`.
   */
  exec(sql: string, params?: GraphParams): Promise<void>;
}

/**
 * Minimal GraphClient implementation backed by the daemon-wide
 * DuckDB singleton. Stateless: every call acquires a fresh
 * Connection through `withConnection`, runs the statement, closes
 * the Connection.
 */
class DuckDBGraphClient implements GraphClient {
  async query<T = Record<string, unknown>>(
    sql: string,
    params?: GraphParams,
  ): Promise<T[]> {
    return withConnection(async (conn) => {
      const reader = params !== undefined
        ? await conn.runAndReadAll(sql, params as DuckDBValue[] | Record<string, DuckDBValue>)
        : await conn.runAndReadAll(sql);
      return reader.getRowObjects() as T[];
    });
  }

  async exec(sql: string, params?: GraphParams): Promise<void> {
    await withConnection(async (conn) => {
      if (params !== undefined) {
        await conn.run(sql, params as DuckDBValue[] | Record<string, DuckDBValue>);
      } else {
        await conn.run(sql);
      }
    });
  }
}

let _instance: GraphClient | null = null;

/**
 * Lazy-init the daemon-wide GraphClient instance. Cached after the
 * first call; safe to call many times. The underlying DuckDB pool
 * is itself lazy, so this is cheap on the cold path too.
 */
export function getDuckDBGraphClient(): GraphClient {
  if (_instance === null) _instance = new DuckDBGraphClient();
  return _instance;
}

/**
 * Reset the cached client. Called from [client.ts](./client.ts)
 * `closeDb` so a daemon restart picks up a fresh instance.
 * The underlying DuckDB instance is closed by `closeDuckDB` in
 * the pool module, not here.
 */
export function resetDuckDBGraphClient(): void {
  _instance = null;
}
