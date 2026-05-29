/**
 * `substrate_vec` LanceDB table -- P2.1 of plans/skills/substrate-implementation-status.md.
 *
 * Per substrate doc §"Storage substrate" + §"Indexing framework":
 * files-as-canonical, Lance-as-index. The substrate stores ONE row per
 * indexed memory entry; the schema carries the entry's file-path
 * reference + filter facets, never the payload.
 *
 *   id:              string         -- "<workspaceId>::<owner>::<namespace>::<key>"
 *                                       (URL-safe; the same value can be re-derived
 *                                        from a MemoryEntryRef to roundtrip lookups)
 *   embedding:       FLOAT[D]       -- vector from the substrate embedder
 *   workspace_id:    string         -- per-workspace scoping
 *   owner:           string         -- 'skill:<id>' / 'agent:<id>' / ...
 *   namespace:       string         -- declared namespace name
 *   key:             string         -- memory entry key (URL-decoded form)
 *   kind:            string         -- 'fact' | 'hint' | 'constraint'
 *   confidence_x100: number         -- 0..100; Lance prefers numeric over float for facet filtering
 *   written_at:      number         -- unix ms
 *   expires_at:      number         -- unix ms; 0 = no TTL
 *
 * Filter columns are duplicated here from the on-disk memory entry so
 * Lance can scope ANN searches without a join. Embedding-only queries
 * are inexpensive to set up but the resulting row is just an id +
 * facets; the canonical entry payload still lives in the on-disk file
 * the substrate reads on a hit.
 *
 * P2 deltas from the substrate doc:
 *   - One shared table (not per-namespace). Smaller migration burden;
 *     per-namespace schemas can split later if needed.
 *   - Search is exact KNN (no Lance index built yet); fine at substrate
 *     scale -- per-namespace row counts are bounded.
 *   - Eviction (cold-row pruning) is deferred -- P0/P1 expiry sweep on
 *     the file side handles dropping the canonical row; orphan Lance
 *     rows are filtered out by the resolver step.
 */

import * as lancedb from '@lancedb/lancedb';

import { getLanceConn, openOrCreateTable } from '../../db/lance/conn.js';
import { loadConfig } from '../../agent/config.js';

const TABLE = 'substrate_vec';

const EMBEDDING_DIM = loadConfig().models.providers.local.embeddingDim;

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export interface SubstrateVecRow {
	id:              string;
	embedding:       Float32Array | number[];
	workspace_id:    string;
	owner:           string;
	namespace:       string;
	key:             string;
	kind:            string;
	confidence_x100: number;
	written_at:      number;
	expires_at:      number;
}

export interface SubstrateVecHit {
	id:              string;
	workspace_id:    string;
	owner:           string;
	namespace:       string;
	key:             string;
	kind:            string;
	confidence_x100: number;
	written_at:      number;
	expires_at:      number;
	distance:        number;
}

// ---------------------------------------------------------------------------
// Table lifecycle
// ---------------------------------------------------------------------------

let _tableCache: lancedb.Table | null = null;

async function getSubstrateVecTable(): Promise<lancedb.Table> {
	if (_tableCache !== null) return _tableCache;
	const conn = await getLanceConn();
	const seed: SubstrateVecRow = {
		id: '_seed_substrate_vec',
		embedding: new Float32Array(EMBEDDING_DIM),
		workspace_id: '', owner: '', namespace: '', key: '',
		kind: 'fact', confidence_x100: 0, written_at: 0, expires_at: 0,
	};
	_tableCache = await openOrCreateTable(conn, TABLE, () => [seed]);
	return _tableCache;
}

/** Test-only: drop the cached table handle so the next call re-acquires. */
export function _resetSubstrateVecCache(): void {
	_tableCache = null;
}

// ---------------------------------------------------------------------------
// Id derivation
// ---------------------------------------------------------------------------

/**
 * Build the row id for a (workspace, owner, namespace, key) tuple. The
 * substrate uses the SAME id on Lance write + file write so the
 * roundtrip from a Lance hit to a canonical file entry is deterministic.
 *
 * The id is URL-encoded to keep it safe in Lance SQL strings + as a
 * filename. We deliberately don't include the full file path -- Lance
 * doesn't care, and keeping the id stable across substrate-root moves
 * is a free property.
 */
export function substrateVecId(
	workspaceId: string,
	owner: string,
	namespace: string,
	key: string,
): string {
	return `${encodeURIComponent(workspaceId)}::${encodeURIComponent(owner)}::${encodeURIComponent(namespace)}::${encodeURIComponent(key)}`;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Upsert one substrate-vec row. The substrate calls this on every
 * memory write whose namespace policy is non-'never'.
 *
 * Uses mergeInsert (D4-aware writes update existing rows in place);
 * Lance's whenMatched applies an unconditional overwrite -- the
 * substrate's read-before-write conflict resolution on the file side
 * already enforced the policy.
 */
export async function writeSubstrateVecRow(row: SubstrateVecRow): Promise<void> {
	const table = await getSubstrateVecTable();
	await table.mergeInsert('id')
		.whenMatchedUpdateAll()
		.whenNotMatchedInsertAll()
		.execute([toRecord(row)]);
}

function toRecord(row: SubstrateVecRow): Record<string, unknown> {
	return {
		id:              row.id,
		embedding:       row.embedding instanceof Float32Array ? row.embedding : new Float32Array(row.embedding),
		workspace_id:    row.workspace_id,
		owner:           row.owner,
		namespace:       row.namespace,
		key:             row.key,
		kind:            row.kind,
		confidence_x100: row.confidence_x100,
		written_at:      row.written_at,
		expires_at:      row.expires_at,
	};
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchOpts {
	readonly topK:               number;
	readonly minSimilarity?:     number;
	readonly includeExpired?:    boolean;
}

/**
 * ANN search scoped to one (workspaceId, owner, namespace). The
 * substrate's MemoryNamespace.searchByEmbedding wraps this and does the
 * two-step resolve to file entries.
 */
export async function searchSubstrateVec(
	queryVec: Float32Array | number[],
	workspaceId: string,
	owner: string,
	namespace: string,
	opts: SearchOpts,
): Promise<SubstrateVecHit[]> {
	const vec = queryVec instanceof Float32Array ? queryVec : new Float32Array(queryVec);
	if (vec.length === 0) return [];

	const table = await getSubstrateVecTable();
	const conditions: string[] = [
		`workspace_id = '${escapeLanceString(workspaceId)}'`,
		`owner = '${escapeLanceString(owner)}'`,
		`namespace = '${escapeLanceString(namespace)}'`,
		`id != '_seed_substrate_vec'`,
	];
	if (opts.includeExpired !== true) {
		// expires_at = 0 means no TTL; otherwise filter to non-expired.
		const now = Date.now();
		conditions.push(`(expires_at = 0 OR expires_at > ${now})`);
	}

	const rows = await table
		.search(vec)
		.where(conditions.join(' AND '))
		.limit(opts.topK)
		.toArray();

	return rows.map(r => ({
		id:              r['id']              as string,
		workspace_id:    r['workspace_id']    as string,
		owner:           r['owner']           as string,
		namespace:       r['namespace']       as string,
		key:             r['key']             as string,
		kind:            r['kind']            as string,
		confidence_x100: Number(r['confidence_x100']),
		written_at:      Number(r['written_at']),
		expires_at:      Number(r['expires_at']),
		distance:        Number(r['_distance']),
	}));
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteSubstrateVecRow(id: string): Promise<void> {
	if (id === '') return;
	const table = await getSubstrateVecTable();
	await table.delete(`id = '${escapeLanceString(id)}'`);
}

export async function deleteSubstrateVecsForNamespace(
	workspaceId: string,
	owner: string,
	namespace: string,
): Promise<void> {
	const table = await getSubstrateVecTable();
	await table.delete(
		`workspace_id = '${escapeLanceString(workspaceId)}' AND ` +
		`owner = '${escapeLanceString(owner)}' AND ` +
		`namespace = '${escapeLanceString(namespace)}'`,
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeLanceString(s: string): string {
	// Lance uses SQL-style single-quoted strings; double up single quotes.
	return s.replace(/'/g, "''");
}
