/**
 * DuckDB-backed entity persistence (plans/storage-migration-duckdb.md
 * Phase B.6). Replaces the LanceDB Arrow-record path with plain SQL
 * against the `entity` table on the storage pool.
 *
 * The same `entity` table holds both the graph stub (id, kind --
 * referenced by `relation.src/dst`) and the full entity row (body,
 * embedding, etc.). A single upsert path keeps stubs and full rows in
 * sync; columns absent from a stub upsert simply stay at their
 * SQL-DEFAULT sentinels (empty string, 0, false). Vector search
 * happens via `array_distance(embedding, ?)` against the HNSW index;
 * brute-force fallback works on tables small enough to scan if the
 * vss extension fails to load (logged at storage-pool init).
 */

import { arrayValue } from '@duckdb/node-api';
import type { DbClient } from './client.js';
import type { Entity, EntityKind, Language } from '../shared/types.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('db.entities');

// ---------------------------------------------------------------------------
// Row <-> domain mapping (snake_case columns <-> camelCase Entity fields)
// ---------------------------------------------------------------------------

function entityToParams(entity: Entity): unknown[] {
  return [
    entity.id,
    entity.kind,
    entity.name,
    entity.language,
    entity.repo,
    entity.file,
    entity.startLine,
    entity.endLine,
    entity.body,
    entity.indexedAt,
    entity.embeddingModel ?? '',
    entity.isExported  ?? false,
    entity.isAsync     ?? false,
    entity.isAbstract  ?? false,
    entity.signature   ?? '',
    entity.hash        ?? '',
    entity.rootPath    ?? '',
    entity.artifact    ?? false,
    entity.embedding.length > 0 ? arrayValue(entity.embedding) : null,
  ];
}

const ENTITY_COLUMNS = [
  'id', 'kind', 'name', 'language', 'repo', 'file', 'start_line', 'end_line',
  'body', 'indexed_at', 'embedding_model',
  'is_exported', 'is_async', 'is_abstract',
  'signature', 'hash', 'root_path', 'artifact', 'embedding',
] as const;
const ENTITY_PLACEHOLDER = `(${ENTITY_COLUMNS.map(() => '?').join(', ')})`;
const ENTITY_ON_CONFLICT = `ON CONFLICT (id) DO UPDATE SET
  kind            = excluded.kind,
  name            = excluded.name,
  language        = excluded.language,
  repo            = excluded.repo,
  file            = excluded.file,
  start_line      = excluded.start_line,
  end_line        = excluded.end_line,
  body            = excluded.body,
  indexed_at      = excluded.indexed_at,
  embedding_model = excluded.embedding_model,
  is_exported     = excluded.is_exported,
  is_async        = excluded.is_async,
  is_abstract     = excluded.is_abstract,
  signature       = excluded.signature,
  hash            = excluded.hash,
  root_path       = excluded.root_path,
  artifact        = excluded.artifact,
  embedding       = excluded.embedding`;

// Module entities are pure-stub graph nodes (file='', body='', embedding=[])
// referenced by IMPORTS edges. The parser emits the same module stub once
// per importing file -- the second-and-later sightings should be no-ops,
// matching the parser's "ensure exists" intent. DO UPDATE here would
// re-issue an INSERT against the embedding column and trip DuckDB's
// experimental HNSW index ("Duplicate keys not allowed in high-level
// wrappers") via WAL-replay on row ids that already exist. The cross-file
// resolver later rewires in-tree module IMPORTS to point at the real file
// entity (cross-file-resolver.ts Pass 1), so stub rows are never updated
// after creation.
const ENTITY_ON_CONFLICT_NOTHING = 'ON CONFLICT (id) DO NOTHING';

/**
 * Cap on rows-per-INSERT for the bulk path. 100 rows × 19 columns =
 * 1.9k positional parameters, well below DuckDB's prepared-statement
 * cap. Tuned for the indexer's typical per-file entity count
 * (5-200); chunked above this so the parameter array doesn't grow
 * unboundedly on full-repo upserts.
 */
const ENTITY_BULK_CHUNK = 100;

/**
 * DuckDB returns FLOAT[N] columns as `{ items: number[] }` (the
 * DuckDBArrayValue runtime shape). Unwrap to a plain number[] for
 * the Entity contract; null becomes an empty array (entities
 * without an embedding yet). Exported so search.ts and any other
 * downstream entity-row consumers share the same mapper.
 */
export function unwrapEmbedding(raw: unknown): number[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw as number[];
  const inner = (raw as { items?: unknown }).items;
  return Array.isArray(inner) ? (inner as number[]) : [];
}

/**
 * Map a snake_case `entity` row from DuckDB back to the camelCase
 * Entity domain shape. Optional fields stay `undefined` when their
 * sentinel default (empty string / false) is observed -- matches
 * the LanceDB-era contract so callers see the same object shape.
 */
export function rowToEntity(row: Record<string, unknown>): Entity {
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
// CRUD
// ---------------------------------------------------------------------------

/**
 * Pre-INSERT dedupe by entity id. The bulk multi-VALUES INSERT path
 * cannot rely on `ON CONFLICT DO UPDATE` to absorb intra-batch
 * duplicates -- DuckDB's HNSW index wrapper validates uniqueness
 * during statement execution, BEFORE the conflict clause fires.
 * Two rows with the same id in one VALUES clause crash with
 * "Duplicate keys not allowed in high-level wrappers" and
 * invalidate the entire DuckDB instance for the rest of the
 * process lifetime.
 *
 * Last-write-wins matches the semantics `ON CONFLICT (id) DO UPDATE`
 * would have produced if the rows were issued one at a time. That's
 * intentional: a duplicate in the input is a parser-side bug
 * (typically Java/Scala/C++ method overloads collapsing into the
 * same `SHA256(repo + file + kind + name)` -- the formula doesn't
 * include signature), and the right v1 behavior is to keep one row
 * + log a warning so we can investigate upstream.
 */
function dedupeEntitiesById(entities: readonly Entity[]): {
  unique: Entity[];
  duplicateIds: Map<string, number>;
} {
  const map = new Map<string, Entity>();
  const dupCounts = new Map<string, number>();
  for (const e of entities) {
    if (map.has(e.id)) dupCounts.set(e.id, (dupCounts.get(e.id) ?? 1) + 1);
    map.set(e.id, e);  // last-wins
  }
  return { unique: [...map.values()], duplicateIds: dupCounts };
}

/**
 * Upsert a batch of entities. Bulk multi-VALUES INSERT chunked at
 * ENTITY_BULK_CHUNK rows per call -- the prior per-row loop made one
 * round-trip + one Connection acquire per entity, which dominated the
 * indexer's per-file cost (50-200 entities × ~1ms/row vs ~10ms for
 * the whole batch in one statement). Embeddings travel through
 * alongside row data; rows without embeddings (the indexer's first
 * pass) get NULL in the embedding column and the embedder fills
 * them in later.
 *
 * ON CONFLICT (id) DO UPDATE covers re-indexing across calls; the
 * previous implementation pre-deleted file entities before insert,
 * but the new pattern leaves that to `deleteEntitiesForFile` for
 * explicit purges.
 *
 * Within a single call the input is deduped by id BEFORE chunking
 * (see dedupeEntitiesById) -- the HNSW index wrapper rejects
 * intra-batch duplicates fatally. A duplicate id in the input
 * usually means the parser emitted two entities with identical
 * `(repo, file, kind, name)`; the fix at this layer keeps one row
 * (last-wins) and logs a warning. Per-batch INSERTs are wrapped in
 * try/catch so an unexpected duplicate (e.g. one slipping through
 * a future parser change) produces actionable diagnostic output
 * instead of a cryptic "database has been invalidated" cascade.
 */
export async function upsertEntities(db: DbClient, entities: Entity[]): Promise<void> {
  if (entities.length === 0) return;

  const { unique, duplicateIds } = dedupeEntitiesById(entities);
  if (duplicateIds.size > 0) {
    // Log a representative sample so the parser bug is investigable
    // without flooding the log on a wide-fanout case.
    const sample: { id: string; count: number; name: string; kind: string; file: string }[] = [];
    for (const [id, count] of duplicateIds) {
      const ent = unique.find(e => e.id === id);
      if (ent === undefined) continue;
      sample.push({ id, count, name: ent.name, kind: ent.kind, file: ent.file });
      if (sample.length >= 5) break;
    }
    log.warn(
      {
        totalDuplicates: duplicateIds.size,
        kept: unique.length,
        original: entities.length,
        sample,
      },
      'upsertEntities: collapsed duplicate entity ids in input batch (last-wins). ' +
      'This usually indicates a parser emitting two entities with identical (repo, file, kind, name) -- ' +
      'common for overloaded Java/Scala methods since the id formula doesn\'t include signature.',
    );
  }

  // Split: module stubs use DO NOTHING (ensure-exists), everything else
  // uses DO UPDATE (re-parse may carry new body / signature / line range).
  const modules: Entity[] = [];
  const others:  Entity[] = [];
  for (const e of unique) {
    if (e.kind === 'module') modules.push(e); else others.push(e);
  }
  await runChunkedInsert(db, modules, ENTITY_ON_CONFLICT_NOTHING);
  await runChunkedInsert(db, others,  ENTITY_ON_CONFLICT);
}

async function runChunkedInsert(
  db: DbClient,
  rows: Entity[],
  conflictClause: string,
): Promise<void> {
  for (let i = 0; i < rows.length; i += ENTITY_BULK_CHUNK) {
    const chunk = rows.slice(i, i + ENTITY_BULK_CHUNK);
    const placeholders = chunk.map(() => ENTITY_PLACEHOLDER).join(', ');
    const params: unknown[] = [];
    for (const e of chunk) params.push(...entityToParams(e));
    const sql =
      `INSERT INTO entity (${ENTITY_COLUMNS.join(', ')})
       VALUES ${placeholders}
       ${conflictClause}`;
    try {
      await db.duck.exec(sql, params as never[]);
    } catch (err) {
      // Defense-in-depth: dedupeEntitiesById should have caught any
      // intra-batch duplicate, so reaching here means either an
      // unrelated SQL error or an HNSW collision against an EXISTING
      // row (which the wrapper apparently also rejects in some
      // versions before ON CONFLICT can fire). Log structured info so
      // the next failure is debuggable, then re-throw -- the caller's
      // per-file try/catch handles the file-level skip.
      const msg = err instanceof Error ? err.message : String(err);
      const looksLikeHnswCollision = msg.includes('Duplicate keys not allowed')
        || msg.includes('HNSW');
      if (looksLikeHnswCollision) {
        log.error(
          {
            chunkIndex: i / ENTITY_BULK_CHUNK,
            chunkSize: chunk.length,
            firstFile: chunk[0]?.file,
            firstId: chunk[0]?.id,
            sampleIds: chunk.slice(0, 3).map(e => ({ id: e.id, name: e.name, kind: e.kind })),
            err: msg.slice(0, 500),
          },
          'upsertEntities: HNSW duplicate-key error from DuckDB; chunk rejected. ' +
          'After-effects may include "database has been invalidated" on subsequent statements -- ' +
          'a daemon restart is required if that surfaces.',
        );
      }
      throw err;
    }
  }
}

/**
 * Detach-delete pattern: edges first, then rows. Order matters so a
 * partial failure never leaves dangling edges. Mirrors the helper
 * semantics from the Phase A Kuzu rip-out (no transaction wrap --
 * GraphClient acquires fresh Connection per call).
 */
const ENTITY_DELETE_CHUNK = 500;
async function detachDeleteEntities(db: DbClient, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  for (let i = 0; i < ids.length; i += ENTITY_DELETE_CHUNK) {
    const chunk = ids.slice(i, i + ENTITY_DELETE_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    await db.duck.exec(
      `DELETE FROM relation WHERE src IN (${placeholders}) OR dst IN (${placeholders})`,
      [...chunk, ...chunk],
    );
    await db.duck.exec(
      `DELETE FROM entity WHERE id IN (${placeholders})`,
      [...chunk],
    );
  }
}

/**
 * Delete every entity row whose `file` matches the given path. Also
 * removes incident edges so the graph stays clean.
 */
export async function deleteEntitiesForFile(db: DbClient, filePath: string): Promise<void> {
  const rows = await db.duck.query<{ id: string }>(
    'SELECT id FROM entity WHERE file = ?',
    [filePath],
  );
  await detachDeleteEntities(db, rows.map(r => r.id));
}

/**
 * Delete every entity row belonging to a repo. Used by `repo.remove`.
 */
export async function deleteEntitiesForRepo(db: DbClient, repo: string): Promise<void> {
  const rows = await db.duck.query<{ id: string }>(
    'SELECT id FROM entity WHERE repo = ?',
    [repo],
  );
  await detachDeleteEntities(db, rows.map(r => r.id));
}

/** Fetch a single entity by its stable ID. Returns null if not found. */
export async function getEntity(db: DbClient, id: string): Promise<Entity | null> {
  const rows = await db.duck.query('SELECT * FROM entity WHERE id = ?', [id]);
  if (rows.length === 0) return null;
  return rowToEntity(rows[0]!);
}

/**
 * Batched form of getEntity. Returns the matched subset (no null
 * placeholders); ids that don't match are omitted. Order is not
 * preserved -- caller should re-key by id if it needs lookup. Chunked
 * at 500 to bound the SQL string size + prepared-statement parameter
 * memory.
 */
export async function getEntitiesByIds(
  db: DbClient,
  ids: readonly string[],
): Promise<Entity[]> {
  if (ids.length === 0) return [];

  const CHUNK = 500;
  const out: Entity[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(', ');
    const rows = await db.duck.query(
      `SELECT * FROM entity WHERE id IN (${placeholders})`,
      [...slice],
    );
    for (const r of rows) out.push(rowToEntity(r));
  }
  return out;
}

/**
 * Find entities by name + kind filter. Intended for structured
 * lookups (e.g. the artifact:er kind resolving user-supplied table
 * names into Entity rows) where the caller knows the exact name but
 * not the id. Returns all matches up to `limit`.
 */
export async function findEntitiesByName(
  db: DbClient,
  names: readonly string[],
  opts: { readonly kinds?: readonly EntityKind[] | undefined; readonly repo?: string | undefined; readonly limit?: number | undefined } = {},
): Promise<Entity[]> {
  if (names.length === 0) return [];

  const namePlaceholders = names.map(() => '?').join(', ');
  const conditions: string[] = [`name IN (${namePlaceholders})`];
  const params: unknown[] = [...names];

  if (opts.kinds !== undefined && opts.kinds.length > 0) {
    const kindPlaceholders = opts.kinds.map(() => '?').join(', ');
    conditions.push(`kind IN (${kindPlaceholders})`);
    params.push(...opts.kinds);
  }
  if (opts.repo !== undefined) {
    conditions.push('repo = ?');
    params.push(opts.repo);
  }

  const limit = opts.limit !== undefined ? opts.limit : 50;
  const rows = await db.duck.query(
    `SELECT * FROM entity WHERE ${conditions.join(' AND ')} LIMIT ${limit}`,
    params as never[],
  );
  return rows.map(rowToEntity);
}

/** List all entities belonging to a repo. */
export async function listEntitiesForRepo(db: DbClient, repo: string): Promise<Entity[]> {
  const rows = await db.duck.query('SELECT * FROM entity WHERE repo = ?', [repo]);
  return rows.map(rowToEntity);
}

/** List all entities defined in a single file (used by search.by_file IPC). */
export async function findEntitiesByFile(db: DbClient, file: string): Promise<Entity[]> {
  const rows = await db.duck.query('SELECT * FROM entity WHERE file = ?', [file]);
  return rows.map(rowToEntity);
}

/** List entities not yet embedded (embedding_model = '' sentinel). */
export async function listUnembeddedEntities(db: DbClient, repo: string): Promise<Entity[]> {
  const rows = await db.duck.query(
    "SELECT * FROM entity WHERE repo = ? AND embedding_model = ''",
    [repo],
  );
  return rows.map(rowToEntity);
}

/**
 * Update the embedding vector and model name for an entity (used by
 * the reembed job). Assumes the row already exists; no-op if it
 * doesn't (no UPSERT path -- `upsertEntities` covers full creation).
 */
export async function updateEmbedding(
  db: DbClient,
  id: string,
  embedding: number[],
  embeddingModel: string,
): Promise<void> {
  await db.duck.exec(
    'UPDATE entity SET embedding = ?, embedding_model = ? WHERE id = ?',
    [arrayValue(embedding), embeddingModel, id],
  );
}
