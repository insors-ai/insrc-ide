/**
 * Search layer — vector ANN + graph queries scoped to a repo's
 * dependency closure (plans/storage-migration-duckdb.md Phase B.6).
 *
 * Public API (unchanged from Lance days):
 *   resolveClosure  — transitive DEPENDS_ON repos from a root repo
 *   searchEntities  — vector ANN search scoped to closure repos
 *   findCallers     — graph: 1-hop CALLS predecessors
 *   findCallees     — graph: 1-hop CALLS successors
 *   findDefinedIn   — graph: all entities DEFINED IN a file
 *   findImports     — graph: all files/modules a file IMPORTS
 *
 * All queries route through DuckDB (graph + vector now live in the
 * same `entity` / `relation` tables on the storage pool). Vector
 * search uses `array_distance(embedding, ?)` with cosine metric;
 * the HNSW index from B.3 makes ORDER BY ... LIMIT k index-served
 * in the configured-VSS path. If vss failed to load at startup
 * (logged on the storage pool), the planner falls back to a
 * brute-force scan -- correct, just O(N) instead of O(log N).
 */

import { arrayValue } from '@duckdb/node-api';
import type { DbClient } from './client.js';
import type { Entity, EntityKind, Language } from '../shared/types.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('search');

// Maximum DEPENDS_ON traversal depth in resolveClosure. Bounded to
// keep pathological dependency graphs from blowing up the recursive
// CTE.
const CLOSURE_MAX_DEPTH = 10;

/** Unwrap DuckDB's FLOAT[N] return shape ({items: number[]}) to plain number[]. */
function unwrapEmbedding(raw: unknown): number[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw as number[];
  const inner = (raw as { items?: unknown }).items;
  return Array.isArray(inner) ? (inner as number[]) : [];
}

/** Map a snake_case entity row back to an Entity (matches entities.ts). */
function rowToEntity(row: Record<string, unknown>): Entity {
  const entity: Entity = {
    id:        row['id']         as string,
    kind:      row['kind']       as EntityKind,
    name:      (row['name']      as string) ?? '',
    language:  (row['language']  as Language) ?? '',
    repo:      (row['repo']      as string) ?? '',
    file:      (row['file']      as string) ?? '',
    startLine: Number(row['start_line'] ?? 0),
    endLine:   Number(row['end_line']   ?? 0),
    body:      (row['body']      as string) ?? '',
    indexedAt: (row['indexed_at'] as string) ?? '',
    embedding: unwrapEmbedding(row['embedding']),
  };
  const em = row['embedding_model'] as string; if (em) entity.embeddingModel = em;
  if (row['is_exported'] === true) entity.isExported = true;
  if (row['is_async']    === true) entity.isAsync    = true;
  if (row['is_abstract'] === true) entity.isAbstract = true;
  const sg = row['signature'] as string; if (sg) entity.signature = sg;
  const hh = row['hash']      as string; if (hh) entity.hash      = hh;
  const rp = row['root_path'] as string; if (rp) entity.rootPath  = rp;
  if (row['artifact'] === true) entity.artifact = true;
  return entity;
}

// ---------------------------------------------------------------------------
// Closure resolution
// ---------------------------------------------------------------------------

/**
 * Returns the transitive DEPENDS_ON closure of repos reachable from
 * `repoPath`. Result always includes `repoPath` itself (as the first
 * element).
 *
 * Recursive CTE walks DEPENDS_ON edges in the unified `relation`
 * table, capped at CLOSURE_MAX_DEPTH (10). SELECT DISTINCT collapses
 * cycles. Returns only Repo node IDs (paths).
 */
export async function resolveClosure(db: DbClient, repoPath: string): Promise<string[]> {
  const rows = await db.duck.query<{ id: string }>(
    `WITH RECURSIVE closure(id, depth) AS (
       SELECT ?, 0
       UNION ALL
       SELECT r.dst, c.depth + 1
       FROM closure c
       JOIN relation r ON r.src = c.id
       WHERE r.kind = 'DEPENDS_ON' AND c.depth < ?
     )
     SELECT DISTINCT id FROM closure WHERE id IS NOT NULL`,
    [repoPath, CLOSURE_MAX_DEPTH],
  );
  const ids = rows.map(r => r.id).filter(Boolean);

  // Ensure the root repo is always included (even if 0 hops matches
  // nothing). The recursive CTE base case emits the root at depth 0,
  // so this is usually redundant.
  if (!ids.includes(repoPath)) ids.unshift(repoPath);

  log.debug({ repo: repoPath, closure: ids.length }, 'resolved dependency closure');
  return ids;
}

// ---------------------------------------------------------------------------
// Vector search
// ---------------------------------------------------------------------------

/**
 * Vector ANN search scoped to the given repos.
 * Returns up to `limit` entities ranked by cosine distance.
 *
 * Falls back to gracefully returning [] if:
 *  - the query vector is empty (embedding unavailable)
 *  - closureRepos is empty (no scope to search)
 */
export type SearchFilter = 'all' | 'code' | 'artifact';

export async function searchEntities(
  db:           DbClient,
  queryVec:     number[],
  closureRepos: string[],
  limit         = 10,
  filter:       SearchFilter = 'all',
): Promise<Entity[]> {
  if (queryVec.length === 0 || closureRepos.length === 0) {
    log.debug('searchEntities: empty query vector or closure');
    return [];
  }

  const repoPlaceholders = closureRepos.map(() => '?').join(', ');
  const conditions: string[] = [
    'embedding IS NOT NULL',
    `repo IN (${repoPlaceholders})`,
  ];
  if (filter === 'code')     conditions.push('artifact = FALSE');
  if (filter === 'artifact') conditions.push('artifact = TRUE');

  const params: unknown[] = [...closureRepos, arrayValue(queryVec), limit];
  const t0 = Date.now();
  const rows = await db.duck.query(
    `SELECT * FROM entity
     WHERE ${conditions.join(' AND ')}
     ORDER BY array_distance(embedding, ?::FLOAT[${queryVec.length}])
     LIMIT ?`,
    params as never[],
  );
  const results = rows.map(rowToEntity);
  const elapsed = `${Date.now() - t0}ms`;
  log.info({ hits: results.length, limit, filter, elapsed }, 'vector search');
  log.debug({ names: results.map(e => `${e.kind}:${e.name}`), elapsed }, 'vector search details');
  return results;
}

// ---------------------------------------------------------------------------
// Graph queries
// ---------------------------------------------------------------------------

/** Hydrate full Entity rows from ids -- one IN-list query. */
async function hydrateIds(db: DbClient, ids: string[]): Promise<Entity[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await db.duck.query(
    `SELECT * FROM entity WHERE id IN (${placeholders})`,
    [...ids],
  );
  return rows.map(rowToEntity);
}

/** Find all entities that directly call the entity with the given id. */
export async function findCallers(db: DbClient, entityId: string): Promise<Entity[]> {
  const ids = await neighborIds(db, entityId, 'CALLS', 'inbound');
  const results = await hydrateIds(db, ids);
  log.debug({ entity: entityId, callers: results.length }, 'findCallers');
  return results;
}

/** Find all entities directly called by the entity with the given id. */
export async function findCallees(db: DbClient, entityId: string): Promise<Entity[]> {
  const ids = await neighborIds(db, entityId, 'CALLS', 'outbound');
  const results = await hydrateIds(db, ids);
  log.debug({ entity: entityId, callees: results.length }, 'findCallees');
  return results;
}

/** Find all entities defined in a file (DEFINES edges from File). */
export async function findDefinedIn(db: DbClient, fileEntityId: string): Promise<Entity[]> {
  const ids = await neighborIds(db, fileEntityId, 'DEFINES', 'outbound');
  const results = await hydrateIds(db, ids);
  log.debug({ file: fileEntityId, defined: results.length }, 'findDefinedIn');
  return results;
}

/** Find all files/modules a file imports (IMPORTS edges). */
export async function findImports(db: DbClient, fileEntityId: string): Promise<Entity[]> {
  const ids = await neighborIds(db, fileEntityId, 'IMPORTS', 'outbound');
  const results = await hydrateIds(db, ids);
  log.debug({ file: fileEntityId, imports: results.length }, 'findImports');
  return results;
}

/**
 * Unified 1-hop neighbour lookup over the DuckDB `relation` table.
 * `'inbound'` returns nodes with edges pointing TO entityId;
 * `'outbound'` returns nodes with edges pointing FROM entityId. The
 * idx_relation_fwd / idx_relation_rev indexes make both directions
 * index-served.
 */
type EdgeDirection = 'inbound' | 'outbound';

async function neighborIds(
  db: DbClient,
  entityId: string,
  kind: string,
  direction: EdgeDirection,
): Promise<string[]> {
  const matchCol  = direction === 'inbound' ? 'dst' : 'src';
  const returnCol = direction === 'inbound' ? 'src' : 'dst';
  const rows = await db.duck.query<{ id: string }>(
    `SELECT ${returnCol} AS id FROM relation WHERE ${matchCol} = ? AND kind = ?`,
    [entityId, kind],
  );
  return rows.map(r => r.id).filter(Boolean);
}
