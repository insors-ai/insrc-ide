/**
 * SQLite driver (kind: `sqlite`).
 *
 * Uses `better-sqlite3` (synchronous, fast, no pool needed -- each
 * driver instance holds one read-only db handle). Config `url` is a
 * file:// URL or a plain path string.
 *
 * Opened in read-only mode; writes would raise SQLITE_READONLY from
 * the driver even before our builder-level guards kick in. Belt +
 * braces.
 */

import Database from 'better-sqlite3';

import { getLogger } from '../../../shared/logger.js';
import type {
	ColumnDescription,
	ConnectionConfig,
	RdbmsDriver,
	SampleOpts,
	SampleResult,
	SchemaDescription,
} from '../../../shared/db-driver.js';
import { registerDriver } from '../registry.js';
import {
	SQLITE_DIALECT,
	buildSampleSql,
	quoteTarget,
} from './rdbms-common.js';

const log = getLogger('db-sqlite');

class SqliteDriver implements RdbmsDriver {
	readonly family = 'rdbms' as const;
	readonly kind = 'sqlite';

	private readonly db: Database.Database;
	private readonly schemaCache = new Map<string, SchemaDescription>();

	constructor(readonly id: string, filename: string) {
		this.db = new Database(filename, { readonly: true, fileMustExist: true });
		this.db.pragma('query_only = ON');
	}

	async describe(target: string): Promise<SchemaDescription> {
		const cached = this.schemaCache.get(target);
		if (cached !== undefined) { return cached; }

		quoteTarget(target, SQLITE_DIALECT);
		// `PRAGMA table_info(X)` requires an unquoted identifier; we've
		// already verified the shape above so concatenation is safe.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const info = this.db.prepare(`PRAGMA table_info(${target})`).all() as any[];
		if (info.length === 0) {
			throw new Error(`data-driver: table '${target}' not found`);
		}
		const fks = this.db.prepare(`PRAGMA foreign_key_list(${target})`)
			.all() as { from: string; table: string; to: string }[];
		const fkMap = new Map<string, { table: string; column: string }>();
		for (const fk of fks) { fkMap.set(fk.from, { table: fk.table, column: fk.to }); }

		const columns: ColumnDescription[] = info.map((r: { name: string; type: string; notnull: number; pk: number }) => {
			const base: ColumnDescription = {
				name: r.name,
				type: r.type === '' ? 'any' : r.type,
				nullable: r.notnull === 0,
				primaryKey: r.pk > 0,
			};
			const fk = fkMap.get(r.name);
			return fk === undefined ? base : { ...base, foreignKey: fk };
		});

		const result: SchemaDescription = { target, columns, source: 'introspect' };
		this.schemaCache.set(target, result);
		return result;
	}

	async sample(target: string, opts: SampleOpts): Promise<SampleResult> {
		const schema = await this.describe(target);
		const cols = schema.columns.map(c => c.name);
		const { text, values } = buildSampleSql(target, opts, cols, SQLITE_DIALECT);
		log.debug({ id: this.id, text }, 'sample query');
		const stmt = this.db.prepare(text);
		const rows = stmt.all(...values as unknown[]) as Record<string, unknown>[];
		const limit = Math.min(opts.limit, 50);
		return {
			target,
			columns: cols,
			rows,
			truncated: rows.length >= limit,
		};
	}

	async close(): Promise<void> {
		this.db.close();
	}
}

// ---------------------------------------------------------------------------

function pathOf(config: ConnectionConfig): string {
	// Accept either url=file:///path or plain `path:` on the config.
	if (config.path !== undefined) { return config.path; }
	if (config.url === undefined) {
		throw new Error(`data-driver: sqlite connection '${config.id}' missing path/url`);
	}
	if (config.url.startsWith('file:')) {
		try {
			const u = new URL(config.url);
			return u.pathname;
		} catch {
			// fall through
		}
	}
	return config.url;
}

registerDriver({
	kind: 'sqlite',
	family: 'rdbms',
	factory: async (config: ConnectionConfig) => new SqliteDriver(config.id, pathOf(config)),
});
