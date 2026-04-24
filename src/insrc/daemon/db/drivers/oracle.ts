/**
 * Oracle driver (kind: `oracle`).
 *
 * Uses `oracledb` in thin mode (default from v6.x) -- no Instant
 * Client install needed for Oracle 12c+. Thick mode would require
 * `oracledb.initOracleClient()` with the path to Instant Client;
 * deferred to a follow-up when someone hits a pre-12c server.
 *
 * Introspection via `ALL_TAB_COLUMNS` + `ALL_CONSTRAINTS` +
 * `ALL_CONS_COLUMNS`. Identifiers are uppercased by Oracle unless
 * quoted; we preserve user-supplied case.
 */

import oracledb from 'oracledb';

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
	ORACLE_DIALECT,
	SAMPLE_TIMEOUT_MS,
	buildSampleSql,
	quoteTarget,
} from './rdbms-common.js';

const log = getLogger('db-oracle');

oracledb.fetchAsString = [oracledb.CLOB];
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

function parseUrl(url: string): oracledb.PoolAttributes {
	const u = new URL(url);
	const database = u.pathname === '' || u.pathname === '/' ? '' : u.pathname.slice(1);
	return {
		user: decodeURIComponent(u.username),
		password: decodeURIComponent(u.password),
		connectString: `${u.hostname}:${u.port === '' ? '1521' : u.port}/${database}`,
		poolMin: 0,
		poolMax: 3,
		poolIncrement: 1,
		queueTimeout: SAMPLE_TIMEOUT_MS,
	};
}

class OracleDriver implements RdbmsDriver {
	readonly family = 'rdbms' as const;
	readonly kind = 'oracle';

	private readonly poolPromise: Promise<oracledb.Pool>;
	private readonly schemaCache = new Map<string, SchemaDescription>();

	constructor(readonly id: string, url: string) {
		this.poolPromise = oracledb.createPool(parseUrl(url));
	}

	async describe(target: string): Promise<SchemaDescription> {
		const cached = this.schemaCache.get(target);
		if (cached !== undefined) { return cached; }

		const { owner, table } = splitTarget(target);
		const columns = await this.fetchColumns(owner, table);
		if (columns.length === 0) {
			throw new Error(`data-driver: table '${target}' not found`);
		}
		const pk = await this.fetchPrimaryKey(owner, table);
		for (const col of columns) {
			if (pk.has(col.name.toUpperCase())) {
				(col as { primaryKey?: boolean }).primaryKey = true;
			}
		}
		const result: SchemaDescription = { target, columns, source: 'introspect' };
		this.schemaCache.set(target, result);
		return result;
	}

	async sample(target: string, opts: SampleOpts): Promise<SampleResult> {
		const schema = await this.describe(target);
		const cols = schema.columns.map(c => c.name);
		const { text, values } = buildSampleSql(target, opts, cols, ORACLE_DIALECT);
		log.debug({ id: this.id, text }, 'sample query');

		const pool = await this.poolPromise;
		const conn = await pool.getConnection();
		try {
			const res = await conn.execute<Record<string, unknown>>(
				text,
				values as unknown[],
				{ outFormat: oracledb.OUT_FORMAT_OBJECT },
			);
			const limit = Math.min(opts.limit, 50);
			const rows = res.rows ?? [];
			return {
				target,
				columns: cols,
				rows,
				truncated: rows.length >= limit,
			};
		} finally {
			await conn.close();
		}
	}

	async close(): Promise<void> {
		const pool = await this.poolPromise;
		await pool.close(5);
	}

	// -------------------------------------------------------------------------

	private async fetchColumns(
		owner: string | null,
		table: string,
	): Promise<ColumnDescription[]> {
		const pool = await this.poolPromise;
		const conn = await pool.getConnection();
		try {
			const res = await conn.execute<Record<string, unknown>>(
				`SELECT column_name, data_type, nullable
				 FROM all_tab_columns
				 WHERE table_name = :1
				   AND owner = COALESCE(:2, USER)
				 ORDER BY column_id`,
				[table.toUpperCase(), owner?.toUpperCase() ?? null],
				{ outFormat: oracledb.OUT_FORMAT_OBJECT },
			);
			return (res.rows ?? []).map((r) => ({
				name: r['COLUMN_NAME'] as string,
				type: r['DATA_TYPE'] as string,
				nullable: r['NULLABLE'] === 'Y',
			}));
		} finally {
			await conn.close();
		}
	}

	private async fetchPrimaryKey(
		owner: string | null,
		table: string,
	): Promise<Set<string>> {
		const pool = await this.poolPromise;
		const conn = await pool.getConnection();
		try {
			const res = await conn.execute<Record<string, unknown>>(
				`SELECT cc.column_name
				 FROM all_constraints c
				 JOIN all_cons_columns cc
				   ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
				 WHERE c.constraint_type = 'P'
				   AND c.table_name = :1
				   AND c.owner = COALESCE(:2, USER)`,
				[table.toUpperCase(), owner?.toUpperCase() ?? null],
				{ outFormat: oracledb.OUT_FORMAT_OBJECT },
			);
			return new Set((res.rows ?? []).map(r => r['COLUMN_NAME'] as string));
		} finally {
			await conn.close();
		}
	}
}

// ---------------------------------------------------------------------------

function splitTarget(target: string): { owner: string | null; table: string } {
	quoteTarget(target, ORACLE_DIALECT);
	if (target.includes('.')) {
		const [owner, table] = target.split('.');
		return { owner: owner ?? null, table: table ?? target };
	}
	return { owner: null, table: target };
}

registerDriver({
	kind: 'oracle',
	family: 'rdbms',
	factory: async (config: ConnectionConfig) => {
		if (config.url === undefined) {
			throw new Error(`data-driver: oracle connection '${config.id}' missing url`);
		}
		return new OracleDriver(config.id, config.url);
	},
});
