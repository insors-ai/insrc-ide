/**
 * `entity_vec` LanceDB table -- entity embeddings + filter columns.
 *
 * Phase 3.2 of plans/storage-migration-lmdb-lance.md.
 *
 * Schema (post Phase 0.2 dim downshift to 1024):
 *   id:             string         -- the SHA-32 entity id (matches LMDB Entity.id)
 *   embedding:      FLOAT[1024]    -- qwen3-embedding:0.6b output
 *   repo:           string         -- absolute repo root path; used for closure-scope filtering
 *   kind:           string         -- entity kind (function, class, module, ...); used for kind filtering
 *   artifact:       boolean        -- true for non-code artifacts; used for filter='code' / 'artifact'
 *
 * Filter columns are duplicated here from LMDB so Lance can scope ANN
 * searches without a join. They're write-time-only -- LMDB stays
 * canonical for the structured fields.
 *
 * Public surface:
 *   writeEntityEmbedding   -- per-entity upsert (delete + add; Lance
 *                             upsert support varies by version).
 *   writeEntityEmbeddings  -- bulk upsert.
 *   searchEntityVecs       -- ANN with `repo IN (...)` + filter='all|code|artifact'.
 *   deleteEntityVec        -- single-entity drop (called on cascade).
 *   deleteEntityVecsByIds  -- bulk drop.
 *   deleteEntityVecsForRepo -- repo-scoped drop (called on removeRepo cascade).
 */

import * as lancedb from '@lancedb/lancedb';

import { getLanceConn, openOrCreateTable } from './conn.js';
import { loadConfig } from '../../agent/config.js';

const TABLE = 'entity_vec';

const EMBEDDING_DIM = loadConfig().models.providers.local.embeddingDim;

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export interface EntityVecRow {
	id:        string;
	embedding: Float32Array | number[];
	repo:      string;
	kind:      string;
	artifact:  boolean;
}

export interface EntityVecHit {
	id:       string;
	repo:     string;
	kind:     string;
	artifact: boolean;
	distance: number;
}

// ---------------------------------------------------------------------------
// Table lifecycle
// ---------------------------------------------------------------------------

let _tableCache: lancedb.Table | null = null;

/**
 * Open or create the entity_vec table. The seed row is a sentinel
 * never returned by searches (id starts with `_seed_` and we filter
 * it out at write-time).
 *
 * Cached for the connection's lifetime; reset by `closeLanceConn()`
 * via the connection-level reset (callers should re-acquire after
 * env reopen).
 */
async function getEntityVecTable(): Promise<lancedb.Table> {
	if (_tableCache !== null) return _tableCache;
	const conn = await getLanceConn();
	const seed: EntityVecRow = {
		id: '_seed_entity_vec',
		embedding: new Float32Array(EMBEDDING_DIM),
		repo: '',
		kind: '',
		artifact: false,
	};
	_tableCache = await openOrCreateTable(conn, TABLE, () => [seed]);
	return _tableCache;
}

/**
 * Test-only: drop the cached table handle so the next call re-acquires
 * (e.g. after `closeLanceConn()` re-routes to a fresh tmpdir).
 */
export function _resetEntityVecCache(): void {
	_tableCache = null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function writeEntityEmbedding(row: EntityVecRow): Promise<void> {
	await writeEntityEmbeddings([row]);
}

export async function writeEntityEmbeddings(rows: readonly EntityVecRow[]): Promise<void> {
	if (rows.length === 0) return;
	const table = await getEntityVecTable();
	// Upsert pattern: drop any existing rows with these ids, then add.
	// Avoids relying on Lance's mergeInsert API (signature has shifted
	// across versions) at the cost of one extra delete call per write.
	const ids = rows.map(r => r.id);
	const idList = ids.map(id => `'${escapeLanceString(id)}'`).join(', ');
	await table.delete(`id IN (${idList})`);
	await table.add(rows.map(r => ({
		id:        r.id,
		embedding: r.embedding instanceof Float32Array ? r.embedding : new Float32Array(r.embedding),
		repo:      r.repo,
		kind:      r.kind,
		artifact:  r.artifact,
	})));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type EntityVecFilter = 'all' | 'code' | 'artifact';

export async function searchEntityVecs(
	queryVec: number[],
	closureRepos: readonly string[],
	limit: number,
	filter: EntityVecFilter = 'all',
): Promise<EntityVecHit[]> {
	if (queryVec.length === 0 || closureRepos.length === 0) return [];
	const table = await getEntityVecTable();

	const conditions: string[] = [];
	if (closureRepos.length > 0) {
		const list = closureRepos.map(r => `'${escapeLanceString(r)}'`).join(', ');
		conditions.push(`repo IN (${list})`);
	}
	if (filter === 'code')     conditions.push('artifact = false');
	if (filter === 'artifact') conditions.push('artifact = true');
	// Always exclude the seed sentinel from results
	conditions.push("id != '_seed_entity_vec'");

	const where = conditions.join(' AND ');
	const search = table.search(queryVec).limit(limit);
	const withWhere = where !== '' ? search.where(where) : search;
	const rows = await withWhere.toArray();
	return rows.map(r => ({
		id:       r['id']       as string,
		repo:     r['repo']     as string,
		kind:     r['kind']     as string,
		artifact: r['artifact'] as boolean,
		distance: Number(r['_distance']),
	}));
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteEntityVec(id: string): Promise<void> {
	if (id === '') return;
	const table = await getEntityVecTable();
	await table.delete(`id = '${escapeLanceString(id)}'`);
}

export async function deleteEntityVecsByIds(ids: readonly string[]): Promise<void> {
	if (ids.length === 0) return;
	const table = await getEntityVecTable();
	const list = ids.map(id => `'${escapeLanceString(id)}'`).join(', ');
	await table.delete(`id IN (${list})`);
}

export async function deleteEntityVecsForRepo(repo: string): Promise<void> {
	const table = await getEntityVecTable();
	await table.delete(`repo = '${escapeLanceString(repo)}'`);
}

// ---------------------------------------------------------------------------
// SQL escape -- Lance uses DataFusion SQL syntax; single-quote strings
// are escaped by doubling. We do not splice user-controlled SQL beyond
// IDs / paths / kinds, all of which are validated upstream.
// ---------------------------------------------------------------------------

function escapeLanceString(s: string): string {
	return s.replace(/'/g, "''");
}
