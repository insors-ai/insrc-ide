/**
 * Repo registry CRUD on the LMDB graph store. Phase 2.1 of
 * plans/storage-migration-lmdb-lance.md.
 *
 * Surface preserved verbatim: callers (`daemon/index.ts`,
 * `indexer/index.ts`, RPC handlers) keep using `addRepo / removeRepo /
 * listRepos / updateRepoStatus` with the same parameter shapes. The
 * `db: DbClient` parameter is retained but unused -- Phase 5.x drops
 * it from callers. Internally we route through the LMDB module
 * singleton (`getGraphStore`).
 *
 * Internal model:
 *   - Public API uses `path` as the externally-visible repo identifier
 *     (matching today's caller pattern).
 *   - LMDB key for the `repo` sub-DB is u32 sequential, allocated from
 *     the meta counter (`db/graph/ids.ts`). The mapping path → u32 is
 *     a linear scan of the small repo set (~hundreds, single-digit ms
 *     even at thousands).
 *   - Cross-cascade (delete repo → delete entities → delete edges)
 *     lands in Phase 2.10 once the other CRUD modules exist.
 */

import { basename } from 'node:path';

import type { RegisteredRepo } from '../shared/types.js';
import {
	getGraphStore,
	withWriteTxn,
	type GraphStore,
} from './graph/store.js';
import { allocateRepoIdInTxn } from './graph/ids.js';
import { encodeRepoKey } from './graph/keys.js';
import {
	encodeRepoRow,
	decodeRepoRow,
	type RepoRow,
	type RepoStatus,
} from './graph/codec.js';

/**
 * Vestigial `DbClient` param shape. Kept until Phase 5.x updates the
 * callers to drop the now-unused argument.
 */
type DbClient = unknown;

// ---------------------------------------------------------------------------
// Public API (signatures unchanged from the DuckDB era)
// ---------------------------------------------------------------------------

export async function addRepo(_db: DbClient, repo: RegisteredRepo): Promise<void> {
	const name = repo.name || basename(repo.path);
	await withWriteTxn(s => {
		const existing = findRepoIdByPath(s, repo.path);
		const id = existing ?? allocateRepoIdInTxn(s);
		const row: RepoRow = {
			id,
			path:        repo.path,
			name,
			addedAt:     parseTimestamp(repo.addedAt),
			lastIndexed: parseOptionalTimestamp(repo.lastIndexed),
			status:      repo.status,
			errorMsg:    repo.errorMsg ?? '',
		};
		s.repo.put(encodeRepoKey(id), encodeRepoRow(row));
	});
}

export async function removeRepo(_db: DbClient, path: string): Promise<void> {
	// Phase 2.10 cascade: delete entities (which transitively cascades
	// to out_edge / in_edge mirrors + entity_id_by_string + name_index),
	// then unresolved relations for the repo, then conversation sessions
	// for the repo (which transitively cascades to turns + by_repo
	// index entries), then plans for the repo, then the repo row itself.
	//
	// LanceDB row cleanup (entity_vec / session_vec / turn_vec / config_
	// vec for entries belonging to this repo) is wired in Phase 3.x.
	const { deleteEntitiesForRepo } = await import('./entities.js');
	const { deleteUnresolvedForRepo } = await import('./relations.js');
	const { deleteSessionsForRepo } = await import('./conversations.js');
	const { deletePlansForRepo } = await import('../agent/tasks/plan-store.js');

	await deleteEntitiesForRepo(null, path);
	await deleteUnresolvedForRepo(null, path);
	await deleteSessionsForRepo(null, path);
	await deletePlansForRepo(null, path);

	await withWriteTxn(s => {
		const id = findRepoIdByPath(s, path);
		if (id === undefined) return;
		s.repo.remove(encodeRepoKey(id));
	});
}

export async function listRepos(_db: DbClient): Promise<RegisteredRepo[]> {
	const store = await getGraphStore();
	const out: RegisteredRepo[] = [];
	for (const { value } of store.repo.getRange()) {
		const row = decodeRepoRow(value as Buffer);
		out.push(rowToRepo(row));
	}
	return out;
}

export async function updateRepoStatus(
	_db: DbClient,
	path: string,
	status: RegisteredRepo['status'],
	lastIndexed?: string,
	errorMsg?: string,
): Promise<void> {
	await withWriteTxn(s => {
		const id = findRepoIdByPath(s, path);
		if (id === undefined) {
			// Path isn't registered -- silently no-op to match the prior
			// DuckDB behaviour where the UPDATE matched zero rows.
			return;
		}
		const key = encodeRepoKey(id);
		const cur = s.repo.get(key);
		if (cur === undefined) return;
		const row = decodeRepoRow(cur as Buffer);
		const next: RepoRow = {
			...row,
			status:      status as RepoStatus,
			lastIndexed: parseOptionalTimestamp(lastIndexed),
			errorMsg:    errorMsg ?? '',
		};
		s.repo.put(key, encodeRepoRow(next));
	});
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Linear scan of the `repo` sub-DB looking for the row matching `path`.
 * O(N) where N is the repo count; expected ≤ a few hundred even on
 * heavy users. If N ever grows to thousands a `path → id` secondary
 * sub-DB is the obvious next step; not warranted today.
 *
 * Must be called inside a txn (the sync `getRange` iterator is bound
 * to the caller's txn snapshot).
 */
function findRepoIdByPath(store: GraphStore, path: string): number | undefined {
	for (const { key, value } of store.repo.getRange()) {
		const row = decodeRepoRow(value as Buffer);
		if (row.path === path) {
			return (key as Buffer).readUInt32BE(0);
		}
	}
	return undefined;
}

function rowToRepo(row: RepoRow): RegisteredRepo {
	const r: RegisteredRepo = {
		path:    row.path,
		name:    row.name,
		addedAt: formatTimestamp(row.addedAt),
		status:  row.status,
	};
	if (row.lastIndexed > 0) r.lastIndexed = formatTimestamp(row.lastIndexed);
	if (row.errorMsg !== '') r.errorMsg    = row.errorMsg;
	return r;
}

function parseTimestamp(s: string): number {
	const n = Date.parse(s);
	return Number.isFinite(n) ? n : 0;
}

function parseOptionalTimestamp(s: string | undefined): number {
	if (s === undefined || s === '') return 0;
	return parseTimestamp(s);
}

function formatTimestamp(ms: number): string {
	return new Date(ms).toISOString();
}
