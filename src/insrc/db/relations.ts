import { createHash } from 'node:crypto';
import type { DbClient } from './client.js';
import type { Relation, RelationKind } from '../shared/types.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('db.relations');

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
  // MERGE prevents duplicate edges
  await kuzuExec(
    db,
    `MATCH (a:Entity {id: $from}), (b:Entity {id: $to}) MERGE (a)-[:${rel}]->(b)`,
    { from: relation.from, to: relation.to },
  );
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

  await kuzuExec(
    db,
    `MERGE (u:UnresolvedRelation {id: $id})
     SET u.repo = $repo, u.fromEntity = $fromEntity, u.fromFile = $fromFile,
         u.kind = $kind, u.rawTo = $rawTo, u.meta = $meta, u.attemptedAt = $attemptedAt`,
    { id, repo, fromEntity: relation.from, fromFile,
      kind: relation.kind, rawTo: relation.to, meta: metaJson, attemptedAt },
  );
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
  await kuzuExec(
    db,
    'MATCH (u:UnresolvedRelation) WHERE u.fromFile = $file DETACH DELETE u',
    { file },
  );
}

/**
 * Drop all UnresolvedRelation rows belonging to a repo. Used by the
 * `repo.remove` cleanup so unresolved edges don't linger when the
 * repo is detached from the registry.
 */
export async function deleteUnresolvedForRepo(db: DbClient, repo: string): Promise<void> {
  await kuzuExec(
    db,
    'MATCH (u:UnresolvedRelation) WHERE u.repo = $repo DETACH DELETE u',
    { repo },
  );
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

/**
 * Update the meta JSON on an unresolved row (e.g. to record an ambiguous
 * candidate set) without resolving it. Re-stamps `attemptedAt`.
 */
export async function updateUnresolvedMeta(
  db: DbClient,
  id: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await kuzuExec(
    db,
    'MATCH (u:UnresolvedRelation {id: $id}) SET u.meta = $meta, u.attemptedAt = $attemptedAt',
    { id, meta: JSON.stringify(meta), attemptedAt: new Date().toISOString() },
  );
}
