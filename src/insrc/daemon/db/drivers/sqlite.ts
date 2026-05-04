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
	AggregateRequest,
	AggregateResult,
	ColumnDescription,
	ConnectionConfig,
	CorrelationMatrixRequest,
	CorrelationMatrixResult,
	DistinctRequest,
	DistinctResult,
	HistogramRequest,
	HistogramResult,
	OutlierRequest,
	OutlierResult,
	RdbmsDriver,
	SampleOpts,
	SampleResult,
	SchemaDescription,
} from '../../../shared/db-driver.js';
import { registerDriver } from '../registry.js';
import {
	SQLITE_DIALECT,
	buildExplainSql,
	buildSampleSql,
	compileAggregate,
	compileDistinct,
	executeCorrelationMatrix,
	executeHistogram,
	executeOutliers,
	quoteTarget,
	readAggregateRow,
	readDistinctCount,
	readDistinctRows,
} from './rdbms-common.js';
import type { PlanResult, QueryAst } from '../../../shared/db-driver.js';
import { prismaSchemaDescription } from './rdbms-prisma.js';

const log = getLogger('db-sqlite');

class SqliteDriver implements RdbmsDriver {
	readonly family = 'rdbms' as const;
	readonly kind = 'sqlite';

	private readonly db: Database.Database;
	private readonly schemaCache = new Map<string, SchemaDescription>();
	private readonly prismaPath: string | undefined;

	constructor(readonly id: string, filename: string, prismaPath?: string) {
		this.db = new Database(filename, { readonly: true, fileMustExist: true });
		this.db.pragma('query_only = ON');
		this.prismaPath = prismaPath;
	}

	async describe(target: string): Promise<SchemaDescription> {
		const cached = this.schemaCache.get(target);
		if (cached !== undefined) { return cached; }

		if (this.prismaPath !== undefined) {
			const result = await prismaSchemaDescription(target, this.prismaPath);
			this.schemaCache.set(target, result);
			return result;
		}

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
			metadata: { samplingMethod: 'first' },
		};
	}

	async explain(queryAst: QueryAst): Promise<PlanResult> {
		const schema = await this.describe(queryAst.target);
		const cols = schema.columns.map(c => c.name);
		const opts = queryAst.where !== undefined
			? { limit: 50, where: queryAst.where }
			: { limit: 50 };
		const { text, values } = buildExplainSql(queryAst.target, opts, cols, SQLITE_DIALECT);
		log.debug({ id: this.id, text }, 'explain query');
		const rows = this.db.prepare(text).all(...values as unknown[]) as Record<string, unknown>[];
		return { plan: rows.map(r => JSON.stringify(r)).join('\n') };
	}

	async aggregate(target: string, request: AggregateRequest): Promise<AggregateResult> {
		const schema = await this.describe(target);
		const cols = schema.columns.map(c => c.name);
		const compiled = compileAggregate(target, request, cols, SQLITE_DIALECT);
		log.debug({ id: this.id, text: compiled.text }, 'aggregate query');
		// SQLite has no built-in STDDEV / VARIANCE / PERCENTILE_CONT;
		// the engine surfaces those as "no such function: ..." errors
		// at run-time. The tool layer renders that as `success: false`
		// without the daemon needing per-driver checks here.
		const row = this.db.prepare(compiled.text)
			.get(...compiled.values as unknown[]) as Record<string, unknown> | undefined;
		return { target, values: readAggregateRow(row, compiled.keys) };
	}

	async distinct(target: string, request: DistinctRequest): Promise<DistinctResult> {
		const schema = await this.describe(target);
		const cols = schema.columns.map(c => c.name);
		const compiled = compileDistinct(target, request, cols, SQLITE_DIALECT);
		log.debug({ id: this.id }, 'distinct query');
		const countRow = this.db.prepare(compiled.distinctCountSql)
			.get() as Record<string, unknown> | undefined;
		const valueRows = this.db.prepare(compiled.topValuesSql)
			.all() as Record<string, unknown>[];
		return {
			target,
			column: request.column,
			distinctCount: readDistinctCount(countRow),
			topValues: readDistinctRows(valueRows),
		};
	}

	async histogram(target: string, request: HistogramRequest): Promise<HistogramResult> {
		const schema = await this.describe(target);
		const cols = schema.columns.map(c => c.name);
		return executeHistogram(request, {
			target,
			knownColumns: cols,
			dialect: SQLITE_DIALECT,
			aggregate: (req) => this.aggregate(target, req),
			runRows: async (sql, values) =>
				this.db.prepare(sql).all(...values as unknown[]) as Record<string, unknown>[],
		});
	}

	async correlationMatrix(target: string, request: CorrelationMatrixRequest): Promise<CorrelationMatrixResult> {
		const schema = await this.describe(target);
		const cols = schema.columns.map(c => c.name);
		return executeCorrelationMatrix(request, {
			target,
			knownColumns: cols,
			dialect: SQLITE_DIALECT,
			aggregate: (req) => this.aggregate(target, req),
			runRows: async (sql, values) =>
				this.db.prepare(sql).all(...values as unknown[]) as Record<string, unknown>[],
		});
	}

	async outliers(target: string, request: OutlierRequest): Promise<OutlierResult> {
		const schema = await this.describe(target);
		const cols = schema.columns.map(c => c.name);
		return executeOutliers(request, {
			target,
			knownColumns: cols,
			dialect: SQLITE_DIALECT,
			aggregate: (req) => this.aggregate(target, req),
			runRows: async (sql, values) =>
				this.db.prepare(sql).all(...values as unknown[]) as Record<string, unknown>[],
		});
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
	factory: async (config: ConnectionConfig) => {
		const prismaPath = config.schemaSource?.type === 'prisma' ? config.schemaSource.path : undefined;
		return new SqliteDriver(config.id, pathOf(config), prismaPath);
	},
});
