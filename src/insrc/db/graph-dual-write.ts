/**
 * Graph-backend mode toggle for the Kuzu → DuckDB migration.
 *
 * plans/storage-migration-duckdb.md Phase A.
 *
 * Three modes the env var INSRC_GRAPH_BACKEND can take:
 *
 *   'kuzu'    -- writes + reads via Kuzu only. Default. Pre-A.8 state.
 *   'both'    -- writes to BOTH Kuzu and DuckDB; reads still from Kuzu.
 *                The dual-write phase (A.8). DuckDB write failures are
 *                caught + logged + counted but do NOT fail the overall
 *                operation; Kuzu remains source of truth.
 *   'duckdb'  -- writes + reads via DuckDB only. Post-A.10 cutover state.
 *                Kuzu code paths still run idempotent no-ops until the
 *                cleanup commit (A.11) deletes them entirely.
 *
 * Per-file rewrites (A.3-A.6) wire the DuckDB write paths but gate
 * them through `shouldDualWriteGraph()`; flipping the env var to
 * 'both' activates the dual-write without code changes.
 *
 * The mode is read once per call (not cached) so an operator can flip
 * it mid-daemon-run without restarting -- useful for running the
 * comparison script (A.8) against a live daemon.
 */

import { getLogger } from '../shared/logger.js';

const log = getLogger('graph-dual-write');

export type GraphBackendMode = 'kuzu' | 'both' | 'duckdb';

const VALID_MODES: ReadonlySet<GraphBackendMode> = new Set(['kuzu', 'both', 'duckdb']);

export function getGraphBackendMode(): GraphBackendMode {
  const raw = process.env['INSRC_GRAPH_BACKEND'];
  if (raw === undefined || raw.length === 0) return 'kuzu';
  if (VALID_MODES.has(raw as GraphBackendMode)) return raw as GraphBackendMode;
  // Invalid value: warn once + default to 'kuzu'. Don't throw -- a typo
  // in the env shouldn't crash the daemon.
  log.warn({ raw }, "INSRC_GRAPH_BACKEND not one of 'kuzu' | 'both' | 'duckdb'; defaulting to 'kuzu'");
  return 'kuzu';
}

/** True iff the DuckDB graph should receive writes alongside (or instead of) Kuzu. */
export function shouldWriteDuckGraph(): boolean {
  const m = getGraphBackendMode();
  return m === 'both' || m === 'duckdb';
}

/** True iff Kuzu should still receive writes. Off only after the A.10 cutover. */
export function shouldWriteKuzuGraph(): boolean {
  const m = getGraphBackendMode();
  return m === 'kuzu' || m === 'both';
}

/** True iff reads come from DuckDB. Off until A.9 read cutover. */
export function shouldReadDuckGraph(): boolean {
  return getGraphBackendMode() === 'duckdb';
}
