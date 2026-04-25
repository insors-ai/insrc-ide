/**
 * MySQL / MariaDB driver (kind: `mysql`, `mariadb`).
 *
 * Uses `mysql2/promise`. Introspection via `information_schema.columns`
 * + KEY_COLUMN_USAGE for PK/FK; sample uses the structured SELECT
 * from rdbms-common with the mysql dialect (`?` placeholders +
 * backtick quoting).
 */

import { createPool } from 'mysql2/promise';
import type { Pool, PoolOptions } from 'mysql2/promise';

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
	MYSQL_DIALECT,
	SAMPLE_TIMEOUT_MS,
	buildExplainSql,
	buildSampleSql,
	quoteTarget,
	withTimeout,
} from './rdbms-common.js';
import type { PlanResult, QueryAst } from '../../../shared/db-driver.js';
import { prismaSchemaDescription } from './rdbms-prisma.js';

const log = getLogger('db-mysql');

const POOL_MAX = 3;

class MysqlDriver implements RdbmsDriver {
	readonly family = 'rdbms' as const;
	readonly kind: string;

	private readonly pool: Pool;
	private readonly schemaCache = new Map<string, SchemaDescription>();
	private readonly prismaPath: string | undefined;

	constructor(readonly id: string, kind: 'mysql' | 'mariadb', url: string, prismaPath?: string) {
		this.kind = kind;
		this.prismaPath = prismaPath;
		const opts = parseUrlToPoolOptions(url);
		this.pool = createPool({
			...opts,
			connectionLimit: POOL_MAX,
			connectTimeout: SAMPLE_TIMEOUT_MS,
		});
	}

	async describe(target: string): Promise<SchemaDescription> {
		const cached = this.schemaCache.get(target);
		if (cached !== undefined) { return cached; }

		if (this.prismaPath !== undefined) {
			const result = await prismaSchemaDescription(target, this.prismaPath);
			this.schemaCache.set(target, result);
			return result;
		}

		const { schema, table } = splitTarget(target);
		const columns = await this.fetchColumns(schema, table);
		if (columns.length === 0) {
			throw new Error(`data-driver: table '${target}' not found`);
		}
		const pk = await this.fetchPrimaryKey(schema, table);
		const fks = await this.fetchForeignKeys(schema, table);
		for (const col of columns) {
			if (pk.has(col.name)) { (col as { primaryKey?: boolean }).primaryKey = true; }
			const fk = fks.get(col.name);
			if (fk !== undefined) {
				(col as { foreignKey?: { table: string; column: string } }).foreignKey = fk;
			}
		}
		const result: SchemaDescription = { target, columns, source: 'introspect' };
		this.schemaCache.set(target, result);
		return result;
	}

	async sample(target: string, opts: SampleOpts): Promise<SampleResult> {
		const schema = await this.describe(target);
		const cols = schema.columns.map(c => c.name);
		const { text, values } = buildSampleSql(target, opts, cols, MYSQL_DIALECT);
		log.debug({ id: this.id, text }, 'sample query');

		const [rows, fields] = await withTimeout(
			this.pool.query(text, values as unknown[]),
			SAMPLE_TIMEOUT_MS,
		) as unknown as [unknown[], { name: string }[]];

		const limit = Math.min(opts.limit, 50);
		return {
			target,
			columns: fields.map(f => f.name),
			rows: rows as readonly Readonly<Record<string, unknown>>[],
			truncated: Array.isArray(rows) && rows.length >= limit,
			metadata: { samplingMethod: 'first' },
		};
	}

	async explain(queryAst: QueryAst): Promise<PlanResult> {
		const schema = await this.describe(queryAst.target);
		const cols = schema.columns.map(c => c.name);
		const opts = queryAst.where !== undefined
			? { limit: 50, where: queryAst.where }
			: { limit: 50 };
		const { text, values } = buildExplainSql(queryAst.target, opts, cols, MYSQL_DIALECT);
		log.debug({ id: this.id, text }, 'explain query');
		const [rows] = await withTimeout(
			this.pool.query(text, values as unknown[]),
			SAMPLE_TIMEOUT_MS,
		) as unknown as [Record<string, unknown>[], unknown];
		return { plan: rows.map(r => JSON.stringify(r)).join('\n') };
	}

	async close(): Promise<void> {
		await this.pool.end();
	}

	// -------------------------------------------------------------------------

	private async fetchColumns(
		schema: string | null,
		table: string,
	): Promise<ColumnDescription[]> {
		const [rows] = await this.pool.query(
			`SELECT column_name AS name, data_type AS type, is_nullable AS nullable
			 FROM information_schema.columns
			 WHERE table_schema = COALESCE(?, DATABASE())
			   AND table_name = ?
			 ORDER BY ordinal_position`,
			[schema, table],
		) as unknown as [{ name: string; type: string; nullable: string }[], unknown];
		return rows.map(r => ({
			name: r.name,
			type: r.type,
			nullable: r.nullable === 'YES',
		}));
	}

	private async fetchPrimaryKey(
		schema: string | null,
		table: string,
	): Promise<Set<string>> {
		const [rows] = await this.pool.query(
			`SELECT column_name AS name
			 FROM information_schema.KEY_COLUMN_USAGE
			 WHERE table_schema = COALESCE(?, DATABASE())
			   AND table_name = ?
			   AND constraint_name = 'PRIMARY'`,
			[schema, table],
		) as unknown as [{ name: string }[], unknown];
		return new Set(rows.map(r => r.name));
	}

	private async fetchForeignKeys(
		schema: string | null,
		table: string,
	): Promise<Map<string, { table: string; column: string }>> {
		const [rows] = await this.pool.query(
			`SELECT column_name AS name,
			        referenced_table_name AS ftable,
			        referenced_column_name AS fcol
			 FROM information_schema.KEY_COLUMN_USAGE
			 WHERE table_schema = COALESCE(?, DATABASE())
			   AND table_name = ?
			   AND referenced_table_name IS NOT NULL`,
			[schema, table],
		) as unknown as [{ name: string; ftable: string; fcol: string }[], unknown];
		const map = new Map<string, { table: string; column: string }>();
		for (const r of rows) {
			map.set(r.name, { table: r.ftable, column: r.fcol });
		}
		return map;
	}
}

// ---------------------------------------------------------------------------

function splitTarget(target: string): { schema: string | null; table: string } {
	quoteTarget(target, MYSQL_DIALECT);
	if (target.includes('.')) {
		const [schema, table] = target.split('.');
		return { schema: schema ?? null, table: table ?? target };
	}
	return { schema: null, table: target };
}

function parseUrlToPoolOptions(url: string): PoolOptions {
	// mysql2 accepts a URL string via `uri` in v3, but older versions
	// expect the parts separately. We split manually for portability.
	const u = new URL(url);
	const opts: PoolOptions = {
		host: u.hostname,
		port: u.port === '' ? 3306 : Number(u.port),
		user: decodeURIComponent(u.username),
	};
	if (u.password !== '') { opts.password = decodeURIComponent(u.password); }
	if (u.pathname !== '' && u.pathname !== '/') {
		opts.database = u.pathname.slice(1);
	}
	return opts;
}

// ---------------------------------------------------------------------------

function makeFactory(kind: 'mysql' | 'mariadb') {
	return async (config: ConnectionConfig) => {
		if (config.url === undefined) {
			throw new Error(`data-driver: ${kind} connection '${config.id}' missing url`);
		}
		const prismaPath = config.schemaSource?.type === 'prisma' ? config.schemaSource.path : undefined;
		return new MysqlDriver(config.id, kind, config.url, prismaPath);
	};
}

registerDriver({ kind: 'mysql',   family: 'rdbms', factory: makeFactory('mysql') });
registerDriver({ kind: 'mariadb', family: 'rdbms', factory: makeFactory('mariadb') });
