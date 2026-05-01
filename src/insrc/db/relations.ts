import { createHash } from 'node:crypto';
import type { DbClient } from './client.js';
import type { Relation, RelationKind } from '../shared/types.js';
import { getLogger } from '../shared/logger.js';
import { shouldWriteDuckGraph, shouldWriteKuzuGraph } from './graph-dual-write.js';

const log = getLogger('db.relations');

/**
 * Wrap a DuckDB write so its failure is logged + counted but doesn't
 * abort the overall operation. Same pattern as entities.ts during the
 * dual-write phase (A.8); after A.10 cutover the Kuzu branch is gone
 * and DuckDB errors propagate naturally.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function kuzuExec(db: DbClient, stmt: string, params: any): Promise<Record<string, unknown>[]> {
  const prepared = await db.graph.prepare(stmt);
  const result   = await db.graph.execute(prepared, params);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const qr = Array.isArray(result) ? result[0]! : result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (qr as any).getAll() as Promise<Record<string, unknown>[]>;
}

// Relation kind → Kuzu REL TABLE name (must match schema.ts)
const REL_TABLE: Record<RelationKind, string> = {
  DEFINES:    'DEFINES',
  IMPORTS:    'IMPORTS',
  CALLS:      'CALLS',
  INHERITS:   'INHERITS',
  IMPLEMENTS: 'IMPLEMENTS',
  DEPENDS_ON: 'DEPENDS_ON',
  EXPORTS:    'EXPORTS',
  REFERENCES: 'REFERENCES',
};

/**
 * Upsert a graph relation edge between two Entity stubs in Kuzu.
 * Resolved relations land in the typed REL tables; unresolved ones go to
 * the UnresolvedRelation node table for the cross-file resolver pass to
 * pick up later. See plans/cross-file-references.md §0.1.
 */
export async function upsertRelation(db: DbClient, relation: Relation): Promise<void> {
  if (!relation.resolved) {
    await upsertUnresolvedRelation(db, relation);
    return;
  }

  const rel = REL_TABLE[relation.kind];
  if (shouldWriteKuzuGraph()) {
    // MERGE prevents duplicate edges
    await kuzuExec(
      db,
      `MATCH (a:Entity {id: $from}), (b:Entity {id: $to}) MERGE (a)-[:${rel}]->(b)`,
      { from: relation.from, to: relation.to },
    );
  }
  if (shouldWriteDuckGraph()) {
    // DuckDB schema collapses Kuzu's typed REL tables into one
    // `relation(src, dst, kind)`. The PRIMARY KEY (src, dst, kind)
    // makes ON CONFLICT DO NOTHING the duplicate-guard equivalent of
    // Cypher MERGE.
    await runDuckOrLog(
      () => db.duck.exec(
        'INSERT INTO relation (src, dst, kind) VALUES (?, ?, ?) ON CONFLICT (src, dst, kind) DO NOTHING',
        [relation.from, relation.to, relation.kind],
      ),
      { op: 'upsertRelation', kind: relation.kind, from: relation.from, to: relation.to },
    );
  }
}

/**
 * Upsert multiple relations.
 */
export async function upsertRelations(db: DbClient, relations: Relation[]): Promise<void> {
  for (const rel of relations) {
    await upsertRelation(db, rel);
  }
}

/**
 * Delete all edges originating from entities in the given file.
 * In practice this is handled by DETACH DELETE in deleteEntitiesForFile(),
 * but kept for explicit call sites in the indexer pipeline.
 */
export async function deleteRelationsForFile(_db: DbClient, _filePath: string): Promise<void> {
  // Edges are removed automatically via DETACH DELETE on Entity stubs
  // (see entities.ts deleteEntitiesForFile). No separate action needed.
}

/**
 * Delete all edges originating from entities in a repo.
 */
export async function deleteRelationsForRepo(_db: DbClient, _repo: string): Promise<void> {
  // Edges are removed automatically via DETACH DELETE on Entity stubs
  // (see entities.ts deleteEntitiesForRepo). No separate action needed.
}

// ---------------------------------------------------------------------------
// Unresolved relations — persistence for the cross-file resolver pass.
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
  const meta     = relation.meta ?? {};
  const fromFile = typeof meta['file'] === 'string' ? meta['file'] as string : '';
  const repo     = typeof meta['repo'] === 'string' ? meta['repo'] as string : '';
  if (!fromFile || !repo) {
    // Parser-emitted unresolved relations always carry meta.file/meta.repo.
    // Anything else is a programming error -- log + drop rather than poison
    // the table with un-invalidatable rows.
    log.debug(
      { kind: relation.kind, from: relation.from, to: relation.to },
      'unresolved relation missing meta.file/meta.repo — dropping',
    );
    return;
  }

  const id          = makeUnresolvedRelationId(repo, relation.from, relation.kind, relation.to);
  const metaJson    = JSON.stringify(meta);
  const attemptedAt = new Date().toISOString();

  if (shouldWriteKuzuGraph()) {
    await kuzuExec(
      db,
      `MERGE (u:UnresolvedRelation {id: $id})
       SET u.repo = $repo, u.fromEntity = $fromEntity, u.fromFile = $fromFile,
           u.kind = $kind, u.rawTo = $rawTo, u.meta = $meta, u.attemptedAt = $attemptedAt`,
      { id, repo, fromEntity: relation.from, fromFile,
        kind: relation.kind, rawTo: relation.to, meta: metaJson, attemptedAt },
    );
  }
  if (shouldWriteDuckGraph()) {
    // unresolved_relation primary-keyed on id; upsert via ON CONFLICT
    // DO UPDATE replicates the Kuzu MERGE+SET semantics. Note camelCase
    // → snake_case column-name shift (fromEntity → from_entity etc.).
    await runDuckOrLog(
      () => db.duck.exec(
        `INSERT INTO unresolved_relation
           (id, repo, from_entity, from_file, kind, raw_to, meta, attempted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           repo = excluded.repo,
           from_entity = excluded.from_entity,
           from_file = excluded.from_file,
           kind = excluded.kind,
           raw_to = excluded.raw_to,
           meta = excluded.meta,
           attempted_at = excluded.attempted_at`,
        [id, repo, relation.from, fromFile, relation.kind, relation.to, metaJson, attemptedAt],
      ),
      { op: 'upsertUnresolvedRelation', id },
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
  const params: Record<string, string> = { repo };
  let stmt = 'MATCH (u:UnresolvedRelation) WHERE u.repo = $repo';
  if (scopeFile !== undefined) {
    stmt += ' AND u.fromFile = $scopeFile';
    params['scopeFile'] = scopeFile;
  }
  stmt += ` RETURN u.id AS id, u.repo AS repo, u.fromEntity AS fromEntity,
                   u.fromFile AS fromFile, u.kind AS kind, u.rawTo AS rawTo,
                   u.meta AS meta, u.attemptedAt AS attemptedAt`;
  const rows = await kuzuExec(db, stmt, params);
  return rows.map(rowToUnresolved);
}

function rowToUnresolved(row: Record<string, unknown>): UnresolvedRelation {
  let meta: Record<string, unknown> = {};
  const raw = row['meta'];
  if (typeof raw === 'string' && raw.length > 0) {
    try { meta = JSON.parse(raw) as Record<string, unknown>; } catch { /* corrupt — leave empty */ }
  }
  return {
    id:          row['id']          as string,
    repo:        row['repo']        as string,
    fromEntity:  row['fromEntity']  as string,
    fromFile:    row['fromFile']    as string,
    kind:        row['kind']        as RelationKind,
    rawTo:       row['rawTo']       as string,
    meta,
    attemptedAt: row['attemptedAt'] as string,
  };
}

/**
 * Drop all UnresolvedRelation rows whose source file matches. Called on
 * per-file re-index alongside deleteEntitiesForFile so that stale rows
 * from a previous parse don't linger when the parser re-emits the
 * canonical set.
 */
export async function deleteUnresolvedForFile(db: DbClient, file: string): Promise<void> {
  if (shouldWriteKuzuGraph()) {
    await kuzuExec(
      db,
      'MATCH (u:UnresolvedRelation) WHERE u.fromFile = $file DETACH DELETE u',
      { file },
    );
  }
  if (shouldWriteDuckGraph()) {
    await runDuckOrLog(
      () => db.duck.exec('DELETE FROM unresolved_relation WHERE from_file = ?', [file]),
      { op: 'deleteUnresolvedForFile', file },
    );
  }
}

/**
 * Drop all UnresolvedRelation rows belonging to a repo. Used by the
 * `repo.remove` cleanup so unresolved edges don't linger when the
 * repo is detached from the registry.
 */
export async function deleteUnresolvedForRepo(db: DbClient, repo: string): Promise<void> {
  if (shouldWriteKuzuGraph()) {
    await kuzuExec(
      db,
      'MATCH (u:UnresolvedRelation) WHERE u.repo = $repo DETACH DELETE u',
      { repo },
    );
  }
  if (shouldWriteDuckGraph()) {
    await runDuckOrLog(
      () => db.duck.exec('DELETE FROM unresolved_relation WHERE repo = ?', [repo]),
      { op: 'deleteUnresolvedForRepo', repo },
    );
  }
}

/**
 * On successful cross-file resolution: insert the typed REL edge and
 * delete the matching UnresolvedRelation row in a single logical step.
 */
export async function promoteToResolved(
  db: DbClient,
  unresolved: UnresolvedRelation,
  targetEntityId: string,
): Promise<void> {
  const rel = REL_TABLE[unresolved.kind];
  if (shouldWriteKuzuGraph()) {
    await kuzuExec(
      db,
      `MATCH (a:Entity {id: $from}), (b:Entity {id: $to}) MERGE (a)-[:${rel}]->(b)`,
      { from: unresolved.fromEntity, to: targetEntityId },
    );
    await kuzuExec(
      db,
      'MATCH (u:UnresolvedRelation {id: $id}) DETACH DELETE u',
      { id: unresolved.id },
    );
  }
  if (shouldWriteDuckGraph()) {
    await runDuckOrLog(
      async () => {
        // Insert resolved edge first; if that fails the unresolved row
        // stays so the resolver can retry later. Same MERGE semantics
        // via ON CONFLICT DO NOTHING.
        await db.duck.exec(
          'INSERT INTO relation (src, dst, kind) VALUES (?, ?, ?) ON CONFLICT (src, dst, kind) DO NOTHING',
          [unresolved.fromEntity, targetEntityId, unresolved.kind],
        );
        await db.duck.exec('DELETE FROM unresolved_relation WHERE id = ?', [unresolved.id]);
      },
      { op: 'promoteToResolved', id: unresolved.id, kind: unresolved.kind },
    );
  }
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
  if (shouldWriteKuzuGraph()) {
    await kuzuExec(
      db,
      'MATCH (u:UnresolvedRelation {id: $id}) SET u.meta = $meta, u.attemptedAt = $attemptedAt',
      { id, meta: metaJson, attemptedAt },
    );
  }
  if (shouldWriteDuckGraph()) {
    await runDuckOrLog(
      () => db.duck.exec(
        'UPDATE unresolved_relation SET meta = ?, attempted_at = ? WHERE id = ?',
        [metaJson, attemptedAt, id],
      ),
      { op: 'updateUnresolvedMeta', id },
    );
  }
}

// ---------------------------------------------------------------------------
// Batched cross-file-resolver writers
//
// Per-row promoteToResolved / updateUnresolvedMeta turn each accepted /
// ambiguous resolution into 1-2 Kuzu auto-commit transactions, and each
// transaction pays an fsync at the WAL (~11ms on the local NVMe per
// iostat). For a Pass-2 walk over a few thousand rows that's tens of
// seconds of fsync wait alone.
//
// These batch helpers collapse N writes into ceil(N/KUZU_BATCH) UNWIND
// statements, one fsync per chunk. KUZU_BATCH = 500 matches eeae2ef7ac7's
// chunk size for batched DETACH DELETE -- conservative enough to bound
// prepared-statement parameter memory.
// ---------------------------------------------------------------------------

const KUZU_BATCH = 500;

/**
 * Batched form of promoteToResolved. Groups by relation kind (each kind
 * has its own REL TABLE name in Cypher), UNWIND-batches the typed-rel
 * MERGE per kind, then UNWIND-batches the DETACH DELETE of all
 * unresolved rows together.
 */
export async function promoteResolvedBatch(
  db: DbClient,
  items: ReadonlyArray<{ unresolved: UnresolvedRelation; targetEntityId: string }>,
): Promise<void> {
  if (items.length === 0) return;

  // Group by kind -- the REL TABLE name in MERGE is interpolated, not
  // parameterised, so each kind needs its own UNWIND statement.
  const byKind = new Map<RelationKind, { from: string; to: string }[]>();
  for (const item of items) {
    let arr = byKind.get(item.unresolved.kind);
    if (arr === undefined) { arr = []; byKind.set(item.unresolved.kind, arr); }
    arr.push({ from: item.unresolved.fromEntity, to: item.targetEntityId });
  }

  for (const [kind, rows] of byKind) {
    const rel = REL_TABLE[kind];
    for (let i = 0; i < rows.length; i += KUZU_BATCH) {
      const chunk = rows.slice(i, i + KUZU_BATCH);
      if (shouldWriteKuzuGraph()) {
        await kuzuExec(
          db,
          `UNWIND $rows AS r
           MATCH (a:Entity {id: r.from}), (b:Entity {id: r.to})
           MERGE (a)-[:${rel}]->(b)`,
          { rows: chunk },
        );
      }
      if (shouldWriteDuckGraph()) {
        // DuckDB equivalent of UNWIND: build one INSERT with multiple
        // VALUES rows. ON CONFLICT DO NOTHING dedupes the same way
        // Cypher MERGE does. Each chunk becomes one bulk insert.
        await runDuckOrLog(
          () => bulkInsertRelations(db, kind, chunk),
          { op: 'promoteResolvedBatch:insert', kind, count: chunk.length },
        );
      }
    }
  }

  // Batch DETACH DELETE the unresolved rows. Same `WHERE id IN $ids`
  // pattern as eeae2ef7ac7's batched entity DETACH DELETE.
  const allIds = items.map(it => it.unresolved.id);
  for (let i = 0; i < allIds.length; i += KUZU_BATCH) {
    const chunk = allIds.slice(i, i + KUZU_BATCH);
    if (shouldWriteKuzuGraph()) {
      await kuzuExec(
        db,
        'MATCH (u:UnresolvedRelation) WHERE u.id IN $ids DETACH DELETE u',
        { ids: chunk },
      );
    }
    if (shouldWriteDuckGraph()) {
      await runDuckOrLog(
        async () => {
          const placeholders = chunk.map(() => '?').join(', ');
          await db.duck.exec(
            `DELETE FROM unresolved_relation WHERE id IN (${placeholders})`,
            chunk,
          );
        },
        { op: 'promoteResolvedBatch:delete', count: chunk.length },
      );
    }
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
 * Batched form of updateUnresolvedMeta. UNWIND-batches the SET of
 * meta + attemptedAt across many unresolved rows; each batch shares a
 * single `attemptedAt` timestamp (the resolver's wall-clock at flush
 * time, accurate to within one batch's worth of work).
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
  for (let i = 0; i < rows.length; i += KUZU_BATCH) {
    const chunk = rows.slice(i, i + KUZU_BATCH);
    if (shouldWriteKuzuGraph()) {
      await kuzuExec(
        db,
        `UNWIND $rows AS r
         MATCH (u:UnresolvedRelation {id: r.id})
         SET u.meta = r.meta, u.attemptedAt = $attemptedAt`,
        { rows: chunk, attemptedAt },
      );
    }
    if (shouldWriteDuckGraph()) {
      // DuckDB doesn't have a multi-row UPDATE syntax that mirrors
      // Cypher's UNWIND-and-SET; the equivalent is one UPDATE per row.
      // For a 500-row chunk that's still one chunk's worth of round-
      // trips, well under the per-call SQL parse overhead since these
      // are simple single-row statements.
      //
      // Alternative: a single UPDATE ... FROM (VALUES (...), (...))
      // join-update could collapse it, but the syntax is fragile and
      // the row-count we're targeting (a few hundred per resolver
      // pass) doesn't justify the complexity.
      await runDuckOrLog(
        async () => {
          for (const r of chunk) {
            await db.duck.exec(
              'UPDATE unresolved_relation SET meta = ?, attempted_at = ? WHERE id = ?',
              [r.meta, attemptedAt, r.id],
            );
          }
        },
        { op: 'updateUnresolvedMetaBatch', count: chunk.length },
      );
    }
  }
}
