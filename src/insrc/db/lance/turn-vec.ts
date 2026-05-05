/**
 * `turn_vec` LanceDB table -- conversation-turn embeddings.
 *
 * Phase 3.3 of plans/storage-migration-lmdb-lance.md.
 *
 * Schema (post Phase 0.2 dim downshift):
 *   id:        string          -- formatted as `${sessionId}:${idx}`
 *   embedding: FLOAT[1024]
 *   repo:      string
 *   sessionId: string
 *   type:      string          -- 'turn' | 'directive' | 'summary' | 'merged'
 *   tier:      string          -- 'hot' | 'warm' | 'cold' | 'archive'
 *
 * Filter columns are duplicated from LMDB. searchTurnsByRepo filters
 * on `repo IN (...) AND type IN ('turn','directive','merged')` per the
 * prior DuckDB query contract.
 */

import * as lancedb from '@lancedb/lancedb';

import { getLanceConn, openOrCreateTable } from './conn.js';
import { loadConfig } from '../../agent/config.js';

const TABLE = 'turn_vec';
const EMBEDDING_DIM = loadConfig().models.providers.local.embeddingDim;

export interface TurnVecRow {
	id:        string;
	embedding: Float32Array | number[];
	repo:      string;
	sessionId: string;
	type:      string;
	tier:      string;
}

export interface TurnVecHit {
	id:        string;
	repo:      string;
	sessionId: string;
	type:      string;
	tier:      string;
	distance:  number;
}

let _tableCache: lancedb.Table | null = null;

async function getTurnVecTable(): Promise<lancedb.Table> {
	if (_tableCache !== null) return _tableCache;
	const conn = await getLanceConn();
	const seed: TurnVecRow = {
		id: '_seed_turn_vec',
		embedding: new Float32Array(EMBEDDING_DIM),
		repo: '',
		sessionId: '',
		type: 'turn',
		tier: 'hot',
	};
	_tableCache = await openOrCreateTable(conn, TABLE, () => [seed]);
	return _tableCache;
}

export function _resetTurnVecCache(): void {
	_tableCache = null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function writeTurnEmbedding(row: TurnVecRow): Promise<void> {
	await writeTurnEmbeddings([row]);
}

export async function writeTurnEmbeddings(rows: readonly TurnVecRow[]): Promise<void> {
	if (rows.length === 0) return;
	const table = await getTurnVecTable();
	const idList = rows.map(r => `'${escapeLanceString(r.id)}'`).join(', ');
	await table.delete(`id IN (${idList})`);
	await table.add(rows.map(r => ({
		id:        r.id,
		embedding: r.embedding instanceof Float32Array ? r.embedding : new Float32Array(r.embedding),
		repo:      r.repo,
		sessionId: r.sessionId,
		type:      r.type,
		tier:      r.tier,
	})));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchTurnsOpts {
	repo:  string;
	limit: number;
	/** Default: ['turn','directive','merged'] -- mirrors prior DuckDB filter */
	types?: readonly string[];
}

export async function searchTurnVecs(
	queryVec: number[],
	opts: SearchTurnsOpts,
): Promise<TurnVecHit[]> {
	if (queryVec.length === 0 || opts.repo === '') return [];
	const table = await getTurnVecTable();
	const types = opts.types ?? ['turn', 'directive', 'merged'];
	const typeList = types.map(t => `'${escapeLanceString(t)}'`).join(', ');

	const conditions: string[] = [
		`repo = '${escapeLanceString(opts.repo)}'`,
		`type IN (${typeList})`,
		"id != '_seed_turn_vec'",
	];

	const search = table.search(queryVec).limit(opts.limit);
	const rows = await search.where(conditions.join(' AND ')).toArray();
	return rows.map(r => ({
		id:        r['id']        as string,
		repo:      r['repo']      as string,
		sessionId: r['sessionId'] as string,
		type:      r['type']      as string,
		tier:      r['tier']      as string,
		distance:  Number(r['_distance']),
	}));
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteTurnVec(id: string): Promise<void> {
	if (id === '') return;
	const table = await getTurnVecTable();
	await table.delete(`id = '${escapeLanceString(id)}'`);
}

export async function deleteTurnVecsByIds(ids: readonly string[]): Promise<void> {
	if (ids.length === 0) return;
	const table = await getTurnVecTable();
	const list = ids.map(id => `'${escapeLanceString(id)}'`).join(', ');
	await table.delete(`id IN (${list})`);
}

export async function deleteTurnVecsBySessionId(sessionId: string): Promise<void> {
	const table = await getTurnVecTable();
	await table.delete(`sessionId = '${escapeLanceString(sessionId)}'`);
}

export async function deleteTurnVecsForRepo(repo: string): Promise<void> {
	const table = await getTurnVecTable();
	await table.delete(`repo = '${escapeLanceString(repo)}'`);
}

function escapeLanceString(s: string): string {
	return s.replace(/'/g, "''");
}
