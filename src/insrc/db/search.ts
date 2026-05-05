/**
 * Search layer — vector ANN + graph queries scoped to a repo's
 * dependency closure.
 *
 * Public API (preserved across the LMDB+Lance migration):
 *   resolveClosure  — transitive DEPENDS_ON repos from a root repo
 *   searchEntities  — vector ANN search scoped to closure repos
 *   findCallers     — graph: 1-hop CALLS predecessors
 *   findCallees     — graph: 1-hop CALLS successors
 *   findDefinedIn   — graph: all entities DEFINED IN a file
 *   findImports     — graph: all files/modules a file IMPORTS
 *
 * Phase 3.2 status:
 *   - searchEntities now routes ANN through LanceDB's `entity_vec`
 *     table; hits are hydrated to full Entity objects from LMDB.
 *   - resolveClosure / findCallers / findCallees / findDefinedIn /
 *     findImports still call into the legacy `db.duck` path. They
 *     return [] until Phase 4.2 wires them to the LMDB graph.
 */

import type { DbClient } from './client.js';
import type { Entity } from '../shared/types.js';
import { rowToEntity, getEntitiesByIds } from './entities.js';
import { searchEntityVecs, type EntityVecFilter } from './lance/entity-vec.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('search');

// Maximum DEPENDS_ON traversal depth in resolveClosure. Bounded to
// keep pathological dependency graphs from blowing up the recursive
// CTE.
const CLOSURE_MAX_DEPTH = 10;

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
  _db:          DbClient,
  queryVec:     number[],
  closureRepos: string[],
  limit         = 10,
  filter:       SearchFilter = 'all',
): Promise<Entity[]> {
  if (queryVec.length === 0 || closureRepos.length === 0) {
    log.debug('searchEntities: empty query vector or closure');
    return [];
  }

  // Two-step: ANN against the Lance entity_vec table for hits +
  // distances, then hydrate full Entity rows from LMDB by id. The
  // hydration step also serves as a consistency check -- if Lance
  // has a row whose LMDB counterpart was tombstoned in a prior
  // cascade, the hydration silently drops it.
  const t0 = Date.now();
  const hits = await searchEntityVecs(
    queryVec,
    closureRepos,
    limit,
    filter as EntityVecFilter,
  );
  const ids = hits.map(h => h.id);
  const entities = await getEntitiesByIds(_db, ids);

  // Preserve the Lance-side ranking. getEntitiesByIds doesn't
  // guarantee order; reorder by hits[].
  const byId = new Map<string, Entity>();
  for (const e of entities) byId.set(e.id, e);
  const ordered: Entity[] = [];
  for (const h of hits) {
    const e = byId.get(h.id);
    if (e !== undefined) ordered.push(e);
  }

  const elapsed = `${Date.now() - t0}ms`;
  log.info({ hits: ordered.length, limit, filter, elapsed }, 'vector search');
  log.debug(
    { names: ordered.map(e => `${e.kind}:${e.name}`), elapsed },
    'vector search details',
  );
  return ordered;
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
