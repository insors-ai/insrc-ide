import { Schema, Field, Utf8, Int32, Bool, Float32, FixedSizeList } from 'apache-arrow';
import type { Table } from '@lancedb/lancedb';
import type { DbClient } from './client.js';
import type { Entity, EntityKind, Language } from '../shared/types.js';
import { loadConfig } from '../agent/config.js';
import { shouldWriteDuckGraph, shouldWriteKuzuGraph } from './graph-dual-write.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('db:entities');

const EMBEDDING_DIM = loadConfig().models.providers.local.embeddingDim;

// ---------------------------------------------------------------------------
// Apache Arrow schema for the LanceDB 'entities' table.
// All fields are non-nullable — avoids Bool null-bitmap bugs and type-
// inference failures on first insert. Empty string '' is the sentinel for
// optional Utf8 fields that are absent; false for optional booleans.
// ---------------------------------------------------------------------------
const ENTITIES_SCHEMA = new Schema([
  new Field('id',             new Utf8(),   false),
  new Field('kind',           new Utf8(),   false),
  new Field('name',           new Utf8(),   false),
  new Field('language',       new Utf8(),   false),
  new Field('repo',           new Utf8(),   false),
  new Field('file',           new Utf8(),   false),
  new Field('startLine',      new Int32(),  false),
  new Field('endLine',        new Int32(),  false),
  new Field('body',           new Utf8(),   false),
  new Field('indexedAt',      new Utf8(),   false),
  new Field('embeddingModel', new Utf8(),   false),
  new Field('isExported',     new Bool(),   false),
  new Field('isAsync',        new Bool(),   false),
  new Field('isAbstract',     new Bool(),   false),
  new Field('signature',      new Utf8(),   false),
  new Field('hash',           new Utf8(),   false),
  new Field('rootPath',       new Utf8(),   false),
  new Field('artifact',       new Bool(),   false),
  new Field('vector', new FixedSizeList(EMBEDDING_DIM, new Field('item', new Float32(), true)), false),
]);

// Module-level cache — re-used across calls within the same daemon process
let _table: Table | null = null;

async function getEntitiesTable(db: DbClient): Promise<Table | null> {
  if (_table !== null) return _table;
  const names = await db.lance.tableNames();
  if (!names.includes('entities')) return null;
  _table = await db.lance.openTable('entities');
  return _table;
}

/** Helper: run a Kuzu query (with optional params) and return all rows. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function kuzuExec(db: DbClient, stmt: string, params?: any): Promise<Record<string, unknown>[]> {
  let result;
  if (params) {
    const prepared = await db.graph.prepare(stmt);
    result = await db.graph.execute(prepared, params);
  } else {
    result = await db.graph.query(stmt);
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const qr = Array.isArray(result) ? result[0]! : result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (qr as any).getAll() as Promise<Record<string, unknown>[]>;
}

// ---------------------------------------------------------------------------
// Kuzu → DuckDB graph migration -- write-side dispatch helpers.
// plans/storage-migration-duckdb.md Phase A.3.
//
// These helpers wrap each Kuzu write operation with an optional DuckDB
// mirror call. The mode is set by env var INSRC_GRAPH_BACKEND
// (kuzu|both|duckdb); see graph-dual-write.ts. Default (`kuzu`) is
// today's behaviour exactly. `both` activates the dual-write for A.8
// validation. `duckdb` cuts Kuzu writes after A.10.
//
// DuckDB write failures during dual-write are caught + logged but do
// NOT fail the overall operation -- Kuzu remains source of truth
// during A.8. After A.10 cutover, errors propagate (Kuzu writes are
// already off, so no fallback exists).
// ---------------------------------------------------------------------------

/** MERGE the Entity stub node: insert if absent, otherwise update kind. */
async function upsertEntityStub(db: DbClient, id: string, kind: string): Promise<void> {
  if (shouldWriteKuzuGraph()) {
    await kuzuExec(db, 'MERGE (n:Entity {id: $id}) SET n.kind = $kind', { id, kind });
  }
  if (shouldWriteDuckGraph()) {
    await runDuckOrLog(
      () => db.duck.exec(
        'INSERT INTO entity (id, kind) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind',
        [id, kind],
      ),
      { op: 'upsertEntityStub', id },
    );
  }
}

/**
 * Batched DETACH-DELETE equivalent: remove the given entity ids from
 * the graph along with all incident edges. The Kuzu side runs one
 * `DETACH DELETE` per chunk; the DuckDB side runs a relation-cleanup
 * DELETE followed by an entity DELETE in a transaction so partial
 * failures don't leave dangling edges.
 */
const ENTITY_DELETE_CHUNK = 500;
async function detachDeleteEntityStubs(db: DbClient, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  for (let i = 0; i < ids.length; i += ENTITY_DELETE_CHUNK) {
    const chunk = ids.slice(i, i + ENTITY_DELETE_CHUNK);
    if (shouldWriteKuzuGraph()) {
      await kuzuExec(
        db,
        'MATCH (n:Entity) WHERE n.id IN $ids DETACH DELETE n',
        { ids: chunk },
      );
    }
    if (shouldWriteDuckGraph()) {
      await runDuckOrLog(
        async () => {
          // Relations first so a partial-failure between the two
          // statements never leaves dangling edges. The opposite order
          // (entities first) would orphan edges -- worse than the
          // alternative orphan: entity rows without incoming/outgoing
          // edges, which are harmless until garbage-collected. We rely
          // on this ordering instead of an explicit transaction
          // because GraphClient acquires a fresh Connection per call;
          // wrapping in BEGIN/COMMIT across calls breaks (the COMMIT
          // would land on a different Connection than the BEGIN).
          //
          // DuckDB doesn't support `IN $array` named-binding the way Kuzu
          // does; expand to positional placeholders. 500-chunk keeps the
          // generated SQL bounded.
          const placeholders = chunk.map(() => '?').join(', ');
          await db.duck.exec(
            `DELETE FROM relation WHERE src IN (${placeholders}) OR dst IN (${placeholders})`,
            [...chunk, ...chunk],
          );
          await db.duck.exec(
            `DELETE FROM entity WHERE id IN (${placeholders})`,
            [...chunk],
          );
        },
        { op: 'detachDeleteEntityStubs', count: chunk.length },
      );
    }
  }
}

/**
 * Wrap a DuckDB write so its failure is logged + counted but doesn't
 * abort the overall operation. Used during the dual-write phase (A.8)
 * where Kuzu remains source of truth. Once we move to mode='duckdb'
 * (post-A.10), the dual-write helpers run only the DuckDB branch and
 * errors propagate naturally.
 */
async function runDuckOrLog(
  fn: () => Promise<void>,
  ctx: Record<string, unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ ...ctx, err: msg }, 'duck graph write failed (dual-write); continuing on Kuzu');
  }
}

// ---------------------------------------------------------------------------
// Row ↔ Entity mapping
// ---------------------------------------------------------------------------

const ZERO_VEC = new Array<number>(EMBEDDING_DIM).fill(0);

function entityToRow(entity: Entity): Record<string, unknown> {
  return {
    id:             entity.id,
    kind:           entity.kind,
    name:           entity.name,
    language:       entity.language,
    repo:           entity.repo,
    file:           entity.file,
    startLine:      entity.startLine,
    endLine:        entity.endLine,
    body:           entity.body,
    indexedAt:      entity.indexedAt,
    embeddingModel: entity.embeddingModel ?? '',
    // Non-nullable with sentinels: false / '' for absent optional fields
    isExported:     entity.isExported  ?? false,
    isAsync:        entity.isAsync     ?? false,
    isAbstract:     entity.isAbstract  ?? false,
    signature:      entity.signature   ?? '',
    hash:           entity.hash        ?? '',
    rootPath:       entity.rootPath    ?? '',
    artifact:       entity.artifact    ?? false,
    vector:         entity.embedding.length === EMBEDDING_DIM ? entity.embedding : ZERO_VEC,
  };
}

function rowToEntity(row: Record<string, unknown>): Entity {
  const entity: Entity = {
    id:        row['id']        as string,
    kind:      row['kind']      as EntityKind,
    name:      row['name']      as string,
    language:  row['language']  as Language,
    repo:      row['repo']      as string,
    file:      row['file']      as string,
    startLine: row['startLine'] as number,
    endLine:   row['endLine']   as number,
    body:      row['body']      as string,
    indexedAt: row['indexedAt'] as string,
    embedding: (row['vector']   as number[]) ?? [],
  };
  // Optional fields — '' / false are sentinels for "not set"
  const em = row['embeddingModel'] as string;  if (em)           entity.embeddingModel = em;
  if (row['isExported'] === true)  entity.isExported  = true;
  if (row['isAsync']    === true)  entity.isAsync     = true;
  if (row['isAbstract'] === true)  entity.isAbstract  = true;
  const sg = row['signature'] as string;       if (sg)           entity.signature      = sg;
  const hh = row['hash']      as string;       if (hh)           entity.hash           = hh;
  const rp = row['rootPath']  as string;       if (rp)           entity.rootPath       = rp;
  if (row['artifact'] === true) entity.artifact = true;
  return entity;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Insert a batch of entities into LanceDB and create corresponding Kuzu
 * Entity stub nodes for graph traversal.
 * The indexer pre-deletes file entities before calling this, so add() suffices.
 */
export async function upsertEntities(db: DbClient, entities: Entity[]): Promise<void> {
  if (entities.length === 0) return;
  const rows = entities.map(entityToRow);

  // Create table with explicit schema on first use, or append to existing
  let table = await getEntitiesTable(db);
  if (table === null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _table = await (db.lance as any).createEmptyTable('entities', ENTITIES_SCHEMA);
    table = _table!;
  }
  await table.add(rows);

  // Create lightweight Entity stubs in the graph for edge endpoints.
  // Dispatches to Kuzu, DuckDB, or both based on INSRC_GRAPH_BACKEND
  // (see graph-dual-write.ts).
  for (const e of entities) {
    await upsertEntityStub(db, e.id, e.kind);
  }
}

/**
 * Delete all entity records whose `file` field matches the given path.
 * Also DETACH DELETEs the corresponding Kuzu stubs (removes connected edges too).
 */
export async function deleteEntitiesForFile(db: DbClient, filePath: string): Promise<void> {
  const table = await getEntitiesTable(db);
  if (table === null) return;

  const safeFile = filePath.replace(/'/g, "''");
  const rows = await table.query().where(`file = '${safeFile}'`).select(['id']).toArray();
  await table.delete(`file = '${safeFile}'`);

  await detachDeleteEntities(db, rows.map(r => r['id'] as string));
}

/**
 * Delete all entity records belonging to a repo.
 */
export async function deleteEntitiesForRepo(db: DbClient, repo: string): Promise<void> {
  const table = await getEntitiesTable(db);
  if (table === null) return;

  const safeRepo = repo.replace(/'/g, "''");
  const rows = await table.query().where(`repo = '${safeRepo}'`).select(['id']).toArray();
  await table.delete(`repo = '${safeRepo}'`);

  await detachDeleteEntities(db, rows.map(r => r['id'] as string));
}

/**
 * Batch DETACH DELETE Entity stubs. One round-trip per chunk vs. one
 * round-trip per entity makes a 50k-entity repo purge drop from
 * ~40 s to <2 s. Dispatches to Kuzu, DuckDB, or both based on
 * INSRC_GRAPH_BACKEND.
 */
async function detachDeleteEntities(db: DbClient, ids: readonly string[]): Promise<void> {
  await detachDeleteEntityStubs(db, ids);
}

/**
 * Fetch a single entity by its stable ID. Returns null if not found.
 */
export async function getEntity(db: DbClient, id: string): Promise<Entity | null> {
  const table = await getEntitiesTable(db);
  if (table === null) return null;
  const safeId = id.replace(/'/g, "''");
  const rows = await table.query().where(`id = '${safeId}'`).limit(1).toArray();
  return rows[0] ? rowToEntity(rows[0] as Record<string, unknown>) : null;
}

/**
 * Batched form of getEntity. Returns the matched subset (no null
 * placeholders); ids that don't match are omitted. Order is not
 * preserved -- caller should re-key by id if it needs lookup.
 *
 * Chunked at 500 to bound the SQL string size + prepared-statement
 * parameter memory, matching eeae2ef7ac7's DETACH DELETE chunk size.
 */
export async function getEntitiesByIds(
  db: DbClient,
  ids: readonly string[],
): Promise<Entity[]> {
  if (ids.length === 0) return [];
  const table = await getEntitiesTable(db);
  if (table === null) return [];

  const CHUNK = 500;
  const out: Entity[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const safe = slice.map(id => id.replace(/'/g, "''"));
    const inList = safe.map(id => `'${id}'`).join(', ');
    const rows = await table.query().where(`id IN (${inList})`).toArray();
    for (const r of rows) {
      out.push(rowToEntity(r as Record<string, unknown>));
    }
  }
  return out;
}

/**
 * Find entities by name + kind filter. Intended for structured
 * lookups (e.g. the artifact:er kind resolving user-supplied table
 * names into Entity rows) where the caller knows the exact name but
 * not the id. Returns all matches up to `limit`. Optional `repo`
 * narrows the search to a single repo root.
 *
 * Uses a plain LanceDB filter -- no vector search, no embeddings
 * required.
 */
export async function findEntitiesByName(
  db: DbClient,
  names: readonly string[],
  opts: { readonly kinds?: readonly EntityKind[] | undefined; readonly repo?: string | undefined; readonly limit?: number | undefined } = {},
): Promise<Entity[]> {
  if (names.length === 0) { return []; }
  const table = await getEntitiesTable(db);
  if (table === null) { return []; }

  const safeNames = names.map(n => n.replace(/'/g, "''"));
  const nameFilter = safeNames.map(n => `'${n}'`).join(', ');
  const conditions: string[] = [`name IN (${nameFilter})`];

  if (opts.kinds !== undefined && opts.kinds.length > 0) {
    const safeKinds = opts.kinds.map(k => k.replace(/'/g, "''"));
    const kindFilter = safeKinds.map(k => `'${k}'`).join(', ');
    conditions.push(`kind IN (${kindFilter})`);
  }
  if (opts.repo !== undefined) {
    const safeRepo = opts.repo.replace(/'/g, "''");
    conditions.push(`repo = '${safeRepo}'`);
  }

  const limit = opts.limit !== undefined ? opts.limit : 50;
  const rows = await table.query()
    .where(conditions.join(' AND '))
    .limit(limit)
    .toArray();
  return rows.map(r => rowToEntity(r as Record<string, unknown>));
}

/**
 * List all entities belonging to a repo.
 */
export async function listEntitiesForRepo(db: DbClient, repo: string): Promise<Entity[]> {
  const table = await getEntitiesTable(db);
  if (table === null) return [];
  const safeRepo = repo.replace(/'/g, "''");
  const rows = await table.query().where(`repo = '${safeRepo}'`).toArray();
  return rows.map(r => rowToEntity(r as Record<string, unknown>));
}

/**
 * List entities not yet embedded (embeddingModel = '' sentinel).
 */
export async function listUnembeddedEntities(db: DbClient, repo: string): Promise<Entity[]> {
  const table = await getEntitiesTable(db);
  if (table === null) return [];
  const safeRepo = repo.replace(/'/g, "''");
  const rows = await table.query()
    .where(`repo = '${safeRepo}' AND embeddingModel = ''`)
    .toArray();
  return rows.map(r => rowToEntity(r as Record<string, unknown>));
}

/**
 * Update the embedding vector and model name for an entity (used by the reembed job).
 */
export async function updateEmbedding(
  db: DbClient,
  id: string,
  embedding: number[],
  embeddingModel: string,
): Promise<void> {
  const table = await getEntitiesTable(db);
  if (table === null) return;
  const safeId = id.replace(/'/g, "''");
  const rows = await table.query().where(`id = '${safeId}'`).limit(1).toArray();
  if (rows.length === 0) return;

  const updated = { ...(rows[0] as Record<string, unknown>), vector: embedding, embeddingModel };
  await table.delete(`id = '${safeId}'`);
  await table.add([updated]);
}
