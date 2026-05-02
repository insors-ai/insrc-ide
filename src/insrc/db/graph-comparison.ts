/**
 * Graph-state snapshot utility.
 *
 * plans/storage-migration-duckdb.md Phase A.0 (then trimmed in A.11
 * cleanup -- snapshotKuzu and the diff helpers are gone with Kuzu).
 *
 * What remains: snapshotDuck for the DuckDB graph state. Useful for
 * the Phase B LanceDB → DuckDB migration's parity checks (graph
 * state under both modes should be identical) and for ad-hoc
 * diagnostics. The Phase A diff comparison (Kuzu vs DuckDB) was
 * removed when Kuzu was ripped out -- there's nothing to compare
 * against any more.
 */

import { createHash } from 'node:crypto';
import type { GraphClient } from './duckdb-graph-client.js';

export interface GraphSnapshot {
  readonly entityCount:      number;
  readonly relationCount:    number;
  readonly unresolvedCount:  number;
  readonly repoCount:        number;
  /** SHA-256 of the sorted entity ids, separated by '\\x00'. Hex, first 16 chars. */
  readonly entityHash:       string;
  /** SHA-256 of the sorted (src||\\x01||dst||\\x01||kind) tuples. */
  readonly relationHash:     string;
  /** SHA-256 of the sorted unresolved-relation ids. */
  readonly unresolvedHash:   string;
  /** SHA-256 of the sorted repo ids. */
  readonly repoHash:         string;
}

/** Snapshot the DuckDB graph via the consolidated `relation` table. */
export async function snapshotDuck(duck: GraphClient): Promise<GraphSnapshot> {
  const entityIds   = (await duck.query<{ id: string }>('SELECT id FROM entity')).map(r => r.id);
  const repoIds     = (await duck.query<{ id: string }>('SELECT id FROM repo')).map(r => r.id);
  const unresolvedIds = (await duck.query<{ id: string }>('SELECT id FROM unresolved_relation')).map(r => r.id);
  const relRows     = await duck.query<{ src: string; dst: string; kind: string }>(
    'SELECT src, dst, kind FROM relation',
  );

  return {
    entityCount:    entityIds.length,
    relationCount:  relRows.length,
    unresolvedCount: unresolvedIds.length,
    repoCount:      repoIds.length,
    entityHash:     hashIds(entityIds),
    relationHash:   hashTuples(relRows.map(r => `${r.src}\x01${r.dst}\x01${r.kind}`)),
    unresolvedHash: hashIds(unresolvedIds),
    repoHash:       hashIds(repoIds),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function hashIds(ids: readonly string[]): string {
  // Sorted to make hash order-independent. First 16 hex chars is
  // plenty -- birthday collisions don't matter here, we just want a
  // fast equality check.
  const h = createHash('sha256');
  for (const id of [...ids].sort()) {
    h.update(id);
    h.update('\x00');
  }
  return h.digest('hex').slice(0, 16);
}

function hashTuples(tuples: readonly string[]): string {
  return hashIds(tuples);
}
