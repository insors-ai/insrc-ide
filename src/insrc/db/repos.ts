import type { DbClient } from './client.js';
import type { RegisteredRepo } from '../shared/types.js';
import { basename } from 'node:path';
import { shouldWriteDuckGraph, shouldWriteKuzuGraph } from './graph-dual-write.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('db.repos');

/**
 * Wrap a DuckDB write so its failure is logged + counted but doesn't
 * abort the overall operation. Same pattern as entities.ts and
 * relations.ts during the dual-write phase.
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
  return (qr as any).getAll() as Record<string, unknown>[];
}

async function kuzuQuery(db: DbClient, stmt: string): Promise<Record<string, unknown>[]> {
  const result = await db.graph.query(stmt);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const qr = Array.isArray(result) ? result[0]! : result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (qr as any).getAll() as Record<string, unknown>[];
}

export async function addRepo(db: DbClient, repo: RegisteredRepo): Promise<void> {
  const name = repo.name || basename(repo.path);
  const lastIndexed = repo.lastIndexed ?? '';
  const errorMsg = repo.errorMsg ?? '';
  if (shouldWriteKuzuGraph()) {
    await kuzuExec(
      db,
      `MERGE (r:Repo {id: $path})
       SET r.path = $path, r.name = $name, r.addedAt = $addedAt,
           r.lastIndexed = $lastIndexed, r.status = $status, r.errorMsg = $errorMsg`,
      {
        path:        repo.path,
        name,
        addedAt:     repo.addedAt,
        lastIndexed,
        status:      repo.status,
        errorMsg,
      },
    );
  }
  if (shouldWriteDuckGraph()) {
    // Repo table primary-keyed on id (the path). MERGE → ON CONFLICT
    // DO UPDATE replicates "insert if absent, update fields otherwise".
    // Column-name shift: addedAt → added_at, lastIndexed → last_indexed,
    // errorMsg → error_msg.
    await runDuckOrLog(
      () => db.duck.exec(
        `INSERT INTO repo (id, path, name, added_at, last_indexed, status, error_msg)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           path = excluded.path,
           name = excluded.name,
           added_at = excluded.added_at,
           last_indexed = excluded.last_indexed,
           status = excluded.status,
           error_msg = excluded.error_msg`,
        [repo.path, repo.path, name, repo.addedAt, lastIndexed, repo.status, errorMsg],
      ),
      { op: 'addRepo', path: repo.path },
    );
  }
}

export async function removeRepo(db: DbClient, path: string): Promise<void> {
  if (shouldWriteKuzuGraph()) {
    await kuzuExec(db, 'MATCH (r:Repo {id: $path}) DETACH DELETE r', { path });
  }
  if (shouldWriteDuckGraph()) {
    // Repo node has no edges in the schema (no Repo-side REL TABLEs),
    // so DETACH DELETE → plain DELETE. The entities + relations
    // belonging to the repo are removed by deleteEntitiesForRepo /
    // deleteUnresolvedForRepo (separate calls in the indexer cleanup
    // path); this just removes the registry row.
    await runDuckOrLog(
      () => db.duck.exec('DELETE FROM repo WHERE id = ?', [path]),
      { op: 'removeRepo', path },
    );
  }
}

export async function listRepos(db: DbClient): Promise<RegisteredRepo[]> {
  const rows = await kuzuQuery(
    db,
    `MATCH (r:Repo)
     RETURN r.path AS path, r.name AS name, r.addedAt AS addedAt,
            r.lastIndexed AS lastIndexed, r.status AS status, r.errorMsg AS errorMsg`,
  );
  return rows.map(r => {
    const repo: RegisteredRepo = {
      path:    r['path']   as string,
      name:    r['name']   as string,
      addedAt: r['addedAt'] as string,
      status:  r['status'] as RegisteredRepo['status'],
    };
    const li = r['lastIndexed']; if (li) repo.lastIndexed = li as string;
    const em = r['errorMsg'];    if (em) repo.errorMsg    = em as string;
    return repo;
  });
}

export async function updateRepoStatus(
  db: DbClient,
  path: string,
  status: RegisteredRepo['status'],
  lastIndexed?: string,
  errorMsg?: string,
): Promise<void> {
  const li = lastIndexed ?? '';
  const em = errorMsg ?? '';
  if (shouldWriteKuzuGraph()) {
    await kuzuExec(
      db,
      `MATCH (r:Repo {id: $path})
       SET r.status = $status, r.lastIndexed = $lastIndexed, r.errorMsg = $errorMsg`,
      { path, status, lastIndexed: li, errorMsg: em },
    );
  }
  if (shouldWriteDuckGraph()) {
    // Plain UPDATE; matches Cypher MATCH+SET.
    await runDuckOrLog(
      () => db.duck.exec(
        'UPDATE repo SET status = ?, last_indexed = ?, error_msg = ? WHERE id = ?',
        [status, li, em, path],
      ),
      { op: 'updateRepoStatus', path, status },
    );
  }
}
