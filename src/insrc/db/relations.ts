import { createHash } from 'node:crypto';
import type { DbClient } from './client.js';
import type { Relation, RelationKind } from '../shared/types.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('db.relations');

/**
 * Upsert a graph relation edge between two Entity stubs.
 * Resolved relations land in the unified `relation(src, dst, kind)`
 * table; unresolved ones go to `unresolved_relation` for the cross-
 * file resolver pass to pick up later. See
 * plans/cross-file-references.md §0.1.
 */
export async function upsertRelation(db: DbClient, relation: Relation): Promise<void> {
  if (!relation.resolved) {
    await upsertUnresolvedRelation(db, relation);
    return;
  }
  // PRIMARY KEY (src, dst, kind) -- ON CONFLICT DO NOTHING is the
  // duplicate-guard equivalent of Cypher MERGE.
  await db.duck.exec(
    'INSERT INTO relation (src, dst, kind) VALUES (?, ?, ?) ON CONFLICT (src, dst, kind) DO NOTHING',
    [relation.from, relation.to, relation.kind],
  );
}

/**
 * Bulk-row chunk size for the multi-VALUES INSERT path. Sized so the
 * positional-parameter array stays well under DuckDB's prepared-
 * statement cap on per-file relation counts (typically <500 per file).
 */
const RELATION_BULK_CHUNK = 200;

/**
 * Upsert multiple relations. Splits resolved vs unresolved up-front
 * (different target tables, different shapes) and bulk-inserts each
 * group via a multi-VALUES INSERT chunked at RELATION_BULK_CHUNK.
 *
 * The prior per-row loop was a measurable hot path during full
 * indexing -- a typical TS file emits ~50-100 relation edges, and
 * one round-trip per edge dominated wall time. Bulk INSERT collapses
 * each chunk into a single Connection acquire + one statement.
 */
export async function upsertRelations(db: DbClient, relations: Relation[]): Promise<void> {
  if (relations.length === 0) return;

  const resolved: Relation[] = [];
  const unresolved: Relation[] = [];
  for (const r of relations) {
    if (r.resolved) resolved.push(r); else unresolved.push(r);
  }

  // Resolved -> relation table. (src, dst, kind), ON CONFLICT DO NOTHING.
  for (let i = 0; i < resolved.length; i += RELATION_BULK_CHUNK) {
    const chunk = resolved.slice(i, i + RELATION_BULK_CHUNK);
    const placeholders = chunk.map(() => '(?, ?, ?)').join(', ');
    const params: unknown[] = [];
    for (const r of chunk) params.push(r.from, r.to, r.kind);
    await db.duck.exec(
      `INSERT INTO relation (src, dst, kind) VALUES ${placeholders}
       ON CONFLICT (src, dst, kind) DO NOTHING`,
      params as never[],
    );
  }

  // Unresolved -> unresolved_relation table. Per-row meta-validation
  // (file/repo presence) means we still iterate, but the INSERT itself
  // batches.
  await upsertUnresolvedRelations(db, unresolved);
}

/**
 * Delete all edges originating from entities in the given file.
 * In practice this is handled by the relation cleanup inside
 * deleteEntitiesForFile() (entities.ts), but kept for explicit call
 * sites in the indexer pipeline.
 */
export async function deleteRelationsForFile(_db: DbClient, _filePath: string): Promise<void> {
  // Edges are removed automatically when entity stubs are deleted via
  // detachDeleteEntityStubs (entities.ts deleteEntitiesForFile). No
  // separate action needed here.
}

/**
 * Delete all edges originating from entities in a repo.
 */
export async function deleteRelationsForRepo(_db: DbClient, _repo: string): Promise<void> {
  // Same as above; cleanup runs through deleteEntitiesForRepo.
}

// ---------------------------------------------------------------------------
// Unresolved relations -- persistence for the cross-file resolver pass.
// See plans/cross-file-references.md §0.
// ---------------------------------------------------------------------------

export interface UnresolvedRelation {
  id:          string;
  repo:        string;
  fromEntity:  string;
  fromFile:    string;
  kind:        RelationKind;
  rawTo:       string;
  meta:        Record<string, unknown>;
  attemptedAt: string;
}

/** Deterministic id — re-parsing the same file produces the same row id. */
export function makeUnresolvedRelationId(
  repo: string,
  fromEntity: string,
  kind: RelationKind,
  rawTo: string,
): string {
  return createHash('sha256')
    .update(`${repo}\x00${fromEntity}\x00${kind}\x00${rawTo}`)
    .digest('hex')
    .slice(0, 32);
}

async function upsertUnresolvedRelation(db: DbClient, relation: Relation): Promise<void> {
  await upsertUnresolvedRelations(db, [relation]);
}

/**
 * Bulk variant. Validates meta + builds the row tuples up-front,
 * then issues one chunked multi-VALUES INSERT per RELATION_BULK_CHUNK
 * group. Drops rows missing meta.file/meta.repo with a debug log
 * (parser invariant -- programming error if it fires).
 */
async function upsertUnresolvedRelations(db: DbClient, relations: Relation[]): Promise<void> {
  if (relations.length === 0) return;

  const attemptedAt = new Date().toISOString();
  const tuples: unknown[][] = [];
  for (const r of relations) {
    const meta     = r.meta ?? {};
    const fromFile = typeof meta['file'] === 'string' ? meta['file'] as string : '';
    const repo     = typeof meta['repo'] === 'string' ? meta['repo'] as string : '';
    if (!fromFile || !repo) {
      log.debug(
        { kind: r.kind, from: r.from, to: r.to },
        'unresolved relation missing meta.file/meta.repo — dropping',
      );
      continue;
    }
    const id       = makeUnresolvedRelationId(repo, r.from, r.kind, r.to);
    const metaJson = JSON.stringify(meta);
    tuples.push([id, repo, r.from, fromFile, r.kind, r.to, metaJson, attemptedAt]);
  }
  if (tuples.length === 0) return;

  for (let i = 0; i < tuples.length; i += RELATION_BULK_CHUNK) {
    const chunk = tuples.slice(i, i + RELATION_BULK_CHUNK);
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const params: unknown[] = [];
    for (const t of chunk) params.push(...t);
    await db.duck.exec(
      `INSERT INTO unresolved_relation
         (id, repo, from_entity, from_file, kind, raw_to, meta, attempted_at)
       VALUES ${placeholders}
       ON CONFLICT (id) DO UPDATE SET
         repo = excluded.repo,
         from_entity = excluded.from_entity,
         from_file = excluded.from_file,
         kind = excluded.kind,
         raw_to = excluded.raw_to,
         meta = excluded.meta,
         attempted_at = excluded.attempted_at`,
      params as never[],
    );
  }
}

/**
 * Load unresolved-relation rows for a repo, optionally scoped to a single
 * source file (used by the incremental settle path).
 */
export async function listUnresolvedRelations(
  db: DbClient,
  repo: string,
  scopeFile?: string,
): Promise<UnresolvedRelation[]> {
  const sql = scopeFile !== undefined
    ? `SELECT id, repo, from_entity, from_file, kind, raw_to, meta, attempted_at
       FROM unresolved_relation WHERE repo = ? AND from_file = ?`
    : `SELECT id, repo, from_entity, from_file, kind, raw_to, meta, attempted_at
       FROM unresolved_relation WHERE repo = ?`;
  const params = scopeFile !== undefined ? [repo, scopeFile] : [repo];
  const rows = await db.duck.query<Record<string, unknown>>(sql, params);
  return rows.map(rowToUnresolved);
}

function rowToUnresolved(row: Record<string, unknown>): UnresolvedRelation {
  let meta: Record<string, unknown> = {};
  const raw = row['meta'];
  if (typeof raw === 'string' && raw.length > 0) {
    try { meta = JSON.parse(raw) as Record<string, unknown>; } catch { /* corrupt — leave empty */ }
  }
  return {
    id:          row['id']           as string,
    repo:        row['repo']         as string,
    fromEntity:  row['from_entity']  as string,
    fromFile:    row['from_file']    as string,
    kind:        row['kind']         as RelationKind,
    rawTo:       row['raw_to']       as string,
    meta,
    attemptedAt: row['attempted_at'] as string,
  };
}

/**
 * Drop all UnresolvedRelation rows whose source file matches. Called on
 * per-file re-index alongside deleteEntitiesForFile so that stale rows
 * from a previous parse don't linger when the parser re-emits the
 * canonical set.
 */
export async function deleteUnresolvedForFile(db: DbClient, file: string): Promise<void> {
  await db.duck.exec('DELETE FROM unresolved_relation WHERE from_file = ?', [file]);
}

/**
 * Drop all UnresolvedRelation rows belonging to a repo. Used by the
 * `repo.remove` cleanup so unresolved edges don't linger when the
 * repo is detached from the registry.
 */
export async function deleteUnresolvedForRepo(db: DbClient, repo: string): Promise<void> {
  await db.duck.exec('DELETE FROM unresolved_relation WHERE repo = ?', [repo]);
}

/**
 * On successful cross-file resolution: insert the typed REL edge and
 * delete the matching UnresolvedRelation row.
 */
export async function promoteToResolved(
  db: DbClient,
  unresolved: UnresolvedRelation,
  targetEntityId: string,
): Promise<void> {
  // Insert resolved edge first; if that fails the unresolved row stays
  // so the resolver can retry later. ON CONFLICT DO NOTHING replicates
  // Cypher MERGE's dedupe.
  await db.duck.exec(
    'INSERT INTO relation (src, dst, kind) VALUES (?, ?, ?) ON CONFLICT (src, dst, kind) DO NOTHING',
    [unresolved.fromEntity, targetEntityId, unresolved.kind],
  );
  await db.duck.exec('DELETE FROM unresolved_relation WHERE id = ?', [unresolved.id]);
}

/**
 * Update the meta JSON on an unresolved row (e.g. to record an ambiguous
 * candidate set) without resolving it. Re-stamps `attemptedAt`.
 */
export async function updateUnresolvedMeta(
  db: DbClient,
  id: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const metaJson = JSON.stringify(meta);
  const attemptedAt = new Date().toISOString();
  await db.duck.exec(
    'UPDATE unresolved_relation SET meta = ?, attempted_at = ? WHERE id = ?',
    [metaJson, attemptedAt, id],
  );
}

// ---------------------------------------------------------------------------
// Batched cross-file-resolver writers
//
// Per-row promoteToResolved / updateUnresolvedMeta turn each accepted /
// ambiguous resolution into a separate DuckDB call. These batch helpers
// collapse N writes into ceil(N/CHUNK) bulk-INSERT statements.
// CHUNK = 500 to bound the generated-SQL length on each round-trip.
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 500;

/**
 * Batched form of promoteToResolved. Groups by relation kind and
 * issues one multi-VALUES INSERT per (kind, chunk), then one IN-list
 * DELETE per chunk for the unresolved-row cleanup.
 */
export async function promoteResolvedBatch(
  db: DbClient,
  items: ReadonlyArray<{ unresolved: UnresolvedRelation; targetEntityId: string }>,
): Promise<void> {
  if (items.length === 0) return;

  // Group by kind so we can build per-kind multi-VALUES INSERTs
  // (one INSERT can mix kinds in our schema, but bucketing makes the
  // SQL marginally clearer and matches the previous Kuzu code shape).
  const byKind = new Map<RelationKind, { from: string; to: string }[]>();
  for (const item of items) {
    let arr = byKind.get(item.unresolved.kind);
    if (arr === undefined) { arr = []; byKind.set(item.unresolved.kind, arr); }
    arr.push({ from: item.unresolved.fromEntity, to: item.targetEntityId });
  }

  for (const [kind, rows] of byKind) {
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      await bulkInsertRelations(db, kind, chunk);
    }
  }

  // Batch DELETE the unresolved rows.
  const allIds = items.map(it => it.unresolved.id);
  for (let i = 0; i < allIds.length; i += CHUNK_SIZE) {
    const chunk = allIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    await db.duck.exec(
      `DELETE FROM unresolved_relation WHERE id IN (${placeholders})`,
      chunk,
    );
  }
}

/**
 * DuckDB-side bulk-insert relations. Builds a single INSERT statement
 * with N (?, ?, ?) tuples; ON CONFLICT DO NOTHING handles duplicates.
 * One round-trip per chunk vs. N separate INSERTs.
 */
async function bulkInsertRelations(
  db: DbClient,
  kind: RelationKind,
  rows: ReadonlyArray<{ from: string; to: string }>,
): Promise<void> {
  if (rows.length === 0) return;
  const valuesSql = rows.map(() => '(?, ?, ?)').join(', ');
  const params: string[] = [];
  for (const r of rows) { params.push(r.from, r.to, kind); }
  await db.duck.exec(
    `INSERT INTO relation (src, dst, kind) VALUES ${valuesSql} ON CONFLICT (src, dst, kind) DO NOTHING`,
    params,
  );
}

/**
 * Batched form of updateUnresolvedMeta. DuckDB has no UNWIND-and-SET
 * primitive; for a few hundred rows the per-row UPDATE cost is
 * negligible (no fsync bottleneck in DuckDB's MVCC model the way Kuzu
 * had).
 */
export async function updateUnresolvedMetaBatch(
  db: DbClient,
  items: ReadonlyArray<{ id: string; meta: Record<string, unknown> }>,
): Promise<void> {
  if (items.length === 0) return;
  const attemptedAt = new Date().toISOString();
  const rows = items.map(it => ({
    id: it.id,
    meta: JSON.stringify(it.meta),
  }));
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    for (const r of chunk) {
      await db.duck.exec(
        'UPDATE unresolved_relation SET meta = ?, attempted_at = ? WHERE id = ?',
        [r.meta, attemptedAt, r.id],
      );
    }
  }
}
