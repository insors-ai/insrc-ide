/**
 * Per-workspace DuckDB pool for the data-analyzer subsystem.
 *
 * Lifetime + isolation rules differ from the core storage pool
 * (`duckdb-storage-pool.ts`):
 *
 *   - One DB *per workspace*, not one process-wide singleton. The
 *     backing file lives at `<workspaceRoot>/.insrc/data-analyzer.db`
 *     so the cache is scoped to the user's workspace and travels with
 *     it (visible, deletable, gitignorable).
 *   - Analyzer state (sample-row cache, profile cards, scorecards,
 *     skill audit log, ...) is regenerable from data sources, so the
 *     entire DB can be wiped without losing anything irreversible.
 *   - Zero coupling to the core DB. Analyzer code paths never JOIN
 *     against `entity` / `relation` / sessions / etc. -- they ask the
 *     daemon for a connection by id and operate against THAT data
 *     source. So no ATTACH, no cross-DB queries, no shared schema.
 *
 * Lifecycle: lazy. The pool for a workspace is created the first
 * time any analyzer call references it; tests can pre-create via
 * `getAnalyzerPool` directly. Closed via `closeAnalyzerPool` (single
 * workspace) or `closeAllAnalyzerPools` (daemon shutdown).
 *
 * Resetting (UI-triggered): `deleteAnalyzerDb` closes the pool, drops
 * it from the registry, removes the .db + .db.wal files. The next
 * analyzer call lazily recreates an empty DB.
 */

import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('duckdb-analyzer-pool');

// Memory budget per workspace pool. Smaller than the core storage
// pool (2 GB) -- the analyzer's working set is dominated by sampled
// rows and profile cards, both bounded at ~50 rows / column. 512 MB
// is overkill for what's there today but leaves headroom for the
// scorecard + lineage tables to grow without retuning.
const DEFAULT_MEMORY_MB = 512;

// Per-workspace DuckDB instance + the in-flight init promise.
// `_pools` holds the resolved instance; `_initPromises` is the
// concurrent-collapse map so two parallel callers for the same
// workspace share the same init.
const _pools         = new Map<string, DuckDBInstance>();
const _initPromises  = new Map<string, Promise<DuckDBInstance>>();

/** Resolve the canonical .db file path for a workspace root. */
export function analyzerDbPath(workspaceRoot: string): string {
	return join(workspaceRoot, '.insrc', 'data-analyzer.db');
}

/** Resolve the .db.wal sibling path. Used by `delete` and status. */
export function analyzerWalPath(workspaceRoot: string): string {
	return analyzerDbPath(workspaceRoot) + '.wal';
}

/**
 * Get-or-create the analyzer DuckDBInstance for `workspaceRoot`.
 * Creates `<workspaceRoot>/.insrc/` if missing, opens the DB
 * (DuckDB creates the file on first open), applies schema, returns.
 *
 * Concurrent first-callers collapse onto the same init promise. On
 * init failure the cached promise is cleared so the next caller can
 * re-attempt.
 */
export async function getAnalyzerPool(workspaceRoot: string): Promise<DuckDBInstance> {
	const existing = _pools.get(workspaceRoot);
	if (existing !== undefined) return existing;
	const inflight = _initPromises.get(workspaceRoot);
	if (inflight !== undefined) return inflight;

	const initPromise = (async (): Promise<DuckDBInstance> => {
		const t0 = Date.now();
		const dbPath = analyzerDbPath(workspaceRoot);

		// Ensure `<workspaceRoot>/.insrc/` exists.
		const parent = dirname(dbPath);
		if (!existsSync(parent)) {
			mkdirSync(parent, { recursive: true });
		}

		const instance = await DuckDBInstance.create(dbPath);
		const conn = await instance.connect();
		try {
			await conn.run(`SET memory_limit = '${DEFAULT_MEMORY_MB}MB'`);
			// Lock down ATTACH / httpfs / load_extension. Analyzer
			// pools never need to reach beyond their own file --
			// data-source connections live in a separate driver pool.
			await conn.run('SET enable_external_access = false');
			await applySchema(conn);
		} finally {
			conn.disconnectSync();
		}

		log.info(
			{ workspaceRoot, dbPath, initMs: Date.now() - t0, memoryMb: DEFAULT_MEMORY_MB },
			'analyzer pool initialised',
		);
		_pools.set(workspaceRoot, instance);
		return instance;
	})();

	_initPromises.set(workspaceRoot, initPromise);
	try {
		return await initPromise;
	} catch (e) {
		log.error({ workspaceRoot, err: errMessage(e) }, 'analyzer pool init failed');
		throw e;
	} finally {
		_initPromises.delete(workspaceRoot);
	}
}

/**
 * Acquire a fresh Connection on the workspace's analyzer instance,
 * run `fn`, close the Connection. Mirror of `withStorageConnection`.
 */
export async function withAnalyzerConnection<T>(
	workspaceRoot: string,
	fn: (conn: DuckDBConnection) => Promise<T>,
): Promise<T> {
	const instance = await getAnalyzerPool(workspaceRoot);
	const conn = await instance.connect();
	try {
		return await fn(conn);
	} finally {
		conn.disconnectSync();
	}
}

/**
 * Close the pool for one workspace (releases the file lock so the
 * next `getAnalyzerPool` reopens fresh, or `deleteAnalyzerDb` can
 * remove the file). Idempotent.
 */
export async function closeAnalyzerPool(workspaceRoot: string): Promise<void> {
	// If init is still in-flight, await it so we don't leak a
	// half-open instance.
	const inflight = _initPromises.get(workspaceRoot);
	if (inflight !== undefined) {
		try { await inflight; } catch { /* already logged */ }
	}
	const inst = _pools.get(workspaceRoot);
	_pools.delete(workspaceRoot);
	if (inst === undefined) return;
	try {
		inst.closeSync();
	} catch (e) {
		log.warn({ workspaceRoot, err: errMessage(e) }, 'analyzer pool close failed');
	}
}

/** Close every open analyzer pool. Called from daemon shutdown. */
export async function closeAllAnalyzerPools(): Promise<void> {
	const workspaces = [..._pools.keys(), ..._initPromises.keys()];
	await Promise.all(workspaces.map(w => closeAnalyzerPool(w)));
}

/**
 * Status snapshot for a workspace's analyzer DB. Safe to call
 * regardless of pool state -- never opens a new pool just to read
 * stats. If the file isn't on disk yet, reports `not_initialized`.
 *
 * Row counts are queried only when the pool is open OR the file
 * exists (we open a temporary read-only connection in the latter
 * case). Either way, `analyzer.status` does NOT lazy-init the pool.
 */
export interface AnalyzerStatus {
	readonly workspaceRoot: string;
	readonly dbPath: string;
	readonly walPath: string;
	readonly state: 'not_initialized' | 'initialized' | 'pool_open';
	readonly fileSize: number;
	readonly walSize: number;
	readonly fileMtime?: string;
	readonly schemaVersion?: number;
	readonly tableRowCounts?: Readonly<Record<string, number>>;
}

export async function analyzerStatus(workspaceRoot: string): Promise<AnalyzerStatus> {
	const dbPath = analyzerDbPath(workspaceRoot);
	const walPath = analyzerWalPath(workspaceRoot);
	const fileSize = safeSize(dbPath);
	const walSize  = safeSize(walPath);

	if (fileSize === 0 && !_pools.has(workspaceRoot)) {
		return {
			workspaceRoot, dbPath, walPath,
			state: 'not_initialized',
			fileSize: 0, walSize: 0,
		};
	}

	const fileMtime = safeMtime(dbPath);
	const poolOpen = _pools.has(workspaceRoot);

	// Query schema version + per-table row counts via a fresh
	// connection. If the pool is already open we go through it; if
	// not, briefly open the file (read-only intent) just for stats.
	const stats = poolOpen
		? await withAnalyzerConnection(workspaceRoot, queryStats)
		: await withTempReadConnection(dbPath, queryStats).catch(() => null);

	const out: AnalyzerStatus = {
		workspaceRoot, dbPath, walPath,
		state: poolOpen ? 'pool_open' : 'initialized',
		fileSize, walSize,
		...(fileMtime !== undefined ? { fileMtime } : {}),
		...(stats?.schemaVersion !== undefined ? { schemaVersion: stats.schemaVersion } : {}),
		...(stats?.tableRowCounts !== undefined ? { tableRowCounts: stats.tableRowCounts } : {}),
	};
	return out;
}

/**
 * Wipe the workspace's analyzer DB. Closes the pool first (releases
 * the file lock), then deletes `.db` + `.db.wal`. The next analyzer
 * call lazy-recreates an empty DB. Returns what was deleted so the
 * caller (UI command) can show "freed N MB" feedback.
 */
export interface AnalyzerDeleteResult {
	readonly workspaceRoot: string;
	readonly dbPath: string;
	readonly walPath: string;
	readonly poolWasOpen: boolean;
	readonly dbDeleted: boolean;
	readonly walDeleted: boolean;
	readonly bytesFreed: number;
}

export async function deleteAnalyzerDb(workspaceRoot: string): Promise<AnalyzerDeleteResult> {
	const dbPath  = analyzerDbPath(workspaceRoot);
	const walPath = analyzerWalPath(workspaceRoot);
	const dbSizeBefore  = safeSize(dbPath);
	const walSizeBefore = safeSize(walPath);
	const poolWasOpen = _pools.has(workspaceRoot) || _initPromises.has(workspaceRoot);

	await closeAnalyzerPool(workspaceRoot);

	const dbDeleted  = safeUnlink(dbPath);
	const walDeleted = safeUnlink(walPath);

	log.info(
		{ workspaceRoot, dbPath, dbDeleted, walDeleted, bytesFreed: dbSizeBefore + walSizeBefore },
		'analyzer DB reset',
	);

	return {
		workspaceRoot, dbPath, walPath, poolWasOpen,
		dbDeleted, walDeleted,
		bytesFreed: dbSizeBefore + walSizeBefore,
	};
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Schema bootstrap. Just the meta `_migrations` table for now;
 * analyzer-owned tables (sample_row, profile_card, scorecard,
 * skill_audit, ...) get added as their respective skill paths
 * migrate onto this pool.
 */
const SCHEMA_VERSION = 1;

async function applySchema(conn: DuckDBConnection): Promise<void> {
	await conn.run(`
		CREATE TABLE IF NOT EXISTS _migrations (
			version    INTEGER PRIMARY KEY,
			applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);
	await conn.run(
		'INSERT INTO _migrations (version) VALUES (?) ON CONFLICT (version) DO NOTHING',
		[SCHEMA_VERSION],
	);
}

interface QueriedStats {
	readonly schemaVersion: number;
	readonly tableRowCounts: Readonly<Record<string, number>>;
}

async function queryStats(conn: DuckDBConnection): Promise<QueriedStats> {
	const versionReader = await conn.runAndReadAll(
		'SELECT MAX(version)::INTEGER AS v FROM _migrations',
	);
	const versionRow = versionReader.getRows()[0];
	const schemaVersion = Number(versionRow?.[0] ?? 0);

	// Discover analyzer tables (everything except the meta-table).
	const tablesReader = await conn.runAndReadAll(
		`SELECT table_name FROM information_schema.tables
		 WHERE table_schema = 'main' AND table_name NOT LIKE '\\_%' ESCAPE '\\'`,
	);
	const tableNames = tablesReader.getRows().map(r => String(r[0]));
	const counts: Record<string, number> = {};
	for (const t of tableNames) {
		const r = await conn.runAndReadAll(`SELECT COUNT(*)::INTEGER FROM ${quoteIdent(t)}`);
		counts[t] = Number(r.getRows()[0]?.[0] ?? 0);
	}
	return { schemaVersion, tableRowCounts: counts };
}

async function withTempReadConnection<T>(
	dbPath: string,
	fn: (conn: DuckDBConnection) => Promise<T>,
): Promise<T> {
	// `READ_ONLY` mode keeps us from racing with the live pool if
	// one happens to open between the `_pools.has` check above and
	// here. (The status path tries this AFTER `_pools.has` returned
	// false, so usually no race; the access_mode is belt-and-braces.)
	const instance = await DuckDBInstance.create(dbPath, { access_mode: 'READ_ONLY' });
	try {
		const conn = await instance.connect();
		try { return await fn(conn); }
		finally { conn.disconnectSync(); }
	} finally {
		instance.closeSync();
	}
}

function safeSize(path: string): number {
	try { return statSync(path).size; }
	catch { return 0; }
}

function safeMtime(path: string): string | undefined {
	try { return statSync(path).mtime.toISOString(); }
	catch { return undefined; }
}

function safeUnlink(path: string): boolean {
	try { unlinkSync(path); return true; }
	catch { return false; }
}

function quoteIdent(name: string): string {
	return '"' + name.replace(/"/g, '""') + '"';
}

function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
