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

const INSERT_SQL = `
  INSERT INTO entity (
    id, kind, name, language, repo, file, start_line, end_line,
    body, indexed_at, embedding_model,
    is_exported, is_async, is_abstract,
    signature, hash, root_path, artifact, embedding
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
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
 * Upsert a batch of entities. Replaces the LanceDB add() + Kuzu stub
 * path with a single per-row INSERT ... ON CONFLICT DO UPDATE on the
 * `entity` table. Embeddings travel through alongside row data; rows
 * without embeddings (the indexer's first pass) get NULL in the
 * embedding column and the embedder fills them in later.
 *
 * Per-row SQL avoids the Lance pre-delete pattern; ON CONFLICT covers
 * re-indexing. The previous implementation pre-deleted file entities
 * before insert; the new pattern leaves that responsibility to
 * `deleteEntitiesForFile` for explicit purges.
 */
export async function upsertEntities(db: DbClient, entities: Entity[]): Promise<void> {
  if (entities.length === 0) return;
  for (const e of entities) {
    await db.duck.exec(INSERT_SQL, entityToParams(e) as never[]);
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
