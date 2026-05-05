/**
 * LMDB env + sub-DB scaffolding for the storage layer.
 *
 * Phase 1.1 of plans/storage-migration-lmdb-lance.md. This file owns
 * the env lifecycle (open/close), exposes typed handles for each of
 * the 19 sub-DBs, and provides minimal txn helpers. ID allocation is
 * 1.2 (separate file); typed record codecs are 1.3; test path injection
 * is 1.4; durability/operational config polish is 1.5.
 *
 * Substrate: lmdb-js 3.5.4 (pinned in Phase 0.1).
 *
 * Sub-DB layout (per design doc graph-storage-lmdb.md "Sub-DB layout"):
 *
 *   Graph (8):
 *     meta                         utf8 string  -> mixed (schema_version, ID counters)
 *     repo                         u32 BE       -> msgpack(Repo)
 *     entity                       u64 BE       -> msgpack(Entity)
 *     name_index                   (u32+u8+utf8) -> u64 entity_id
 *     out_edge                     (u64+u8+u64) -> msgpack(EdgeProps) | empty
 *     in_edge                      (u64+u8+u64) -> empty
 *     unresolved                   u64 BE       -> msgpack(UnresolvedRelation)
 *     unresolved_by_file           (u32+utf8)   -> dupsort u64 unresolved_id
 *
 *   Plans (2):
 *     plan                         utf8         -> msgpack(Plan)
 *     plan_step                    (utf8+\0+u32) -> msgpack(PlanStep)
 *
 *   Conversations (3):
 *     conversation_session         utf8         -> msgpack(SessionRow)
 *     conversation_turn            (utf8+\0+u32) -> msgpack(TurnRow)
 *     conversation_turn_by_repo    (utf8+\0+utf8) -> dupsort empty
 *
 *   Todos (4):
 *     todo_list                    utf8         -> msgpack(TodoList)
 *     todo_list_by_session         (utf8+\0+utf8) -> dupsort empty
 *     todo_item                    (utf8+\0+utf8+\0+utf8) -> msgpack(TodoItem)
 *     todo_comment                 (utf8+\0+utf8) -> msgpack(TodoComment)
 *
 *   Config (2):
 *     config_entry                 utf8         -> msgpack(ConfigEntry)
 *     config_by_scope              (utf8+\0+utf8+\0+utf8+\0+utf8) -> dupsort empty
 *
 * Lifecycle: lazy-init module singleton, daemon-lifetime. First call
 * to `getGraphStore()` opens the env and all sub-DBs. Concurrent
 * first-callers share the same init promise.
 *
 * NOT for callers outside the graph layer. Public surface lives in
 * `db/graph/{entities,edges,traversal,bulk}.ts` (Phase 2.x).
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { open, type Database, type RootDatabase } from 'lmdb';

import { getLogger } from '../../shared/logger.js';
import { PATHS } from '../../shared/paths.js';

const log = getLogger('graph-store');

// ---------------------------------------------------------------------------
// Env config (Phase 1.5 will tune these formally)
// ---------------------------------------------------------------------------

/**
 * Maximum env size (`mapsize`). Set generously: LMDB files are sparse
 * on disk, the OS handles VM range allocation cheaply on 64-bit. 1 TiB
 * gives indefinite headroom; raised at env open and not growable
 * mid-process. Override via `INSRC_LMDB_MAPSIZE_GIB` for tests / CI.
 */
const DEFAULT_MAPSIZE_GIB = 1024;

/**
 * Number of named sub-DBs the env can hold. We have 19; pad to 32 for
 * future additions without an env-level migration.
 */
const MAX_DBS = 32;

// LMDB key size: lmdb-js builds the underlying LMDB C library with
// `MDB_MAXKEYSIZE=0` (compile-time unlimited). Keys can run up to
// ~8000 bytes. Our key shapes are well under this -- name_index is
// the longest at (u32 + u8 + utf8 name); long Java FQNs fit easily.

// ---------------------------------------------------------------------------
// Sub-DB shape definitions
// ---------------------------------------------------------------------------

/**
 * Generic Database type without narrowing key/value generics. We rely
 * on the helpers in `keys.ts` for key encoding and on call-site value
 * codecs (msgpack) for value shape; lmdb-js will faithfully store and
 * retrieve raw Buffers.
 */
type AnyDb = Database;

export interface GraphStore {
	root: RootDatabase;

	// Graph
	meta:                AnyDb;
	repo:                AnyDb;
	entity:              AnyDb;
	nameIndex:           AnyDb;
	outEdge:             AnyDb;
	inEdge:              AnyDb;
	unresolved:          AnyDb;
	unresolvedByFile:    AnyDb;

	// Plans
	plan:                AnyDb;
	planStep:            AnyDb;

	// Conversations
	conversationSession: AnyDb;
	conversationTurn:    AnyDb;
	conversationTurnByRepo: AnyDb;

	// Todos
	todoList:            AnyDb;
	todoListBySession:   AnyDb;
	todoItem:            AnyDb;
	todoComment:         AnyDb;

	// Config
	configEntry:         AnyDb;
	configByScope:       AnyDb;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: GraphStore | null = null;
let _initPromise: Promise<GraphStore> | null = null;

/**
 * Backing-env path. Defaults to `PATHS.lmdb` (`~/.insrc/graph.lmdb`).
 * Tests override via `setGraphStorePath()` to a tmpdir.
 */
let _path: string = PATHS.lmdb;

/**
 * Override the backing-env path. ONLY for tests -- production code
 * should never call this. Must be called BEFORE `getGraphStore()` of
 * the test, otherwise the singleton is already pinned to the old
 * path. Pair with `closeGraphStore()` in test setup/teardown.
 */
export function setGraphStorePath(path: string): void {
	_path = path;
}

/**
 * Lazy-init the env + all sub-DBs.
 */
export async function getGraphStore(): Promise<GraphStore> {
	if (_instance !== null) return _instance;
	if (_initPromise !== null) return _initPromise;

	_initPromise = (async (): Promise<GraphStore> => {
		const t0 = Date.now();
		const mapsizeBytes = readMapsizeBytes();

		// lmdb-js creates a single file at `_path`; ensure the parent
		// directory exists. Do NOT mkdir _path itself -- it's a file, not
		// a directory.
		const parent = dirname(_path);
		if (!existsSync(parent)) {
			mkdirSync(parent, { recursive: true });
		}

		const root = open({
			path:      _path,
			mapSize:   mapsizeBytes,
			maxDbs:    MAX_DBS,
			// Full durability default (no MDB_NOSYNC / MDB_NOMETASYNC /
			// MDB_MAPASYNC) -- per design doc "Sync / durability mode".
			// Phase 1.5 lands this formally with override-via-env-var.
		});

		const open_ = (name: string, opts: { dupSort?: boolean } = {}): AnyDb => root.openDB({
			name,
			keyEncoding:  'binary',
			encoding:     'binary',
			dupSort:      opts.dupSort ?? false,
		});

		const store: GraphStore = {
			root,

			// Graph -- meta uses ordered-binary keys so callers can write
			// short utf8 strings directly (lmdb-js encodes string→buffer
			// transparently for ordered-binary). Values are msgpack-default.
			meta:               root.openDB({ name: 'meta', keyEncoding: 'ordered-binary' }),
			repo:               open_('repo'),
			entity:             open_('entity'),
			nameIndex:          open_('name_index'),
			outEdge:            open_('out_edge'),
			inEdge:             open_('in_edge'),
			unresolved:         open_('unresolved'),
			unresolvedByFile:   open_('unresolved_by_file', { dupSort: true }),

			// Plans
			plan:               open_('plan'),
			planStep:           open_('plan_step'),

			// Conversations
			conversationSession:    open_('conversation_session'),
			conversationTurn:       open_('conversation_turn'),
			conversationTurnByRepo: open_('conversation_turn_by_repo', { dupSort: true }),

			// Todos
			todoList:           open_('todo_list'),
			todoListBySession:  open_('todo_list_by_session', { dupSort: true }),
			todoItem:           open_('todo_item'),
			todoComment:        open_('todo_comment'),

			// Config
			configEntry:        open_('config_entry'),
			configByScope:      open_('config_by_scope', { dupSort: true }),
		};

		log.info(
			{ initMs: Date.now() - t0, mapsizeGiB: mapsizeBytes / 1024 ** 3, path: _path },
			'lmdb graph store initialised',
		);
		_instance = store;
		return store;
	})();

	try {
		return await _initPromise;
	} catch (e) {
		_initPromise = null;
		throw e;
	}
}

/**
 * Close the env. Called by the daemon's graceful-shutdown handler.
 * Errors are logged but not re-thrown (the daemon is on the way down).
 */
export async function closeGraphStore(): Promise<void> {
	const inst = _instance;
	_instance = null;
	_initPromise = null;
	if (inst === null) return;
	try {
		await inst.root.close();
	} catch (e) {
		log.warn({ err: errMessage(e) }, 'lmdb graph store close failed');
	}
}

// ---------------------------------------------------------------------------
// Txn helpers (Phase 1.5 will harden these with timing + retry)
// ---------------------------------------------------------------------------

/**
 * Run `fn` inside an LMDB write transaction. Single-writer at a time
 * (LMDB serializes write txns); concurrent callers queue up. Throws
 * propagate; the txn aborts and partial changes are discarded.
 */
export async function withWriteTxn<T>(
	fn: (store: GraphStore) => T | Promise<T>,
): Promise<T> {
	const store = await getGraphStore();
	return store.root.transaction(() => fn(store));
}

/**
 * Synchronous variant for tight bulk-write loops where the caller wants
 * to drive the txn boundary explicitly. The async variant is preferred
 * for normal usage.
 */
export function withWriteTxnSync<T>(
	store: GraphStore,
	fn: () => T,
): T {
	return store.root.transactionSync(fn);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function readMapsizeBytes(): number {
	const raw = process.env['INSRC_LMDB_MAPSIZE_GIB'];
	if (raw === undefined || raw.length === 0) return DEFAULT_MAPSIZE_GIB * 1024 ** 3;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		log.warn({ raw }, 'INSRC_LMDB_MAPSIZE_GIB invalid; falling back to default');
		return DEFAULT_MAPSIZE_GIB * 1024 ** 3;
	}
	return parsed * 1024 ** 3;
}

function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
