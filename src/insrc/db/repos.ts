import type { DbClient } from './client.js';
import type { RegisteredRepo } from '../shared/types.js';
import { basename } from 'node:path';

/**
 * Repo registry CRUD. Post Kuzu rip-out (Phase A.11), all calls go
 * through DuckDB's `repo` table.
 *
 * Column-name mapping: the JS-side type uses camelCase
 * (addedAt / lastIndexed / errorMsg) while the SQL uses snake_case
 * (added_at / last_indexed / error_msg). The mapping lives here.
 */
export async function addRepo(db: DbClient, repo: RegisteredRepo): Promise<void> {
  const name = repo.name || basename(repo.path);
  const lastIndexed = repo.lastIndexed ?? '';
  const errorMsg = repo.errorMsg ?? '';
  // Repo table primary-keyed on id (the path). Cypher MERGE → ON CONFLICT
  // DO UPDATE: insert if absent, update fields otherwise.
  await db.duck.exec(
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
  );
}

export async function removeRepo(db: DbClient, path: string): Promise<void> {
  // Repo node has no edges in the schema (no Repo-side REL TABLEs);
  // entities + relations belonging to the repo are removed by
  // deleteEntitiesForRepo / deleteUnresolvedForRepo (separate calls
  // in the indexer cleanup path).
  await db.duck.exec('DELETE FROM repo WHERE id = ?', [path]);
}

export async function listRepos(db: DbClient): Promise<RegisteredRepo[]> {
  const rows = await db.duck.query<{
    path: string;
    name: string;
    added_at: string;
    last_indexed: string;
    status: string;
    error_msg: string;
  }>(
    `SELECT path, name, added_at, last_indexed, status, error_msg FROM repo`,
  );
  return rows.map(r => {
    const repo: RegisteredRepo = {
      path:    r.path,
      name:    r.name,
      addedAt: r.added_at,
      status:  r.status as RegisteredRepo['status'],
    };
    if (r.last_indexed) repo.lastIndexed = r.last_indexed;
    if (r.error_msg)    repo.errorMsg    = r.error_msg;
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
  await db.duck.exec(
    'UPDATE repo SET status = ?, last_indexed = ?, error_msg = ? WHERE id = ?',
    [status, lastIndexed ?? '', errorMsg ?? '', path],
  );
}
