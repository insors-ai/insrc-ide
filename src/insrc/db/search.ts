/**
 * Search layer — hybrid vector + graph queries scoped to a repo's dependency closure.
 *
 * Public API:
 *   resolveClosure      — transitive DEPENDS_ON repos from a root repo
 *   searchEntities      — vector ANN search scoped to closure repos
 *   findCallers         — graph: 1-hop CALLS predecessors
 *   findCallees         — graph: 1-hop CALLS successors
 *   findDefinedIn       — graph: all entities DEFINED IN a file
 *   findImports         — graph: all files/modules that a file IMPORTS
 */

import type { DbClient } from './client.js';
import type { Entity } from '../shared/types.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('search');

// Maximum DEPENDS_ON traversal depth in resolveClosure. Bounded to
// keep pathological dependency graphs from blowing up the recursive
// CTE.
const CLOSURE_MAX_DEPTH = 10;

/** Map a raw LanceDB row back to an Entity (matches rowToEntity in entities.ts). */
function rowToEntity(row: Record<string, unknown>): Entity {
  const entity: Entity = {
    id:        row['id']        as string,
    kind:      row['kind']      as Entity['kind'],
    name:      row['name']      as string,
    language:  row['language']  as Entity['language'],
    repo:      row['repo']      as string,
    file:      row['file']      as string,
    startLine: row['startLine'] as number,
    endLine:   row['endLine']   as number,
    body:      row['body']      as string,
    indexedAt: row['indexedAt'] as string,
    embedding: (row['vector']   as number[]) ?? [],
  };
  const em = row['embeddingModel'] as string; if (em) entity.embeddingModel = em;
  if (row['isExported'] === true) entity.isExported = true;
  if (row['isAsync']    === true) entity.isAsync     = true;
  if (row['isAbstract'] === true) entity.isAbstract  = true;
  const sg = row['signature'] as string; if (sg) entity.signature = sg;
  const hh = row['hash']      as string; if (hh) entity.hash      = hh;
  const rp = row['rootPath']  as string; if (rp) entity.rootPath  = rp;
  if (row['artifact'] === true) entity.artifact = true;
  return entity;
}

async function getEntitiesTable(db: DbClient) {
  const names = await db.lance.tableNames();
  if (!names.includes('entities')) return null;
  return db.lance.openTable('entities');
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
 * table, capped at CLOSURE_MAX_DEPTH (10). Base case emits the root
 * at depth 0; recursive step extends one edge at a time. SELECT
 * DISTINCT collapses cycles. Returns only Repo node IDs (paths).
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
  // so this is usually redundant -- but covers the edge case where
  // the root has no DEPENDS_ON edges and the JOIN returns null in
  // some intermediate step.
  if (!ids.includes(repoPath)) ids.unshift(repoPath);

  log.debug({ repo: repoPath, closure: ids.length }, 'resolved dependency closure');
  return ids;
}

// ---------------------------------------------------------------------------
// Vector search
// ---------------------------------------------------------------------------

/**
 * Hybrid vector ANN search scoped to the given repos.
 * Returns up to `limit` entities ranked by vector similarity.
 *
 * Falls back to gracefully returning [] if:
 *  - the entities table doesn't exist yet
 *  - the query vector is empty (embedding unavailable)
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

  const table = await getEntitiesTable(db);
  if (!table) {
    log.warn('searchEntities: entities table not found');
    return [];
  }

  // Build a SQL-style IN clause for repo filtering
  const safeRepos = closureRepos.map(r => r.replace(/'/g, "''"));
  const repoFilter = safeRepos.map(r => `'${r}'`).join(', ');

  // Build WHERE clause with optional artifact filter
  const conditions = [`repo IN (${repoFilter})`];
  if (filter === 'code')     conditions.push('artifact = false');
  if (filter === 'artifact') conditions.push('artifact = true');
  const where = conditions.join(' AND ');

  const t0 = Date.now();
  // LanceDB vector search with pre-filter
  const rows = await table
    .vectorSearch(queryVec)
    .distanceType('cosine')
    .where(where)
    .limit(limit)
    .toArray();

  const results = rows.map(r => rowToEntity(r as Record<string, unknown>));
  const elapsed = `${Date.now() - t0}ms`;
  log.info({ hits: results.length, limit, filter, elapsed }, 'vector search');
  log.debug({ names: results.map(e => `${e.kind}:${e.name}`), where, elapsed }, 'vector search details');
  return results;
}

// ---------------------------------------------------------------------------
// Graph queries
// ---------------------------------------------------------------------------

/** Fetch Entity stubs from Kuzu then hydrate from LanceDB. */
async function hydrateIds(db: DbClient, ids: string[]): Promise<Entity[]> {
  if (ids.length === 0) return [];
  const table = await getEntitiesTable(db);
  if (!table) return [];

  const safeIds  = ids.map(id => id.replace(/'/g, "''"));
  const idFilter = safeIds.map(id => `'${id}'`).join(', ');

  const rows = await table
    .query()
    .where(`id IN (${idFilter})`)
    .toArray();

  return rows.map(r => rowToEntity(r as Record<string, unknown>));
}

/**
 * Find all entities that directly call the entity with the given id.
 * (1-hop CALLS predecessors)
 */
export async function findCallers(db: DbClient, entityId: string): Promise<Entity[]> {
  const ids = await neighborIds(db, entityId, 'CALLS', 'inbound');
  const results = await hydrateIds(db, ids);
  log.debug({ entity: entityId, callers: results.length }, 'findCallers');
  return results;
}

/**
 * Find all entities directly called by the entity with the given id.
 * (1-hop CALLS successors)
 */
export async function findCallees(db: DbClient, entityId: string): Promise<Entity[]> {
  const ids = await neighborIds(db, entityId, 'CALLS', 'outbound');
  const results = await hydrateIds(db, ids);
  log.debug({ entity: entityId, callees: results.length }, 'findCallees');
  return results;
}

/**
 * Find all entities defined in a file (DEFINES edges from the File entity).
 */
export async function findDefinedIn(db: DbClient, fileEntityId: string): Promise<Entity[]> {
  const ids = await neighborIds(db, fileEntityId, 'DEFINES', 'outbound');
  const results = await hydrateIds(db, ids);
  log.debug({ file: fileEntityId, defined: results.length }, 'findDefinedIn');
  return results;
}

/**
 * Find all files/modules that a file entity imports (IMPORTS edges).
 */
export async function findImports(db: DbClient, fileEntityId: string): Promise<Entity[]> {
  const ids = await neighborIds(db, fileEntityId, 'IMPORTS', 'outbound');
  const results = await hydrateIds(db, ids);
  log.debug({ file: fileEntityId, imports: results.length }, 'findImports');
  return results;
}

/**
 * Unified 1-hop neighbour lookup over the DuckDB `relation` table.
 * Direction `'inbound'` means "edges pointing TO entityId";
 * `'outbound'` means "edges pointing FROM entityId". Callers hydrate
 * the full Entity row from LanceDB separately (see hydrateIds).
 */
type EdgeDirection = 'inbound' | 'outbound';

async function neighborIds(
  db: DbClient,
  entityId: string,
  kind: string,
  direction: EdgeDirection,
): Promise<string[]> {
  // Single relation table; direction selects which column matches
  // the input id and which column we return as the neighbour. The
  // forward / reverse indexes (idx_relation_fwd / idx_relation_rev)
  // make both directions index-served.
  const matchCol  = direction === 'inbound' ? 'dst' : 'src';
  const returnCol = direction === 'inbound' ? 'src' : 'dst';
  const rows = await db.duck.query<{ id: string }>(
    `SELECT ${returnCol} AS id FROM relation WHERE ${matchCol} = ? AND kind = ?`,
    [entityId, kind],
  );
  return rows.map(r => r.id).filter(Boolean);
}
