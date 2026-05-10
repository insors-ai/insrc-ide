/**
 * `artifact_vec` LanceDB table -- per-skill-output embeddings.
 *
 * conversation-flow-refinement.md Phase 2. Companion of `session_vec`
 * (conversation-turn embeddings) and `entity_vec` (code-graph entity
 * embeddings); this table stores **artefacts produced inside a
 * session by the analyzer-pipeline skills** so a follow-up turn's
 * retriever (Phase 3) can pull them by relevance.
 *
 * Schema:
 *   id:         string         -- "<session_id>:<timestamp>:<skill_id>" (primary key)
 *   embedding:  FLOAT[<dim>]   -- value-blob embedding (or summary embed when too large)
 *   session_id: string         -- filter column
 *   intent:     string         -- 'code-analysis' | 'data-analysis' | ...
 *   skill_id:   string         -- e.g. 'code.source.repo.describe'
 *   timestamp:  long           -- epoch ms; bigints stored as native int64
 *   path:       string         -- absolute path to the spill file under PATHS.sessionTmp
 *   preview:    string         -- first ~2 KB of the value blob (for inline cite in the
 *                                 enhancer prompt without re-reading the disk file)
 *
 * Filter columns (`session_id`, `intent`) are duplicated from the row
 * payload so Lance can scope ANN searches without a join. Same
 * pattern session_vec follows.
 */

import * as lancedb from '@lancedb/lancedb';

import { getLanceConn, openOrCreateTable } from './conn.js';
import { loadConfig } from '../../agent/config.js';

const TABLE = 'artifact_vec';
const EMBEDDING_DIM = loadConfig().models.providers.local.embeddingDim;

export interface ArtifactVecRow {
	id:         string;
	embedding:  Float32Array | number[];
	session_id: string;
	intent:     string;
	skill_id:   string;
	timestamp:  bigint;
	path:       string;
	preview:    string;
}

export interface ArtifactVecHit {
	id:         string;
	session_id: string;
	intent:     string;
	skill_id:   string;
	timestamp:  bigint;
	path:       string;
	preview:    string;
	distance:   number;
}

let _tableCache: lancedb.Table | null = null;

async function getArtifactVecTable(): Promise<lancedb.Table> {
	if (_tableCache !== null) return _tableCache;
	const conn = await getLanceConn();
	const seed: ArtifactVecRow = {
		id:         '_seed_artifact_vec',
		embedding:  new Float32Array(EMBEDDING_DIM),
		session_id: '',
		intent:     '',
		skill_id:   '',
		timestamp:  BigInt(0),
		path:       '',
		preview:    '',
	};
	_tableCache = await openOrCreateTable(conn, TABLE, () => [seed]);
	return _tableCache;
}

export function _resetArtifactVecCache(): void {
	_tableCache = null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function upsertArtifactVec(row: ArtifactVecRow): Promise<void> {
	await upsertArtifactVecBatch([row]);
}

export async function upsertArtifactVecBatch(rows: readonly ArtifactVecRow[]): Promise<void> {
	if (rows.length === 0) return;
	const table = await getArtifactVecTable();
	await table.mergeInsert('id')
		.whenMatchedUpdateAll()
		.whenNotMatchedInsertAll()
		.execute(rows.map(r => ({
			id:         r.id,
			embedding:  r.embedding instanceof Float32Array ? r.embedding : new Float32Array(r.embedding),
			session_id: r.session_id,
			intent:     r.intent,
			skill_id:   r.skill_id,
			timestamp:  r.timestamp,
			path:       r.path,
			preview:    r.preview,
		})));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface QueryArtifactVecOpts {
	/** Restrict results to a session. Required for the Phase 3 retriever. */
	readonly sessionId:   string;
	/** Optional intent filter. Empty string = no intent filter. */
	readonly intent?:     string;
	/** Top-K. */
	readonly k:           number;
}

/**
 * ANN over `embedding` filtered by session (+ optional intent). Returns
 * hits in Lance-side rank order (closest first). Distances are L2 by
 * default since openOrCreateTable uses Lance defaults.
 */
export async function queryArtifactVec(
	queryVec: number[],
	opts: QueryArtifactVecOpts,
): Promise<ArtifactVecHit[]> {
	if (queryVec.length === 0 || opts.sessionId === '' || opts.k <= 0) return [];
	const table = await getArtifactVecTable();

	const conditions: string[] = [
		`session_id = '${escapeLanceString(opts.sessionId)}'`,
		"id != '_seed_artifact_vec'",
	];
	if (opts.intent !== undefined && opts.intent.length > 0) {
		conditions.push(`intent = '${escapeLanceString(opts.intent)}'`);
	}

	const search = table.search(queryVec).limit(opts.k);
	const rows = await search.where(conditions.join(' AND ')).toArray();
	return rows.map(r => ({
		id:         r['id']         as string,
		session_id: r['session_id'] as string,
		intent:     r['intent']     as string,
		skill_id:   r['skill_id']   as string,
		timestamp:  toBigInt(r['timestamp']),
		path:       r['path']       as string,
		preview:    r['preview']    as string,
		distance:   Number(r['_distance']),
	}));
}

/**
 * Direct lookup by exact id (no ANN). Used by the Phase 3 enhancer
 * when its first pass named ids in `requestArtifactIds` -- the caller
 * needs to load the full body from disk via `path`, but first it has
 * to verify the id is real and pull the row's metadata.
 */
export async function getArtifactById(id: string): Promise<ArtifactVecHit | null> {
	if (id === '') return null;
	const table = await getArtifactVecTable();
	const rows = await table.query()
		.where(`id = '${escapeLanceString(id)}'`)
		.limit(1)
		.toArray();
	if (rows.length === 0) return null;
	const r = rows[0]!;
	return {
		id:         r['id']         as string,
		session_id: r['session_id'] as string,
		intent:     r['intent']     as string,
		skill_id:   r['skill_id']   as string,
		timestamp:  toBigInt(r['timestamp']),
		path:       r['path']       as string,
		preview:    r['preview']    as string,
		distance:   0,
	};
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteArtifactsForSession(sessionId: string): Promise<number> {
	if (sessionId === '') return 0;
	const table = await getArtifactVecTable();
	// Lance's delete() doesn't return a removed-count, so we count by
	// query first. Tolerable extra round-trip on session-close.
	const before = await table.query()
		.where(`session_id = '${escapeLanceString(sessionId)}'`)
		.limit(100_000)
		.toArray();
	if (before.length === 0) return 0;
	await table.delete(`session_id = '${escapeLanceString(sessionId)}'`);
	return before.length;
}

function escapeLanceString(s: string): string {
	return s.replace(/'/g, "''");
}

function toBigInt(v: unknown): bigint {
	if (typeof v === 'bigint') return v;
	if (typeof v === 'number') return BigInt(v);
	if (typeof v === 'string' && v.length > 0) {
		try { return BigInt(v); } catch { return BigInt(0); }
	}
	return BigInt(0);
}
