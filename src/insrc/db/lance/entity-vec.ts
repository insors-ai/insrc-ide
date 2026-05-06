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
 *   addEntityEmbedding     -- pure insert (table.add). Use when the
 *                             caller knows the row's id is NOT in
 *                             the table -- typically the indexer's
 *                             first-time-embed path. Cheapest path:
 *                             no JOIN against the target.
 *   addEntityEmbeddings    -- bulk pure insert. Same constraints.
 *   writeEntityEmbedding   -- per-entity upsert via mergeInsert.
 *                             Use for re-embed (an existing row may
 *                             match the new id). One round-trip.
 *   writeEntityEmbeddings  -- bulk upsert. Each call does one
 *                             mergeInsert, which builds a hash over
 *                             the incoming batch and probes the
 *                             target -- O(target) per call. Avoid
 *                             on hot loops; prefer addEntityEmbeddings
 *                             for first-time embeds and route through
 *                             entities.ts:updateEmbedding which
 *                             dispatches based on prior embeddingModel.
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

/**
 * Pure insert. Caller must guarantee `row.id` does NOT already
 * exist in the table -- mergeInsert's dedup is bypassed for
 * speed. Used by the indexer's first-time-embed path
 * (entities.ts:updateEmbedding dispatches when prior
 * `embeddingModel` was empty).
 */
export async function addEntityEmbedding(row: EntityVecRow): Promise<void> {
	await addEntityEmbeddings([row]);
}

/**
 * Bulk pure insert. Caller's responsibility to ensure no id
 * collisions; Lance does not enforce uniqueness. For a 1M-entity
 * first-index this completes in ~1 min vs hanging indefinitely
 * through writeEntityEmbeddings (the upsert path's per-batch
 * O(target) JOIN cost is fatal at scale).
 */
export async function addEntityEmbeddings(rows: readonly EntityVecRow[]): Promise<void> {
	if (rows.length === 0) return;
	const table = await getEntityVecTable();
	await table.add(rows.map(r => ({
		id:        r.id,
		embedding: r.embedding instanceof Float32Array ? r.embedding : new Float32Array(r.embedding),
		repo:      r.repo,
		kind:      r.kind,
		artifact:  r.artifact,
	})));
}

export async function writeEntityEmbedding(row: EntityVecRow): Promise<void> {
	await writeEntityEmbeddings([row]);
}

export async function writeEntityEmbeddings(rows: readonly EntityVecRow[]): Promise<void> {
	if (rows.length === 0) return;
	const table = await getEntityVecTable();
	// Native upsert via Lance's mergeInsert -- one round-trip, dedup
	// on the join key, atomic per-batch (a crash mid-call leaves the
	// table in a coherent pre-write state, never partially-deleted).
	//
	// History: this was originally `delete(id IN [...]) + add(rows)`
	// because the older lancedb-js mergeInsert signature had shifted
	// across versions. Pinning to lancedb 0.27.2 (Phase 0.1) made
	// the API stable. The delete-then-add pattern hung at scale -- a
	// 50k-string IN-list against a 950k-row table on the last batch
	// of a 1M-vector load saturated Lance's predicate planner --
	// whereas mergeInsert handles the same workload in linear time
	// (Phase 7.3 follow-up: 1M vectors now insert in ~1 min vs
	// hanging indefinitely).
	await table.mergeInsert('id')
		.whenMatchedUpdateAll()
		.whenNotMatchedInsertAll()
		.execute(rows.map(r => ({
			id:        r.id,
			embedding: r.embedding instanceof Float32Array ? r.embedding : new Float32Array(r.embedding),
			repo:      r.repo,
			kind:      r.kind,
			artifact:  r.artifact,
		})));
}

// ---------------------------------------------------------------------------
// Index management
// ---------------------------------------------------------------------------

/**
 * Row-count threshold above which `optimizeEntityVecIndex()` will
 * actually build the HNSW index. Below this, brute-force scan is
 * cheaper than a HNSW build + maintenance.
 */
const HNSW_THRESHOLD = 50_000;

/**
 * Build (or rebuild) the HNSW index on the embedding column when the
 * row count is large enough to make it worthwhile.
 *
 * Without an index, `searchEntityVecs` does an exact KNN scan over
 * every row. At 1M rows × 1024 dims × 4 bytes = 4 GiB scanned per
 * query (~860 ms p99 on a 2026 dev box). After indexing, p99 drops
 * to ~10-50 ms.
 *
 * Called by:
 *   - indexer/index.ts at the end of a full repo index
 *   - bench/ops/vectors.ts after the bulk-insert phase
 *   - manual: `insrc daemon optimize` (Phase 7.x ops tool, future)
 *
 * Uses Lance's `hnswSq` (Scalar Quantization HNSW): faster to build
 * + smaller on-disk index than `hnswPq` (Product Quantization),
 * with comparable recall at our 1024-dim scale.
 *
 * Idempotent: if an index already exists and `force` isn't set, the
 * call returns `built: false` quickly. With `force: true`, the
 * existing index is rebuilt.
 *
 * Below `HNSW_THRESHOLD` rows the call is a no-op (returns
 * `built: false`). The threshold avoids paying the build cost on
 * small repos where brute-force is already milliseconds.
 */
export async function optimizeEntityVecIndex(
	opts: { force?: boolean } = {},
): Promise<{ built: boolean; rowCount: number; elapsedMs: number }> {
	const t0 = Date.now();
	const table = await getEntityVecTable();
	const rowCount = await table.countRows();

	if (!opts.force && rowCount < HNSW_THRESHOLD) {
		return { built: false, rowCount, elapsedMs: Date.now() - t0 };
	}

	if (!opts.force) {
		const existing = await table.listIndices();
		if (existing.some(i => i.columns.includes('embedding'))) {
			return { built: false, rowCount, elapsedMs: Date.now() - t0 };
		}
	}

	await table.createIndex('embedding', {
		config: lancedb.Index.hnswSq({}),
		replace: opts.force ?? false,
	});
	return { built: true, rowCount, elapsedMs: Date.now() - t0 };
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
