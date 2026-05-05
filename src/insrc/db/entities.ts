/**
 * LMDB-backed entity persistence. Phase 2.2 of
 * plans/storage-migration-lmdb-lance.md.
 *
 * Public surface preserved verbatim from the prior DuckDB-backed
 * implementation: callers (`indexer/`, `daemon/`, `agent/tasks/`,
 * RPC handlers) keep using `upsertEntities / getEntity / ...` with
 * the same signatures. The `db: DbClient` parameter is retained but
 * unused -- Phase 5.x removes it from callers.
 *
 * Storage model:
 *   - `entity` sub-DB: u64 BE -> msgpack(EntityRow). u64 because
 *     edges reference entities by u64 (10x edge:entity ratio makes
 *     8-byte vs 32-byte IDs the dominant storage win).
 *   - `entity_id_by_string` sub-DB: utf8 SHA-32 string -> u64. Used
 *     to translate the daemon's domain `Entity.id: string` (kept for
 *     caller back-compat) to/from the internal u64.
 *   - `repo` sub-DB: u32 BE -> RepoRow. Linear scan for path<->id
 *     translation (~hundreds of repos at most).
 *   - Embedding vectors do NOT live in LMDB -- they go to LanceDB
 *     keyed by entity_id (Phase 3.2). For now `updateEmbedding()`
 *     records only the model name; vector writes land in Phase 3.2.
 *     `getEntity()` returns `embedding: []` until Phase 3.2 wires
 *     Lance reads.
 *
 * Module-stub semantics: module entities use "ensure exists" (no-op
 * if already present); other kinds use full upsert (overwrite). The
 * DuckDB era used `ON CONFLICT DO NOTHING` vs `DO UPDATE`; LMDB
 * achieves the same via an explicit pre-check.
 *
 * Cascade on delete: incident edges in `out_edge` / `in_edge`
 * sub-DBs are also removed. Phase 2.10 will hoist this into a
 * shared cascade helper; for Phase 2.2 we do the prefix-scan
 * inline.
 */

import { relative } from 'node:path';

import type { Entity, EntityKind, Language } from '../shared/types.js';
import { getLogger } from '../shared/logger.js';
import {
	getGraphStore,
	withWriteTxn,
	type GraphStore,
} from './graph/store.js';
import { allocateEntityIdInTxn, allocateRepoIdInTxn } from './graph/ids.js';
import {
	encodeEntityKey,
	encodeOutEdgePrefix,
	encodeInEdgePrefix,
	prefixSuccessor,
	ENTITY_KIND_BYTE,
} from './graph/keys.js';
import {
	decodeEntityRow,
	decodeRepoRow,
	encodeEntityRow,
	encodeRepoRow,
	type EntityRow,
	type RepoRow,
} from './graph/codec.js';

const log = getLogger('db.entities');

/**
 * Vestigial `DbClient` param shape -- kept until Phase 5.x removes
 * the unused argument from callers.
 */
type DbClient = unknown;

// ---------------------------------------------------------------------------
// Domain <-> row mapping
// ---------------------------------------------------------------------------

function entityToRow(e: Entity, repoId: number, repoRoot: string): EntityRow {
	return {
		repoId,
		kind:           e.kind,
		name:           e.name,
		filePath:       toRepoRelative(e.file, repoRoot),
		startLine:      e.startLine,
		endLine:        e.endLine,
		language:       e.language,
		rootPath:       e.rootPath ?? repoRoot,
		body:           e.body,
		signature:      e.signature ?? '',
		summary:        '',
		isExported:     e.isExported ?? false,
		isAsync:        e.isAsync    ?? false,
		isAbstract:     e.isAbstract ?? false,
		artifact:       e.artifact   ?? false,
		contentHash:    e.hash       ?? '',
		embeddingModel: e.embeddingModel ?? '',
		indexedAt:      parseTimestamp(e.indexedAt),
	};
}

function rowToDomainEntity(id: string, row: EntityRow, repoRoot: string): Entity {
	const e: Entity = {
		id,
		kind:      row.kind,
		name:      row.name,
		language:  row.language,
		repo:      repoRoot,
		file:      toAbsolutePath(row.filePath, repoRoot),
		startLine: row.startLine,
		endLine:   row.endLine,
		body:      row.body,
		// Embedding lives in LanceDB; Phase 3.2 wires the read path.
		embedding: [],
		indexedAt: formatTimestamp(row.indexedAt),
	};
	if (row.embeddingModel !== '') e.embeddingModel = row.embeddingModel;
	if (row.isExported) e.isExported = true;
	if (row.isAsync)    e.isAsync    = true;
	if (row.isAbstract) e.isAbstract = true;
	if (row.signature !== '') e.signature = row.signature;
	if (row.contentHash !== '') e.hash = row.contentHash;
	if (row.rootPath !== '' && row.rootPath !== repoRoot) e.rootPath = row.rootPath;
	if (row.artifact) e.artifact = true;
	return e;
}

/**
 * Legacy DuckDB-era row mapper. The new code path produces Entity
 * via `rowToDomainEntity`; this function is kept exported only because
 * `db/search.ts` still imports it. When `db/search.ts` is rewired in
 * Phase 4.2, this export goes away.
 *
 * @deprecated Use the LMDB read path instead.
 */
export function rowToEntity(row: Record<string, unknown>): Entity {
	const e: Entity = {
		id:        row['id']         as string,
		kind:      row['kind']       as EntityKind,
		name:      (row['name']      as string) ?? '',
		language:  (row['language']  as Language) ?? '',
		repo:      (row['repo']      as string) ?? '',
		file:      (row['file']      as string) ?? '',
		startLine: Number(row['start_line'] ?? 0),
		endLine:   Number(row['end_line']   ?? 0),
		body:      (row['body']      as string) ?? '',
		indexedAt: (row['indexed_at'] as string) ?? '',
		embedding: unwrapEmbedding(row['embedding']),
	};
	const em = row['embedding_model'] as string; if (em) e.embeddingModel = em;
	if (row['is_exported'] === true) e.isExported = true;
	if (row['is_async']    === true) e.isAsync    = true;
	if (row['is_abstract'] === true) e.isAbstract = true;
	const sg = row['signature'] as string; if (sg) e.signature = sg;
	const hh = row['hash']      as string; if (hh) e.hash      = hh;
	const rp = row['root_path'] as string; if (rp) e.rootPath  = rp;
	if (row['artifact'] === true) e.artifact = true;
	return e;
}

/**
 * @deprecated DuckDB-era helper. The LMDB path stores embeddings in
 * Lance, not in the entity row. Kept exported only for back-compat
 * with `db/search.ts`.
 */
export function unwrapEmbedding(raw: unknown): number[] {
	if (raw === null || raw === undefined) return [];
	if (Array.isArray(raw)) return raw as number[];
	const inner = (raw as { items?: unknown }).items;
	return Array.isArray(inner) ? (inner as number[]) : [];
}

// ---------------------------------------------------------------------------
// Public API (signatures unchanged from the DuckDB era)
// ---------------------------------------------------------------------------

export async function upsertEntities(_db: DbClient, entities: Entity[]): Promise<void> {
	if (entities.length === 0) return;

	const { unique, duplicateIds } = dedupeEntitiesById(entities);
	if (duplicateIds.size > 0) {
		const sample: { id: string; count: number; name: string; kind: string; file: string }[] = [];
		for (const [id, count] of duplicateIds) {
			const ent = unique.find(x => x.id === id);
			if (ent === undefined) continue;
			sample.push({ id, count, name: ent.name, kind: ent.kind, file: ent.file });
			if (sample.length >= 5) break;
		}
		log.warn(
			{ totalDuplicates: duplicateIds.size, kept: unique.length, original: entities.length, sample },
			'upsertEntities: collapsed duplicate entity ids in input batch (last-wins). ' +
			'This usually indicates a parser emitting two entities with identical (repo, file, kind, name) -- ' +
			'common for overloaded Java/Scala methods since the id formula doesn\'t include signature.',
		);
	}

	await withWriteTxn(s => {
		// Resolve / allocate repo IDs once per batch (one path -> one id).
		const repoIdCache = new Map<string, number>();
		const ensureRepo = (path: string): number => {
			const cached = repoIdCache.get(path);
			if (cached !== undefined) return cached;
			const existing = repoIdByPathInTxn(s, path);
			if (existing !== undefined) {
				repoIdCache.set(path, existing);
				return existing;
			}
			// First time we've seen this repo path -- allocate. Matches
			// the prior DuckDB behaviour where the entity table held a
			// `repo` string and didn't require a separate registration
			// step. Phase 5.x will tighten this so callers must register
			// repos via `addRepo` before indexing.
			const id = allocateRepoIdInTxn(s);
			const row: RepoRow = {
				id,
				path,
				name:        '', // back-fill happens via addRepo / first indexer call
				addedAt:     Date.now(),
				lastIndexed: 0,
				status:      'pending',
				errorMsg:    '',
			};
			s.repo.put(encodeRepoKey(id), encodeRepoRow(row));
			repoIdCache.set(path, id);
			return id;
		};

		for (const e of unique) {
			const repoId = ensureRepo(e.repo);
			const existingU64 = lookupU64ByStringId(s, e.id);

			if (existingU64 !== undefined) {
				// Module entities are ensure-exists: don't overwrite.
				if (e.kind === 'module') continue;
				const row = entityToRow(e, repoId, e.repo);
				s.entity.put(encodeEntityKey(existingU64), encodeEntityRow(row));
				continue;
			}

			// New entity: allocate u64, write the row + the string-id index
			const u64 = allocateEntityIdInTxn(s);
			const row = entityToRow(e, repoId, e.repo);
			s.entity.put(encodeEntityKey(u64), encodeEntityRow(row));
			s.entityIdByString.put(e.id, u64);
		}
	});
}

/**
 * Atomic re-index of a single file. Phase 2.9 of the LMDB+Lance
 * migration: snapshot the file's existing entities, upsert each
 * parsed entity (allocating new u64 IDs as needed), then tombstone
 * any entities that disappeared from the parse. All in one LMDB
 * write transaction so readers never see a half-state.
 *
 * Compared to calling `deleteEntitiesForFile` followed by
 * `upsertEntities`:
 *   - Atomic: no window where rows are deleted but new ones not yet
 *     written.
 *   - Idempotent: parsing the same file twice produces the same row
 *     set (same SHA → same u64 → same EntityRow).
 *   - Body-write short-circuit: rows whose `contentHash` matches the
 *     prior parse are skipped (typical re-index hits this for
 *     unchanged entities).
 *   - Cascade: tombstoned entities take their incident edges with
 *     them via the same prefix-scan logic used by
 *     `deleteEntitiesForFile`.
 *
 * `repoPath` is the repo root path (e.g. `/repo/foo`); `filePath` is
 * the absolute path of the file being re-parsed (matches the prior
 * call shape used by the indexer). Caller passes the parsed entities
 * exactly as returned by the parser (`Entity[]` with string SHA ids).
 *
 * Auto-allocates a u32 repoId for `repoPath` if the repo isn't
 * registered yet (matches the existing `upsertEntities` behaviour).
 */
export async function reindexFile(
	_db: DbClient,
	repoPath: string,
	filePath: string,
	parsed: Entity[],
): Promise<void> {
	// Dedupe by SHA id (same protective pass `upsertEntities` does)
	const { unique, duplicateIds } = dedupeEntitiesById(parsed);
	if (duplicateIds.size > 0) {
		log.warn(
			{ totalDuplicates: duplicateIds.size, kept: unique.length, original: parsed.length, file: filePath },
			'reindexFile: collapsed duplicate entity ids in input batch (last-wins)',
		);
	}

	await withWriteTxn(s => {
		// Resolve / allocate the repoId for this path (cache it for
		// the rest of the pass)
		let repoId = repoIdByPathInTxn(s, repoPath);
		if (repoId === undefined) {
			repoId = allocateRepoIdInTxn(s);
			const row: RepoRow = {
				id:          repoId,
				path:        repoPath,
				name:        '',
				addedAt:     Date.now(),
				lastIndexed: 0,
				status:      'pending',
				errorMsg:    '',
			};
			s.repo.put(encodeRepoKey(repoId), encodeRepoRow(row));
		}

		// 1. Snapshot existing entities for this (repoId, filePath).
		//    Scan the entity sub-DB; cheap at typical scale (a few
		//    dozen entities per file).
		const existing: bigint[] = [];
		for (const { key, value } of s.entity.getRange()) {
			const row = decodeEntityRow(value as Buffer);
			if (row.repoId !== repoId) continue;
			if (toAbsolutePath(row.filePath, repoPath) !== filePath) continue;
			existing.push(decodeKeyU64(key as Buffer));
		}

		// 2. Upsert each parsed entity, tracking which u64s we touched.
		const seen = new Set<bigint>();
		for (const e of unique) {
			let u64 = lookupU64ByStringId(s, e.id);
			if (u64 === undefined) {
				u64 = allocateEntityIdInTxn(s);
				s.entityIdByString.put(e.id, u64);
			}

			// Module-stub semantics: don't overwrite an existing module
			// (matches the prior DuckDB ON CONFLICT DO NOTHING split).
			const prevBuf = s.entity.get(encodeEntityKey(u64));
			if (prevBuf !== undefined && e.kind === 'module') {
				seen.add(u64);
				continue;
			}

			// Body-write short-circuit: skip the put if everything that
			// would change is identical. We compare contentHash + body
			// (contentHash alone is a hash collision risk but body adds
			// the actual-bytes safety net).
			const newRow = entityToRow(e, repoId, repoPath);
			if (prevBuf !== undefined) {
				const prev = decodeEntityRow(prevBuf as Buffer);
				if (prev.contentHash === newRow.contentHash
				 && prev.body === newRow.body
				 && prev.startLine === newRow.startLine
				 && prev.endLine === newRow.endLine
				 && prev.signature === newRow.signature
				 && prev.embeddingModel === newRow.embeddingModel) {
					seen.add(u64);
					continue; // unchanged -- skip write
				}
			}

			s.entity.put(encodeEntityKey(u64), encodeEntityRow(newRow));
			seen.add(u64);
		}

		// 3. Tombstone unseen (= deleted from the file).
		const toDelete: bigint[] = [];
		for (const u64 of existing) {
			if (!seen.has(u64)) toDelete.push(u64);
		}
		detachDeleteEntitiesInTxn(s, toDelete);
	});
}

export async function deleteEntitiesForFile(_db: DbClient, filePath: string): Promise<void> {
	const store = await getGraphStore();
	const ids = await collectEntityU64sByFile(store, filePath);
	await detachDeleteEntities(store, ids);
}

export async function deleteEntitiesForRepo(_db: DbClient, repo: string): Promise<void> {
	const store = await getGraphStore();
	const repoId = await withReadTxn(store, () => repoIdByPathInTxn(store, repo));
	if (repoId === undefined) return;
	const ids = await collectEntityU64sByRepo(store, repoId);
	await detachDeleteEntities(store, ids);
}

export async function getEntity(_db: DbClient, id: string): Promise<Entity | null> {
	const store = await getGraphStore();
	const u64 = store.entityIdByString.get(id) as bigint | number | undefined;
	if (u64 === undefined) return null;
	const row = readEntityRow(store, u64);
	if (row === null) return null;
	const repoPath = readRepoPath(store, row.repoId);
	return rowToDomainEntity(id, row, repoPath ?? '');
}

export async function getEntitiesByIds(_db: DbClient, ids: readonly string[]): Promise<Entity[]> {
	if (ids.length === 0) return [];
	const store = await getGraphStore();
	const repoCache = new Map<number, string>();
	const out: Entity[] = [];
	for (const id of ids) {
		const u64 = store.entityIdByString.get(id) as bigint | number | undefined;
		if (u64 === undefined) continue;
		const row = readEntityRow(store, u64);
		if (row === null) continue;
		out.push(rowToDomainEntity(id, row, lookupRepoPath(store, row.repoId, repoCache)));
	}
	return out;
}

export async function findEntitiesByName(
	_db: DbClient,
	names: readonly string[],
	opts: {
		readonly kinds?: readonly EntityKind[] | undefined;
		readonly repo?: string | undefined;
		readonly limit?: number | undefined;
	} = {},
): Promise<Entity[]> {
	if (names.length === 0) return [];

	const store = await getGraphStore();
	const limit = opts.limit ?? 50;
	const nameSet = new Set(names);
	const kindFilter = opts.kinds !== undefined && opts.kinds.length > 0
		? new Set(opts.kinds.map(k => ENTITY_KIND_BYTE[k as keyof typeof ENTITY_KIND_BYTE]))
		: null;
	let repoFilter: number | null = null;
	if (opts.repo !== undefined) {
		const id = repoIdByPathInTxn(store, opts.repo);
		if (id === undefined) return []; // unknown repo -> no matches
		repoFilter = id;
	}

	const out: Entity[] = [];
	const repoCache = new Map<number, string>();

	// Linear scan of the entity sub-DB. For ≤ ~1M entities this is fast
	// (mmap'd cursor). Tier-2 perf optimisation: a `name -> u64` secondary
	// sub-DB; not built for v1 since the call frequency is low (artifact
	// generation, not hot-path).
	for (const { key, value } of store.entity.getRange()) {
		const row = decodeEntityRow(value as Buffer);
		if (!nameSet.has(row.name)) continue;
		if (kindFilter !== null && !kindFilter.has(ENTITY_KIND_BYTE[row.kind])) continue;
		if (repoFilter !== null && row.repoId !== repoFilter) continue;
		const stringId = lookupStringIdByU64(store, decodeKeyU64(key as Buffer));
		if (stringId === undefined) continue;
		out.push(rowToDomainEntity(stringId, row, lookupRepoPath(store, row.repoId, repoCache)));
		if (out.length >= limit) break;
	}
	return out;
}

export async function listEntitiesForRepo(_db: DbClient, repo: string): Promise<Entity[]> {
	const store = await getGraphStore();
	const repoId = repoIdByPathInTxn(store, repo);
	if (repoId === undefined) return [];
	const out: Entity[] = [];
	const repoCache = new Map<number, string>([[repoId, repo]]);
	for (const { key, value } of store.entity.getRange()) {
		const row = decodeEntityRow(value as Buffer);
		if (row.repoId !== repoId) continue;
		const stringId = lookupStringIdByU64(store, decodeKeyU64(key as Buffer));
		if (stringId === undefined) continue;
		out.push(rowToDomainEntity(stringId, row, lookupRepoPath(store, row.repoId, repoCache)));
	}
	return out;
}

export async function findEntitiesByFile(_db: DbClient, file: string): Promise<Entity[]> {
	const store = await getGraphStore();
	// `file` from callers is an absolute path; rows store the
	// repo-relative `filePath`. We resolve the row's repo root via its
	// repoId, recompute the absolute, and compare.
	const out: Entity[] = [];
	const repoCache = new Map<number, string>();
	for (const { key, value } of store.entity.getRange()) {
		const row = decodeEntityRow(value as Buffer);
		const repoPath = lookupRepoPath(store, row.repoId, repoCache);
		if (toAbsolutePath(row.filePath, repoPath) !== file) continue;
		const stringId = lookupStringIdByU64(store, decodeKeyU64(key as Buffer));
		if (stringId === undefined) continue;
		out.push(rowToDomainEntity(stringId, row, repoPath));
	}
	return out;
}

export async function listUnembeddedEntities(_db: DbClient, repo: string): Promise<Entity[]> {
	const store = await getGraphStore();
	const repoId = repoIdByPathInTxn(store, repo);
	if (repoId === undefined) return [];
	const out: Entity[] = [];
	const repoCache = new Map<number, string>([[repoId, repo]]);
	for (const { key, value } of store.entity.getRange()) {
		const row = decodeEntityRow(value as Buffer);
		if (row.repoId !== repoId) continue;
		if (row.embeddingModel !== '') continue; // already embedded
		const stringId = lookupStringIdByU64(store, decodeKeyU64(key as Buffer));
		if (stringId === undefined) continue;
		out.push(rowToDomainEntity(stringId, row, lookupRepoPath(store, row.repoId, repoCache)));
	}
	return out;
}

export async function updateEmbedding(
	_db: DbClient,
	id: string,
	_embedding: number[],
	embeddingModel: string,
): Promise<void> {
	// Phase 3.2 wires the actual vector to LanceDB. For Phase 2.2 we
	// only update the EntityRow's `embeddingModel` field so the
	// "is this entity embedded?" predicate (`embeddingModel !== ''`)
	// behaves correctly during the migration.
	await withWriteTxn(s => {
		const u64 = s.entityIdByString.get(id) as bigint | number | undefined;
		if (u64 === undefined) return; // no-op (matches prior DuckDB UPDATE behaviour)
		const row = readEntityRowSync(s, u64);
		if (row === null) return;
		const next: EntityRow = { ...row, embeddingModel };
		s.entity.put(encodeEntityKey(toBigInt(u64)), encodeEntityRow(next));
	});
	// _embedding will be persisted to Lance in Phase 3.2.
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const repoIdByPathInTxn = (s: GraphStore, path: string): number | undefined => {
	for (const { key, value } of s.repo.getRange()) {
		const row = decodeRepoRow(value as Buffer);
		if (row.path === path) {
			return (key as Buffer).readUInt32BE(0);
		}
	}
	return undefined;
};

const lookupU64ByStringId = (s: GraphStore, id: string): bigint | undefined => {
	const v = s.entityIdByString.get(id) as bigint | number | undefined;
	if (v === undefined) return undefined;
	return toBigInt(v);
};

const lookupStringIdByU64 = (s: GraphStore, u64: bigint): string | undefined => {
	// Reverse-lookup is O(N) over the index; cached per-call by callers
	// where it matters. Tier-2: secondary `u64 -> string` sub-DB if this
	// becomes hot.
	for (const { key, value } of s.entityIdByString.getRange()) {
		const v = toBigInt(value as bigint | number);
		if (v === u64) return key as string;
	}
	return undefined;
};

const readEntityRow = (s: GraphStore, u64: bigint | number): EntityRow | null => {
	const buf = s.entity.get(encodeEntityKey(toBigInt(u64)));
	if (buf === undefined) return null;
	return decodeEntityRow(buf as Buffer);
};

const readEntityRowSync = readEntityRow;

const lookupRepoPath = (
	s: GraphStore,
	repoId: number,
	cache: Map<number, string>,
): string => {
	const cached = cache.get(repoId);
	if (cached !== undefined) return cached;
	const path = readRepoPath(s, repoId);
	const out = path ?? '';
	cache.set(repoId, out);
	return out;
};

const readRepoPath = (s: GraphStore, repoId: number): string | undefined => {
	const buf = s.repo.get(encodeRepoKey(repoId));
	if (buf === undefined) return undefined;
	return decodeRepoRow(buf as Buffer).path;
};

const decodeKeyU64 = (buf: Buffer): bigint => buf.readBigUInt64BE(0);

const encodeRepoKey = (id: number): Buffer => {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(id, 0);
	return b;
};

async function collectEntityU64sByFile(store: GraphStore, file: string): Promise<bigint[]> {
	return collectEntityU64sByFileInTxn(store, file);
}

function collectEntityU64sByFileInTxn(store: GraphStore, file: string): bigint[] {
	const out: bigint[] = [];
	const repoCache = new Map<number, string>();
	for (const { key, value } of store.entity.getRange()) {
		const row = decodeEntityRow(value as Buffer);
		const repoPath = lookupRepoPath(store, row.repoId, repoCache);
		if (toAbsolutePath(row.filePath, repoPath) === file) {
			out.push(decodeKeyU64(key as Buffer));
		}
	}
	return out;
}

async function collectEntityU64sByRepo(store: GraphStore, repoId: number): Promise<bigint[]> {
	const out: bigint[] = [];
	for (const { key, value } of store.entity.getRange()) {
		const row = decodeEntityRow(value as Buffer);
		if (row.repoId !== repoId) continue;
		out.push(decodeKeyU64(key as Buffer));
	}
	return out;
}

/**
 * Detach-delete pattern: incident edges first, then the entity row +
 * its string-id index entry. Wrapped in one txn so partial failure
 * never leaves dangling edges or orphaned index entries.
 *
 * Phase 2.10 will hoist this into a shared cascade helper using the
 * Phase 2.3 edge API; for Phase 2.2 we do raw key-range scans on the
 * out_edge / in_edge sub-DBs.
 */
async function detachDeleteEntities(store: GraphStore, u64s: readonly bigint[]): Promise<void> {
	if (u64s.length === 0) return;
	void store;
	await withWriteTxn(s => detachDeleteEntitiesInTxn(s, u64s));
}

/**
 * Sync, in-txn variant of `detachDeleteEntities`. Used by the bulk
 * `reindexFile` helper (Phase 2.9) so the snapshot + upsert + tombstone
 * pass commits as a single LMDB transaction.
 */
function detachDeleteEntitiesInTxn(s: GraphStore, u64s: readonly bigint[]): void {
	if (u64s.length === 0) return;
	for (const u64 of u64s) {
		// Forward direction: edges where this entity is the `from`.
		// Walk out_edge by prefix(u64), removing both the out_edge
		// entry and the matching in_edge mirror at (to, kind, u64).
		sweepOutgoingEdges(s, u64);
		// Reverse direction: edges where this entity is the `to`.
		// Walk in_edge by prefix(u64), removing both the in_edge
		// entry and the matching out_edge mirror at (from, kind, u64).
		sweepIncomingEdges(s, u64);
		// Entity row + string-id index
		const stringId = lookupStringIdByU64(s, u64);
		if (stringId !== undefined) {
			s.entityIdByString.remove(stringId);
		}
		s.entity.remove(encodeEntityKey(u64));
	}
}

function sweepOutgoingEdges(s: GraphStore, u64: bigint): void {
	const prefix = encodeOutEdgePrefix(u64);
	const succ = prefixSuccessor(prefix);
	const collected: Array<{ kind: number; to: bigint }> = [];
	for (const { key } of s.outEdge.getRange({ start: prefix, end: succ })) {
		const k = key as Buffer;
		collected.push({ kind: k.readUInt8(8), to: k.readBigUInt64BE(9) });
	}
	for (const { kind, to } of collected) {
		const outKey = Buffer.alloc(17);
		outKey.writeBigUInt64BE(u64, 0);
		outKey.writeUInt8(kind, 8);
		outKey.writeBigUInt64BE(to, 9);
		s.outEdge.remove(outKey);

		const inKey = Buffer.alloc(17);
		inKey.writeBigUInt64BE(to, 0);
		inKey.writeUInt8(kind, 8);
		inKey.writeBigUInt64BE(u64, 9);
		s.inEdge.remove(inKey);
	}
}

function sweepIncomingEdges(s: GraphStore, u64: bigint): void {
	const prefix = encodeInEdgePrefix(u64);
	const succ = prefixSuccessor(prefix);
	const collected: Array<{ kind: number; from: bigint }> = [];
	for (const { key } of s.inEdge.getRange({ start: prefix, end: succ })) {
		const k = key as Buffer;
		collected.push({ kind: k.readUInt8(8), from: k.readBigUInt64BE(9) });
	}
	for (const { kind, from } of collected) {
		const inKey = Buffer.alloc(17);
		inKey.writeBigUInt64BE(u64, 0);
		inKey.writeUInt8(kind, 8);
		inKey.writeBigUInt64BE(from, 9);
		s.inEdge.remove(inKey);

		const outKey = Buffer.alloc(17);
		outKey.writeBigUInt64BE(from, 0);
		outKey.writeUInt8(kind, 8);
		outKey.writeBigUInt64BE(u64, 9);
		s.outEdge.remove(outKey);
	}
}

function dedupeEntitiesById(entities: readonly Entity[]): {
	unique: Entity[];
	duplicateIds: Map<string, number>;
} {
	const map = new Map<string, Entity>();
	const dupCounts = new Map<string, number>();
	for (const e of entities) {
		if (map.has(e.id)) dupCounts.set(e.id, (dupCounts.get(e.id) ?? 1) + 1);
		map.set(e.id, e);
	}
	return { unique: [...map.values()], duplicateIds: dupCounts };
}

// ---------------------------------------------------------------------------
// Path / timestamp helpers
// ---------------------------------------------------------------------------

function toRepoRelative(absoluteOrRelative: string, repoRoot: string): string {
	if (repoRoot === '' || !absoluteOrRelative.startsWith(repoRoot)) {
		// Already relative, or repo root unknown -- keep as-is
		return absoluteOrRelative;
	}
	const rel = relative(repoRoot, absoluteOrRelative);
	return rel === '' ? '.' : rel;
}

function toAbsolutePath(filePath: string, repoRoot: string): string {
	if (filePath.startsWith('/') || repoRoot === '') return filePath;
	return repoRoot.endsWith('/') ? `${repoRoot}${filePath}` : `${repoRoot}/${filePath}`;
}

function parseTimestamp(s: string | undefined): number {
	if (s === undefined || s === '') return 0;
	const n = Date.parse(s);
	return Number.isFinite(n) ? n : 0;
}

function formatTimestamp(ms: number): string {
	if (ms === 0) return '';
	return new Date(ms).toISOString();
}

function toBigInt(v: bigint | number): bigint {
	return typeof v === 'bigint' ? v : BigInt(v);
}

// withReadTxn is a thin wrapper for read-only call sites that want to
// preserve a snapshot. lmdb-js allows direct .get / .getRange calls
// outside any explicit txn (each acquires its own read snapshot per
// call), so for the get-then-act pattern we accept the slight
// mismatched-snapshot risk as acceptable for v1.
async function withReadTxn<T>(_store: GraphStore, fn: () => T | Promise<T>): Promise<T> {
	return fn();
}

