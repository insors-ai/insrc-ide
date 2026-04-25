/**
 * Postgres driver (kind: `postgres`).
 *
 * Uses `pg.Pool` for connection pooling; pool size 3 since the only
 * workloads are analyzer describe/sample calls + the connection
 * tester. Describe consults `information_schema.columns` +
 * `pg_index` + FK constraints for a single table; sample runs a
 * structured SELECT built by `rdbms-common.ts`.
 */

import pgMod from 'pg';

import { getLogger } from '../../../shared/logger.js';
import type {
	ConnectionConfig,
	RdbmsDriver,
	SampleOpts,
	SampleResult,
	SchemaDescription,
	ColumnDescription,
} from '../../../shared/db-driver.js';
import { registerDriver } from '../registry.js';
import {
	POSTGRES_DIALECT,
	SAMPLE_LIMIT,
	SAMPLE_TIMEOUT_MS,
	buildExplainSql,
	buildSampleSql,
	quoteTarget,
	withTimeout,
} from './rdbms-common.js';
import type { PlanResult, QueryAst } from '../../../shared/db-driver.js';
import { prismaSchemaDescription } from './rdbms-prisma.js';

const { Pool } = pgMod;

const log = getLogger('db-pg');

const POOL_MAX = 3;
const IDLE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Driver class
// ---------------------------------------------------------------------------

class PostgresDriver implements RdbmsDriver {
	readonly family = 'rdbms' as const;
	readonly kind = 'postgres';

	private readonly pool: pgMod.Pool;
	/** describe() results are memoized to avoid re-querying
	 *  information_schema on every sample(). Config changes reload
	 *  the pool, so cache lifetime = pool lifetime. */
	private readonly schemaCache = new Map<string, SchemaDescription>();
	private readonly prismaPath: string | undefined;

	constructor(readonly id: string, url: string, prismaPath?: string) {
		this.prismaPath = prismaPath;
		this.pool = new Pool({
			connectionString: url,
			max: POOL_MAX,
			idleTimeoutMillis: IDLE_TIMEOUT_MS,
			connectionTimeoutMillis: SAMPLE_TIMEOUT_MS,
		});
		this.pool.on('error', (err) => {
			log.warn({ id, err: err.message }, 'pool error');
		});
	}

	async describe(target: string): Promise<SchemaDescription> {
		const cached = this.schemaCache.get(target);
		if (cached !== undefined) { return cached; }

		// Prisma fast path: when schemaSource is configured, the parsed
		// schema is the source of truth for describe(). sample() still
		// hits the live DB.
		if (this.prismaPath !== undefined) {
			const result = await prismaSchemaDescription(target, this.prismaPath);
			this.schemaCache.set(target, result);
			return result;
		}

		const { schema, table } = splitTarget(target);
		const columns = await this.fetchColumns(schema, table);
		if (columns.length === 0) {
			throw new Error(
				`data-driver: table '${target}' not found or has no columns`,
			);
		}
		const pk = await this.fetchPrimaryKey(schema, table);
		const fks = await this.fetchForeignKeys(schema, table);

		for (const col of columns) {
			if (pk.has(col.name)) {
				(col as { primaryKey?: boolean }).primaryKey = true;
			}
			const fk = fks.get(col.name);
			if (fk !== undefined) {
				(col as { foreignKey?: { table: string; column: string } }).foreignKey = fk;
			}
		}

		const result: SchemaDescription = {
			target,
			columns,
			source: 'introspect',
		};
		this.schemaCache.set(target, result);
		return result;
	}

	async sample(target: string, opts: SampleOpts): Promise<SampleResult> {
		const schema = await this.describe(target);
		const cols = schema.columns.map(c => c.name);
		const { text, values } = buildSampleSql(target, opts, cols, POSTGRES_DIALECT);

		log.debug({ id: this.id, text }, 'sample query');
		const res = await withTimeout(
			this.pool.query(text, values as unknown[]),
			SAMPLE_TIMEOUT_MS,
		);
		return {
			target,
			columns: res.fields.map(f => f.name),
			rows: res.rows as readonly Readonly<Record<string, unknown>>[],
			truncated: res.rowCount === opts.limit && opts.limit < SAMPLE_LIMIT
				? false
				: res.rowCount === Math.min(opts.limit, SAMPLE_LIMIT),
		};
	}

	async explain(queryAst: QueryAst): Promise<PlanResult> {
		const schema = await this.describe(queryAst.target);
		const cols = schema.columns.map(c => c.name);
		const opts = queryAst.where !== undefined
			? { limit: SAMPLE_LIMIT, where: queryAst.where }
			: { limit: SAMPLE_LIMIT };
		const { text, values } = buildExplainSql(queryAst.target, opts, cols, POSTGRES_DIALECT);
		log.debug({ id: this.id, text }, 'explain query');
		const res = await withTimeout(
			this.pool.query(text, values as unknown[]),
			SAMPLE_TIMEOUT_MS,
		);
		return { plan: res.rows.map((r: Record<string, unknown>) => String(r['QUERY PLAN'] ?? '')).join('\n') };
	}

	async close(): Promise<void> {
		await this.pool.end();
	}

	// -------------------------------------------------------------------------
	// Introspection queries
	// -------------------------------------------------------------------------

	private async fetchColumns(
		schema: string | null,
		table: string,
	): Promise<ColumnDescription[]> {
		const sql = `
			SELECT column_name, data_type, is_nullable
			FROM information_schema.columns
			WHERE table_schema = COALESCE($1, current_schema())
			  AND table_name = $2
			ORDER BY ordinal_position
		`;
		const res = await this.pool.query(sql, [schema, table]);
		return res.rows.map((r: { column_name: string; data_type: string; is_nullable: string }) => ({
			name: r.column_name,
			type: r.data_type,
			nullable: r.is_nullable === 'YES',
		}));
	}

	private async fetchPrimaryKey(
		schema: string | null,
		table: string,
	): Promise<Set<string>> {
		const sql = `
			SELECT a.attname AS column_name
			FROM pg_index i
			JOIN pg_class c ON c.oid = i.indrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
			WHERE i.indisprimary
			  AND n.nspname = COALESCE($1, current_schema())
			  AND c.relname = $2
		`;
		const res = await this.pool.query(sql, [schema, table]);
		return new Set(res.rows.map((r: { column_name: string }) => r.column_name));
	}

	private async fetchForeignKeys(
		schema: string | null,
		table: string,
	): Promise<Map<string, { table: string; column: string }>> {
		const sql = `
			SELECT
				kcu.column_name,
				ccu.table_name   AS foreign_table,
				ccu.column_name  AS foreign_column
			FROM information_schema.table_constraints tc
			JOIN information_schema.key_column_usage kcu
			  ON tc.constraint_schema = kcu.constraint_schema
			 AND tc.constraint_name = kcu.constraint_name
			JOIN information_schema.constraint_column_usage ccu
			  ON tc.constraint_schema = ccu.constraint_schema
			 AND tc.constraint_name = ccu.constraint_name
			WHERE tc.constraint_type = 'FOREIGN KEY'
			  AND tc.table_schema = COALESCE($1, current_schema())
			  AND tc.table_name = $2
		`;
		const res = await this.pool.query(sql, [schema, table]);
		const map = new Map<string, { table: string; column: string }>();
		for (const r of res.rows as { column_name: string; foreign_table: string; foreign_column: string }[]) {
			map.set(r.column_name, { table: r.foreign_table, column: r.foreign_column });
		}
		return map;
	}
}

// ---------------------------------------------------------------------------
// Target splitting
// ---------------------------------------------------------------------------

function splitTarget(target: string): { schema: string | null; table: string } {
	// Validate identifier shape via the same rule the quoter uses.
	quoteTarget(target, POSTGRES_DIALECT);
	if (target.includes('.')) {
		const [schema, table] = target.split('.');
		return { schema: schema ?? null, table: table ?? target };
	}
	return { schema: null, table: target };
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

// CockroachDB is wire-compatible with the Postgres protocol -- the
// same `pg` client + driver implementation works against both. We
// expose it as its own `kind` so users / agents see it explicitly
// in db:list_connections + db:list_driver_kinds, but factory +
// behaviour are identical.
function postgresFactory(connKind: 'postgres' | 'cockroachdb') {
	return async (config: ConnectionConfig) => {
		if (config.url === undefined) {
			throw new Error(`data-driver: ${connKind} connection '${config.id}' missing url`);
		}
		const prismaPath = config.schemaSource?.type === 'prisma'
			? config.schemaSource.path
			: undefined;
		return new PostgresDriver(config.id, config.url, prismaPath);
	};
}

registerDriver({ kind: 'postgres',    family: 'rdbms', factory: postgresFactory('postgres') });
registerDriver({ kind: 'cockroachdb', family: 'rdbms', factory: postgresFactory('cockroachdb') });
