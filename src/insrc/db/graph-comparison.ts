/**
 * Graph-state comparison utility.
 *
 * plans/storage-migration-duckdb.md Phase A.0.
 *
 * Provides primitives for comparing the Kuzu-backed graph against the
 * DuckDB-backed graph at structural granularity (counts + sorted-ID
 * hashes per table). Used by:
 *
 *   - The migration harness test (A.0) -- validates that the dual-
 *     write path produces identical state in both backends from a
 *     synthetic graph fixture.
 *   - The live diff job (A.8) -- runs against the daemon's actual
 *     state during the dual-write phase to confirm parity before
 *     the read cutover.
 *
 * Design choice: count + ID-set hash, not full-row hash. Counts catch
 * "store missed a write entirely"; ID-set hashes catch "store has the
 * wrong records, even though the count happens to match." Field-level
 * drift (e.g., kind=function in Kuzu, kind=class in DuckDB for the
 * same id) is NOT caught here -- the trade-off is comparison speed.
 * Field drift is detected at the per-query level by the harness's
 * read-side parity tests (different code path).
 */

import { createHash } from 'node:crypto';
import type kuzu from 'kuzu';
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

export interface GraphDiff {
  readonly entityCountDelta:   number;     // a.entityCount - b.entityCount
  readonly relationCountDelta: number;
  readonly unresolvedCountDelta: number;
  readonly repoCountDelta:     number;
  readonly entityHashMatch:    boolean;
  readonly relationHashMatch:  boolean;
  readonly unresolvedHashMatch: boolean;
  readonly repoHashMatch:      boolean;
  /** True iff every count-delta is 0 and every hash matches -- "in sync." */
  readonly clean:              boolean;
}

// ---------------------------------------------------------------------------
// Snapshot builders
// ---------------------------------------------------------------------------

/** Snapshot the Kuzu side of the graph via the typed REL TABLE schema. */
export async function snapshotKuzu(graph: kuzu.Connection): Promise<GraphSnapshot> {
  // Entity ids -- across the eight typed REL TABLEs there's still one
  // Entity NODE TABLE; we only need its ids to hash.
  const entityIds = await kuzuIds(graph, 'MATCH (n:Entity) RETURN n.id AS id');
  const repoIds   = await kuzuIds(graph, 'MATCH (r:Repo) RETURN r.id AS id');
  const unresolvedIds = await kuzuIds(graph, 'MATCH (u:UnresolvedRelation) RETURN u.id AS id');

  // Relations are spread across eight typed REL TABLEs; UNION the lot
  // into one (src, dst, kind) tuple list.
  const relRows = await kuzuRows<{ src: string; dst: string; kind: string }>(graph, `
    MATCH (a:Entity)-[r:DEFINES]->(b:Entity)    RETURN a.id AS src, b.id AS dst, 'DEFINES' AS kind
    UNION ALL MATCH (a:Entity)-[r:IMPORTS]->(b:Entity)    RETURN a.id AS src, b.id AS dst, 'IMPORTS' AS kind
    UNION ALL MATCH (a:Entity)-[r:CALLS]->(b:Entity)      RETURN a.id AS src, b.id AS dst, 'CALLS' AS kind
    UNION ALL MATCH (a:Entity)-[r:INHERITS]->(b:Entity)   RETURN a.id AS src, b.id AS dst, 'INHERITS' AS kind
    UNION ALL MATCH (a:Entity)-[r:IMPLEMENTS]->(b:Entity) RETURN a.id AS src, b.id AS dst, 'IMPLEMENTS' AS kind
    UNION ALL MATCH (a:Entity)-[r:DEPENDS_ON]->(b:Entity) RETURN a.id AS src, b.id AS dst, 'DEPENDS_ON' AS kind
    UNION ALL MATCH (a:Entity)-[r:EXPORTS]->(b:Entity)    RETURN a.id AS src, b.id AS dst, 'EXPORTS' AS kind
    UNION ALL MATCH (a:Entity)-[r:REFERENCES]->(b:Entity) RETURN a.id AS src, b.id AS dst, 'REFERENCES' AS kind
  `);

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

/** Snapshot the DuckDB side via the consolidated `relation` table. */
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
// Diff
// ---------------------------------------------------------------------------

/**
 * Diff two snapshots. `a - b` semantics for the deltas: positive
 * delta means `a` has more rows than `b` for that table. Hash matches
 * are symmetric (true iff equal).
 */
export function diff(a: GraphSnapshot, b: GraphSnapshot): GraphDiff {
  const entityCountDelta     = a.entityCount     - b.entityCount;
  const relationCountDelta   = a.relationCount   - b.relationCount;
  const unresolvedCountDelta = a.unresolvedCount - b.unresolvedCount;
  const repoCountDelta       = a.repoCount       - b.repoCount;
  const entityHashMatch      = a.entityHash      === b.entityHash;
  const relationHashMatch    = a.relationHash    === b.relationHash;
  const unresolvedHashMatch  = a.unresolvedHash  === b.unresolvedHash;
  const repoHashMatch        = a.repoHash        === b.repoHash;
  const clean =
    entityCountDelta === 0 && relationCountDelta === 0 &&
    unresolvedCountDelta === 0 && repoCountDelta === 0 &&
    entityHashMatch && relationHashMatch &&
    unresolvedHashMatch && repoHashMatch;
  return {
    entityCountDelta, relationCountDelta, unresolvedCountDelta, repoCountDelta,
    entityHashMatch, relationHashMatch, unresolvedHashMatch, repoHashMatch,
    clean,
  };
}

/** Render a GraphDiff as a one-line summary suitable for log lines. */
export function summariseDiff(d: GraphDiff): string {
  if (d.clean) return 'in-sync (counts + hashes match)';
  const parts: string[] = [];
  if (d.entityCountDelta !== 0)     parts.push(`entityΔ=${d.entityCountDelta}`);
  if (d.relationCountDelta !== 0)   parts.push(`relationΔ=${d.relationCountDelta}`);
  if (d.unresolvedCountDelta !== 0) parts.push(`unresolvedΔ=${d.unresolvedCountDelta}`);
  if (d.repoCountDelta !== 0)       parts.push(`repoΔ=${d.repoCountDelta}`);
  if (!d.entityHashMatch)     parts.push('entityHash≠');
  if (!d.relationHashMatch)   parts.push('relationHash≠');
  if (!d.unresolvedHashMatch) parts.push('unresolvedHash≠');
  if (!d.repoHashMatch)       parts.push('repoHash≠');
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function hashIds(ids: readonly string[]): string {
  // Sorted to make hash order-independent across backends. First 16
  // hex chars is plenty -- birthday collisions don't matter here, we
  // just want a fast equality check.
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

async function kuzuIds(graph: kuzu.Connection, stmt: string): Promise<string[]> {
  const result = await graph.query(stmt);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const qr = Array.isArray(result) ? result[0]! : result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await (qr as any).getAll() as Record<string, unknown>[];
  return rows.map(r => r['id'] as string).filter((s): s is string => typeof s === 'string');
}

async function kuzuRows<T>(graph: kuzu.Connection, stmt: string): Promise<T[]> {
  const result = await graph.query(stmt);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const qr = Array.isArray(result) ? result[0]! : result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await (qr as any).getAll()) as T[];
}
