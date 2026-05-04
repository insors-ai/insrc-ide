/**
 * Shared helpers for RDBMS drivers (Postgres, MySQL, SQLite, MSSQL,
 * Oracle). Keeps each kind-specific driver focused on its client
 * library + dialect differences; the safety envelope (identifier
 * quoting, parametrised where compilation, DDL/DML denylist, limit
 * + timeout clamping) lives here.
 *
 * The LLM never sees or produces raw SQL. Inputs are structured
 * WhereClause objects + identifier-shaped target strings; we emit
 * the SQL ourselves and never interpolate user values into the
 * statement text.
 */

import type {
	AggregateFunction,
	AggregateRequest,
	AggregateResult,
	AggregateSpec,
	CorrelationMatrixRequest,
	CorrelationMatrixResult,
	CorrelationMethod,
	DistinctRequest,
	HistogramMode,
	HistogramRequest,
	HistogramResult,
	OutlierRequest,
	OutlierResult,
	SampleOpts,
	WhereClause,
} from '../../../shared/db-driver.js';

export const SAMPLE_LIMIT = 50;
export const SAMPLE_TIMEOUT_MS = 5_000;

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * Hard denylist -- if any compiled SQL we emit contains one of
 * these, something has gone very wrong and we refuse to run. The
 * parametrised query builders below will never produce these; this
 * is belt-and-braces against future refactors.
 */
const DML_DDL_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|CALL|DO|BEGIN|COMMIT|ROLLBACK|MERGE|REPLACE|VACUUM|ATTACH|DETACH)\b/i;

/**
 * Identifier quoting style, swappable per dialect.
 *   postgres / sqlite / mssql: "foo"
 *   mysql / mariadb:           `foo`
 *   oracle:                    "foo" (and case-sensitive)
 */
export interface Dialect {
	readonly quoteIdent: (part: string) => string;
	readonly placeholder: (index: number) => string;
	readonly limitClause: (limit: number) => string;
}

export const POSTGRES_DIALECT: Dialect = {
	quoteIdent: (p) => `"${p.replace(/"/g, '""')}"`,
	placeholder: (i) => `$${i}`,
	limitClause: (n) => `LIMIT ${n}`,
};

export const MYSQL_DIALECT: Dialect = {
	quoteIdent: (p) => `\`${p.replace(/`/g, '``')}\``,
	placeholder: () => '?',
	limitClause: (n) => `LIMIT ${n}`,
};

export const SQLITE_DIALECT: Dialect = {
	quoteIdent: (p) => `"${p.replace(/"/g, '""')}"`,
	placeholder: () => '?',
	limitClause: (n) => `LIMIT ${n}`,
};

export const MSSQL_DIALECT: Dialect = {
	quoteIdent: (p) => `[${p.replace(/]/g, ']]')}]`,
	placeholder: (i) => `@p${i}`,
	limitClause: () => '', // uses TOP; see buildSampleSql
};

export const ORACLE_DIALECT: Dialect = {
	quoteIdent: (p) => `"${p.replace(/"/g, '""')}"`,
	placeholder: (i) => `:${i}`,
	limitClause: (n) => `FETCH FIRST ${n} ROWS ONLY`,
};

/**
 * ClickHouse uses backtick identifier quoting (like MySQL) and a
 * named-typed placeholder syntax `{p1:String}`. The driver passes
 * the typed value via `query_params`. We declare every placeholder
 * as `:String` since ClickHouse implicit-casts to the column type
 * for predicates -- avoids per-value type inference here.
 */
export const CLICKHOUSE_DIALECT: Dialect = {
	quoteIdent: (p) => `\`${p.replace(/`/g, '``')}\``,
	placeholder: (i) => `{p${i}:String}`,
	limitClause: (n) => `LIMIT ${n}`,
};

// ---------------------------------------------------------------------------
// Target parsing
// ---------------------------------------------------------------------------

/**
 * Split a `schema.table` (or bare `table`) target + quote each part
 * with the dialect's rules. Rejects anything outside the strict
 * identifier shape.
 */
export function quoteTarget(target: string, dialect: Dialect): string {
	if (!IDENTIFIER_RE.test(target)) {
		throw new Error(`data-driver: invalid table identifier '${target}'`);
	}
	return target.split('.').map(dialect.quoteIdent).join('.');
}

// ---------------------------------------------------------------------------
// Where compilation
// ---------------------------------------------------------------------------

export interface CompiledWhere {
	readonly text: string;
	readonly values: readonly unknown[];
}

/**
 * Compile a list of WhereClause objects into a parametrised SQL
 * fragment. Column names are validated against `knownColumns` to
 * stop typo-via-LLM + defense-in-depth against identifier injection;
 * values are passed through as parameters.
 */
export function compileWhere(
	clauses: readonly WhereClause[],
	knownColumns: readonly string[],
	dialect: Dialect,
	startingIndex = 1,
): CompiledWhere {
	if (clauses.length === 0) { return { text: '', values: [] }; }

	const columnSet = new Set(knownColumns.map(c => c.toLowerCase()));
	const values: unknown[] = [];
	const fragments: string[] = [];
	let paramIndex = startingIndex;

	for (const clause of clauses) {
		if (!columnSet.has(clause.column.toLowerCase())) {
			throw new Error(
				`data-driver: unknown column '${clause.column}' in where clause`,
			);
		}
		const col = dialect.quoteIdent(clause.column);
		switch (clause.op) {
			case '=':
			case '!=': {
				fragments.push(`${col} ${clause.op} ${dialect.placeholder(paramIndex++)}`);
				values.push(clause.value);
				break;
			}
			case 'is null': {
				fragments.push(`${col} IS NULL`);
				break;
			}
			case 'in': {
				if (!Array.isArray(clause.value) || clause.value.length === 0) {
					throw new Error(
						`data-driver: 'in' op requires a non-empty array value ` +
						`(column '${clause.column}')`,
					);
				}
				const placeholders: string[] = [];
				for (const v of clause.value) {
					placeholders.push(dialect.placeholder(paramIndex++));
					values.push(v);
				}
				fragments.push(`${col} IN (${placeholders.join(', ')})`);
				break;
			}
		}
	}

	return { text: `WHERE ${fragments.join(' AND ')}`, values };
}

// ---------------------------------------------------------------------------
// Sample SQL assembly
// ---------------------------------------------------------------------------

export interface BuiltSampleSql extends CompiledWhere {
	readonly columnList: string;
}

/**
 * Assemble the final `SELECT ... FROM ... [WHERE ...] LIMIT N`
 * statement. Checks the emitted text against the DML/DDL denylist
 * as a last line of defense before handing to the client.
 */
export function buildSampleSql(
	target: string,
	opts: SampleOpts,
	columns: readonly string[],
	dialect: Dialect,
): { readonly text: string; readonly values: readonly unknown[] } {
	const quotedTarget = quoteTarget(target, dialect);
	const limit = Math.min(Math.max(1, opts.limit), SAMPLE_LIMIT);
	const where = compileWhere(opts.where ?? [], columns, dialect);
	const topClause = dialect === MSSQL_DIALECT ? ` TOP ${limit}` : '';
	const tailLimit = dialect === MSSQL_DIALECT ? '' : ' ' + dialect.limitClause(limit);
	const text = `SELECT${topClause} * FROM ${quotedTarget} ${where.text}${tailLimit}`.replace(/\s+/g, ' ').trim();

	if (looksLikeMutation(text)) {
		throw new Error(`data-driver: refused suspicious SQL: ${text}`);
	}
	return { text, values: where.values };
}

export function looksLikeMutation(sql: string): boolean {
	return DML_DDL_KEYWORDS.test(sql);
}

// ---------------------------------------------------------------------------
// Explain SQL assembly
// ---------------------------------------------------------------------------

/**
 * Build an EXPLAIN-shaped query for a SELECT against `target`. Each
 * dialect has its own prefix:
 *   - postgres: EXPLAIN (FORMAT TEXT)
 *   - mysql:    EXPLAIN
 *   - sqlite:   EXPLAIN QUERY PLAN
 *   - mssql:    handled out-of-band (driver runs SET SHOWPLAN_TEXT
 *               ON + the original SELECT)
 *   - oracle:   handled out-of-band (driver runs EXPLAIN PLAN FOR
 *               + DBMS_XPLAN.DISPLAY())
 *
 * For the two out-of-band dialects this helper still produces the
 * inner SELECT; the driver wraps it. Same DML/DDL denylist applies
 * via buildSampleSql.
 */
export function buildExplainSql(
	target: string,
	opts: SampleOpts,
	columns: readonly string[],
	dialect: Dialect,
): { readonly text: string; readonly values: readonly unknown[] } {
	const inner = buildSampleSql(target, opts, columns, dialect);
	if (dialect === POSTGRES_DIALECT) {
		return { text: `EXPLAIN (FORMAT TEXT) ${inner.text}`, values: inner.values };
	}
	if (dialect === MYSQL_DIALECT) {
		return { text: `EXPLAIN ${inner.text}`, values: inner.values };
	}
	if (dialect === SQLITE_DIALECT) {
		return { text: `EXPLAIN QUERY PLAN ${inner.text}`, values: inner.values };
	}
	// MSSQL + Oracle are handled by their drivers.
	return inner;
}

// ---------------------------------------------------------------------------
// Aggregate SQL assembly (Phase 0.1)
// ---------------------------------------------------------------------------

/**
 * Per-dialect rendering of an aggregate function. Returns the SQL
 * expression to splice into the `SELECT` list. Some dialects don't
 * support a given function natively (e.g. SQLite has no PERCENTILE);
 * those throw.
 *
 * The `colSql` argument is the already-quoted column reference; the
 * caller is responsible for passing a value that has been validated
 * against the table's column list.
 */
function renderAggExpr(
	fn: AggregateFunction,
	colSql: string,
	dialect: Dialect,
	args?: AggregateSpec['args'],
): string {
	switch (fn) {
		case 'count':
			return 'COUNT(*)';
		case 'count_non_null':
			return `COUNT(${colSql})`;
		case 'distinct_count':
			return `COUNT(DISTINCT ${colSql})`;
		case 'sum':
			return `SUM(${colSql})`;
		case 'avg':
			return `AVG(${colSql})`;
		case 'min':
			return `MIN(${colSql})`;
		case 'max':
			return `MAX(${colSql})`;
		case 'stddev':
			// Sample stddev. Postgres / DuckDB / Oracle / Snowflake / Redshift
			// all accept STDDEV_SAMP; MySQL has it too. SQLite has no
			// stddev built-in -- the SQLite driver overrides this path
			// (or throws). MSSQL uses `STDEV` not `STDDEV_SAMP` -- we
			// branch on dialect.
			if (dialect === MSSQL_DIALECT) return `STDEV(${colSql})`;
			return `STDDEV_SAMP(${colSql})`;
		case 'variance':
			if (dialect === MSSQL_DIALECT) return `VAR(${colSql})`;
			return `VAR_SAMP(${colSql})`;
		case 'percentile': {
			const p = args?.p;
			if (typeof p !== 'number' || p < 0 || p > 1) {
				throw new Error(
					'data-driver: aggregate function "percentile" requires args.p in [0, 1]',
				);
			}
			// PERCENTILE_CONT is the SQL standard; Postgres / Oracle /
			// MSSQL / DuckDB accept the WITHIN GROUP form. MySQL 8+
			// supports it; older MySQL / SQLite don't and the driver
			// will need to throw. ClickHouse uses quantile(p)(col) --
			// that's a per-driver override.
			return `PERCENTILE_CONT(${p}) WITHIN GROUP (ORDER BY ${colSql})`;
		}
	}
}

/**
 * Build the result-key for one aggregation. Stable + deterministic
 * so callers can reference results by name without seeing the SQL.
 *
 *   count:                   <col>__count
 *   percentile (p=0.5):      <col>__percentile_0_5
 *   ...:                     <col>__<fn>
 */
export function aggregateResultKey(spec: AggregateSpec): string {
	if (spec.function === 'percentile') {
		const p = spec.args?.p;
		if (typeof p !== 'number') {
			throw new Error('data-driver: percentile spec missing args.p');
		}
		const pStr = String(p).replace('.', '_');
		return `${spec.column}__percentile_${pStr}`;
	}
	return `${spec.column}__${spec.function}`;
}

export interface CompiledAggregate {
	readonly text: string;
	readonly values: readonly unknown[];
	/** Result-key per aggregation in declaration order. The driver
	 *  reads these out of the engine's first row to assemble
	 *  `AggregateResult.values`. Each key is also used as the column
	 *  alias in the emitted SQL, so the engine returns rows already
	 *  keyed how we want. */
	readonly keys: readonly string[];
}

export interface CompiledAggregateExprs {
	/** Exprs ready to splice into a SELECT list, already aliased
	 *  (e.g. `AVG("col") AS "col__avg"`). */
	readonly exprs: readonly string[];
	readonly keys: readonly string[];
}

/**
 * Build the SELECT-list expressions + result-keys for an aggregate
 * request, without committing to a FROM source. RDBMS drivers
 * compose this with `quoteTarget(target, dialect)`; file drivers
 * (parquet over DuckDB, etc.) compose with `read_parquet('path')`
 * or similar table-function FROM clauses.
 *
 * Validates each spec's column against `knownColumns` (`count` is
 * exempt -- COUNT(*) doesn't reference a column). Rejects duplicate
 * result-keys.
 */
export function compileAggregateExprs(
	request: AggregateRequest,
	knownColumns: readonly string[],
	dialect: Dialect,
): CompiledAggregateExprs {
	if (request.aggregations.length === 0) {
		throw new Error('data-driver: aggregate request has zero aggregations');
	}

	const columnSet = new Set(knownColumns.map(c => c.toLowerCase()));
	const seenKeys = new Set<string>();
	const exprs: string[] = [];
	const keys: string[] = [];

	for (const spec of request.aggregations) {
		// `count` is COUNT(*); the column name still flows through to
		// the result-key for caller-side identification, so we don't
		// validate against the table's columns.
		if (spec.function !== 'count' && !columnSet.has(spec.column.toLowerCase())) {
			throw new Error(
				`data-driver: unknown column '${spec.column}' for aggregate '${spec.function}'`,
			);
		}
		const colSql = spec.function === 'count' ? '*' : dialect.quoteIdent(spec.column);
		const expr = renderAggExpr(spec.function, colSql, dialect, spec.args);
		const key = aggregateResultKey(spec);
		if (seenKeys.has(key)) {
			throw new Error(
				`data-driver: duplicate aggregate key '${key}'; pass distinct columns or different percentile args`,
			);
		}
		seenKeys.add(key);
		// Quote the alias so result-keys with `__` survive case-folding
		// dialects (Postgres lowercases unquoted identifiers).
		exprs.push(`${expr} AS ${dialect.quoteIdent(key)}`);
		keys.push(key);
	}

	return { exprs, keys };
}

/**
 * RDBMS-flavoured aggregate compiler: composes the expressions from
 * `compileAggregateExprs` with a `quoteTarget(target)` FROM clause.
 * Use this for any driver whose target is a SQL identifier (table
 * name); use `compileAggregateExprs` directly when the FROM source
 * is a table-function (e.g. `read_parquet('...')`).
 */
export function compileAggregate(
	target: string,
	request: AggregateRequest,
	knownColumns: readonly string[],
	dialect: Dialect,
): CompiledAggregate {
	const { exprs, keys } = compileAggregateExprs(request, knownColumns, dialect);
	const quotedTarget = quoteTarget(target, dialect);
	const where = compileWhere(request.where ?? [], knownColumns, dialect);
	const whereClause = where.text === '' ? '' : ` ${where.text}`;
	const text = `SELECT ${exprs.join(', ')} FROM ${quotedTarget}${whereClause}`;
	if (looksLikeMutation(text)) {
		throw new Error(`data-driver: refused suspicious SQL: ${text}`);
	}
	return { text, values: where.values, keys };
}

// ---------------------------------------------------------------------------
// Distinct compilation (Phase 0.3 of plans/analyzers/data-analyzer-skills.md)
// ---------------------------------------------------------------------------

/** Hard cap on `topN`. The tool layer also clamps; this is a
 *  belt-and-braces ceiling for a callsite that goes through
 *  `compileDistinct` directly. */
const DISTINCT_TOPN_MAX = 1000;

/**
 * Compile two SQL queries: one for `COUNT(DISTINCT col)` and one for
 * the top-N values ordered by frequency desc, value asc. Returns both
 * fragments; the driver runs them either as a sequence (separate
 * round-trips) or fuses them via UNION ALL where the dialect benefits.
 *
 * Column name is validated against `knownColumns` to defend against
 * identifier injection; the integer LIMIT is interpolated literally
 * (clamped first) since most dialects can't bind LIMIT as a parameter.
 */
export interface CompiledDistinct {
	readonly distinctCountSql: string;
	readonly topValuesSql: string;
	readonly topN: number;
}

export function compileDistinct(
	target: string,
	request: DistinctRequest,
	knownColumns: readonly string[],
	dialect: Dialect,
	{ asTableExpr }: { asTableExpr?: string } = {},
): CompiledDistinct {
	const columnSet = new Set(knownColumns.map(c => c.toLowerCase()));
	if (!columnSet.has(request.column.toLowerCase())) {
		throw new Error(`data-driver: unknown column '${request.column}'`);
	}
	const topN = Math.min(Math.max(1, Math.floor(request.topN)), DISTINCT_TOPN_MAX);
	const fromClause = asTableExpr !== undefined
		? asTableExpr
		: quoteTarget(target, dialect);
	const colSql = dialect.quoteIdent(request.column);

	// MSSQL has TOP N + no LIMIT; everything else uses LIMIT/FETCH FIRST.
	const limitClause = dialect.limitClause(topN);
	const isMssqlLike = limitClause === '';
	const distinctCountSql = `SELECT COUNT(DISTINCT ${colSql}) AS distinct_count FROM ${fromClause}`;
	const topValuesSql = isMssqlLike
		? `SELECT TOP ${topN} ${colSql} AS value, COUNT(*) AS count FROM ${fromClause}`
			+ ` GROUP BY ${colSql} ORDER BY COUNT(*) DESC, ${colSql} ASC`
		: `SELECT ${colSql} AS value, COUNT(*) AS count FROM ${fromClause}`
			+ ` GROUP BY ${colSql} ORDER BY COUNT(*) DESC, ${colSql} ASC ${limitClause}`;

	if (looksLikeMutation(distinctCountSql) || looksLikeMutation(topValuesSql)) {
		throw new Error('data-driver: refused suspicious SQL in compileDistinct');
	}
	return { distinctCountSql, topValuesSql, topN };
}

/**
 * Read the `{ value, count }` rows produced by the topValuesSql.
 * Coerces count via the same path as `readAggregateRow` (some
 * dialects ship counts as bigint or string).
 */
export function readDistinctRows(
	rows: readonly Readonly<Record<string, unknown>>[],
): { readonly value: unknown; readonly count: number }[] {
	const out: { value: unknown; count: number }[] = [];
	for (const r of rows) {
		const raw = r['count'] ?? r['COUNT'] ?? r['Count'];
		let count: number;
		if (typeof raw === 'number') count = Number.isFinite(raw) ? raw : 0;
		else if (typeof raw === 'bigint') count = Number(raw);
		else if (typeof raw === 'string') { const n = Number(raw); count = Number.isFinite(n) ? n : 0; }
		else count = 0;
		out.push({ value: r['value'] ?? r['VALUE'] ?? r['Value'] ?? null, count });
	}
	return out;
}

/** Read the `distinct_count` scalar produced by `distinctCountSql`. */
export function readDistinctCount(
	row: Readonly<Record<string, unknown>> | undefined,
): number {
	const raw = row?.['distinct_count'] ?? row?.['DISTINCT_COUNT'] ?? row?.['Distinct_count'];
	if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
	if (typeof raw === 'bigint') return Number(raw);
	if (typeof raw === 'string') { const n = Number(raw); return Number.isFinite(n) ? n : 0; }
	return 0;
}

/**
 * Pull aggregate values out of the engine's first row and coerce to
 * `number | null`. Most clients return numerics as JS `number` or
 * `bigint`; some return strings (Postgres `numeric` ships as string
 * to preserve precision). We coerce: bigint -> Number,
 * string -> Number (NaN becomes null), other -> null.
 *
 * The driver passes the `keys` from `compileAggregate` so the order
 * matches; we use bracket-access on the row rather than positional
 * to handle drivers that return objects vs arrays interchangeably.
 */
export function readAggregateRow(
	row: Readonly<Record<string, unknown>> | undefined,
	keys: readonly string[],
): Record<string, number | null> {
	const out: Record<string, number | null> = {};
	for (const k of keys) {
		const raw = row?.[k];
		if (raw === null || raw === undefined) {
			out[k] = null;
		} else if (typeof raw === 'number') {
			out[k] = Number.isFinite(raw) ? raw : null;
		} else if (typeof raw === 'bigint') {
			out[k] = Number(raw);
		} else if (typeof raw === 'string') {
			const n = Number(raw);
			out[k] = Number.isFinite(n) ? n : null;
		} else {
			out[k] = null;
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Histogram SQL assembly (Phase 0.2)
// ---------------------------------------------------------------------------

const HISTOGRAM_BUCKETS_MIN = 4;
const HISTOGRAM_BUCKETS_MAX = 200;

export function clampHistogramBuckets(n: number): number {
	if (!Number.isFinite(n)) return 20;
	return Math.min(Math.max(HISTOGRAM_BUCKETS_MIN, Math.floor(n)), HISTOGRAM_BUCKETS_MAX);
}

/**
 * Build the bounds query (min, max, count_non_null, count) used as the
 * first leg of the two-leg histogram protocol. Returns it as a regular
 * `AggregateRequest` so the driver can dispatch through its existing
 * `aggregate(target, request)` path -- one less code path to maintain.
 */
export function histogramBoundsRequest(request: HistogramRequest): AggregateRequest {
	const aggregations: AggregateSpec[] = [
		{ column: request.column, function: 'min' },
		{ column: request.column, function: 'max' },
		{ column: request.column, function: 'count_non_null' },
		{ column: '*',           function: 'count' },
	];
	const out: { aggregations: AggregateSpec[]; where?: readonly WhereClause[] } = { aggregations };
	if (request.where !== undefined && request.where.length > 0) out.where = request.where;
	return out as AggregateRequest;
}

export interface CompiledHistogram {
	readonly text: string;
	readonly values: readonly unknown[];
}

/**
 * Compile the bucket-counts query. The caller has already established
 * `lower` / `upper` bounds (via `histogramBoundsRequest`). The query
 * returns rows of the form `{ bucket_idx: number, lower: number,
 * upper: number, bucket_count: number }`.
 *
 * - `equal-width`: pure arithmetic via FLOOR((col - lower) / width).
 *   Works on every dialect we support.
 * - `equal-frequency`: NTILE(n) OVER (ORDER BY col). Requires window
 *   functions (Postgres / DuckDB / SQLite >=3.25 / MySQL >=8.0 /
 *   MSSQL / Oracle all support it).
 */
export function compileHistogramBuckets(
	target: string,
	request: HistogramRequest,
	lower: number,
	upper: number,
	knownColumns: readonly string[],
	dialect: Dialect,
	{ asTableExpr, paramStartIndex = 1 }: { asTableExpr?: string; paramStartIndex?: number } = {},
): CompiledHistogram {
	const columnSet = new Set(knownColumns.map(c => c.toLowerCase()));
	if (!columnSet.has(request.column.toLowerCase())) {
		throw new Error(`data-driver: unknown column '${request.column}' in histogram`);
	}
	const buckets = clampHistogramBuckets(request.buckets);
	const colSql = dialect.quoteIdent(request.column);
	const fromClause = asTableExpr !== undefined ? asTableExpr : quoteTarget(target, dialect);
	const where = compileWhere(request.where ?? [], knownColumns, dialect, paramStartIndex);
	// The histogram counts only non-null rows; add an explicit IS NOT NULL.
	const guardedWhere = where.text === ''
		? `WHERE ${colSql} IS NOT NULL`
		: `${where.text} AND ${colSql} IS NOT NULL`;

	const mode: HistogramMode = request.mode ?? 'equal-width';
	let text: string;
	if (mode === 'equal-width') {
		// Width is computed on the JS side and interpolated as a literal --
		// it's a derived numeric, not user input.
		const width = upper === lower ? 1 : (upper - lower) / buckets;
		// The CASE clamp ensures the max value (where (col - lower)/width
		// would equal `buckets`) lands in the last bucket rather than
		// spilling into bucket index `buckets`.
		const idxExpr =
			`CASE WHEN ${colSql} >= ${literal(upper, dialect)} THEN ${buckets - 1}` +
			` ELSE CAST(FLOOR((${colSql} - ${literal(lower, dialect)}) / ${literal(width, dialect)}) AS INTEGER) END`;
		text =
			`SELECT ${idxExpr} AS bucket_idx, COUNT(*) AS bucket_count` +
			` FROM ${fromClause} ${guardedWhere}` +
			` GROUP BY ${idxExpr} ORDER BY bucket_idx`;
	} else {
		// equal-frequency. Use NTILE inside a CTE-style subquery so the
		// outer SELECT can group by bucket and read back its lo / hi.
		text =
			`SELECT bucket_idx, MIN(${colSql}) AS bucket_lower, MAX(${colSql}) AS bucket_upper, COUNT(*) AS bucket_count` +
			` FROM (SELECT ${colSql}, NTILE(${buckets}) OVER (ORDER BY ${colSql}) AS bucket_idx` +
			`        FROM ${fromClause} ${guardedWhere}) AS h` +
			` GROUP BY bucket_idx ORDER BY bucket_idx`;
	}
	if (looksLikeMutation(text)) {
		throw new Error('data-driver: refused suspicious SQL in compileHistogramBuckets');
	}
	return { text, values: where.values };
}

/**
 * Build the equal-width buckets array purely from the bounds + the
 * row results of `compileHistogramBuckets`. Works regardless of which
 * dialect produced the rows; the SQL is responsible for delivering
 * `bucket_idx` + `bucket_count` (equal-width) or `bucket_idx` +
 * `bucket_lower` + `bucket_upper` + `bucket_count` (equal-frequency).
 */
export function readHistogramRows(
	rows: readonly Readonly<Record<string, unknown>>[],
	lower: number,
	upper: number,
	bucketCount: number,
	mode: HistogramMode,
): { lower: number; upper: number; count: number }[] {
	if (mode === 'equal-width') {
		const width = upper === lower ? 1 : (upper - lower) / bucketCount;
		const out: { lower: number; upper: number; count: number }[] = [];
		const counts = new Array<number>(bucketCount).fill(0);
		for (const r of rows) {
			const idx = numericFromRaw(r['bucket_idx'] ?? r['BUCKET_IDX'] ?? r['Bucket_idx']);
			const cnt = numericFromRaw(r['bucket_count'] ?? r['BUCKET_COUNT'] ?? r['Bucket_count']);
			if (idx === null || cnt === null) continue;
			const i = Math.max(0, Math.min(bucketCount - 1, Math.floor(idx)));
			counts[i]! += cnt;
		}
		for (let i = 0; i < bucketCount; i++) {
			out.push({
				lower: lower + i * width,
				upper: i === bucketCount - 1 ? upper : lower + (i + 1) * width,
				count: counts[i]!,
			});
		}
		return out;
	}
	// equal-frequency: each row supplies its own bucket_lower / bucket_upper.
	const out: { lower: number; upper: number; count: number }[] = [];
	for (const r of rows) {
		const lo = numericFromRaw(r['bucket_lower'] ?? r['BUCKET_LOWER'] ?? r['Bucket_lower']);
		const hi = numericFromRaw(r['bucket_upper'] ?? r['BUCKET_UPPER'] ?? r['Bucket_upper']);
		const cnt = numericFromRaw(r['bucket_count'] ?? r['BUCKET_COUNT'] ?? r['Bucket_count']);
		if (lo === null || hi === null || cnt === null) continue;
		out.push({ lower: lo, upper: hi, count: cnt });
	}
	return out;
}

function numericFromRaw(raw: unknown): number | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
	if (typeof raw === 'bigint') return Number(raw);
	if (typeof raw === 'string') { const n = Number(raw); return Number.isFinite(n) ? n : null; }
	return null;
}

/**
 * Format a numeric literal for splicing into compiled SQL. We never
 * splice user-supplied values via this path -- only derived numerics
 * from the bounds query (lower / upper / width). NaN / Infinity get
 * stringified as `'NULL'` so the surrounding arithmetic short-circuits
 * cleanly.
 */
function literal(n: number, _dialect: Dialect): string {
	if (!Number.isFinite(n)) return 'NULL';
	// Use enough precision to round-trip a JS double through SQL parsing.
	return Number(n).toPrecision(15);
}

// ---------------------------------------------------------------------------
// Correlation matrix (Phase 0.4)
// ---------------------------------------------------------------------------

/**
 * Compile a single SQL that returns one column per ordered upper-
 * triangular pair plus a row count. Pearson uses native `corr()` on
 * Postgres / DuckDB; computed expression elsewhere. Spearman wraps the
 * Pearson SQL with a CTE that ranks each column via RANK() OVER
 * (ORDER BY col), then correlates the ranks (de facto Spearman).
 *
 * Returns:
 *   text   -- single SQL
 *   values -- WHERE values
 *   keys   -- list of `pair__i_j` aliases in the SELECT list, in
 *             column-pair order (i < j; (j, i) reads the same)
 *   pairs  -- the matching (i, j) index pairs
 *   nKey   -- alias of the row-count column
 */
export interface CompiledCorrelation {
	readonly text: string;
	readonly values: readonly unknown[];
	readonly keys: readonly string[];
	readonly pairs: readonly (readonly [number, number])[];
	readonly nKey: string;
}

export function compileCorrelationMatrix(
	target: string,
	request: CorrelationMatrixRequest,
	knownColumns: readonly string[],
	dialect: Dialect,
	{ asTableExpr, paramStartIndex = 1 }: { asTableExpr?: string; paramStartIndex?: number } = {},
): CompiledCorrelation {
	if (request.columns.length < 2) {
		throw new Error('data-driver: correlation matrix requires >= 2 columns');
	}
	if (request.columns.length > 10) {
		throw new Error('data-driver: correlation matrix capped at 10 columns');
	}
	const columnSet = new Set(knownColumns.map(c => c.toLowerCase()));
	for (const c of request.columns) {
		if (!columnSet.has(c.toLowerCase())) {
			throw new Error(`data-driver: unknown column '${c}' in correlation matrix`);
		}
	}
	const cols = request.columns.map(c => dialect.quoteIdent(c));
	const method: CorrelationMethod = request.method ?? 'pearson';
	const where = compileWhere(request.where ?? [], knownColumns, dialect, paramStartIndex);
	// Restrict to rows where ALL requested columns are non-null
	// (pairwise complete observations).
	const nonNullPredicate = cols.map(c => `${c} IS NOT NULL`).join(' AND ');
	const guardedWhere = where.text === ''
		? `WHERE ${nonNullPredicate}`
		: `${where.text} AND ${nonNullPredicate}`;
	const fromClause = asTableExpr !== undefined ? asTableExpr : quoteTarget(target, dialect);

	// For Spearman, replace each column with its rank in a CTE-style
	// subquery, then correlate the ranks.
	let baseFrom: string;
	let rankedCols: string[];
	if (method === 'spearman') {
		const rankExprs = cols.map((c, i) => `RANK() OVER (ORDER BY ${c}) AS r${i}`);
		baseFrom = `(SELECT ${cols.join(', ')}, ${rankExprs.join(', ')} FROM ${fromClause} ${guardedWhere}) AS rs`;
		rankedCols = cols.map((_, i) => `r${i}`);
	} else {
		baseFrom = `${fromClause} ${guardedWhere}`;
		rankedCols = cols.slice();
	}

	const exprs: string[] = [];
	const keys: string[] = [];
	const pairs: [number, number][] = [];
	for (let i = 0; i < rankedCols.length; i++) {
		for (let j = i + 1; j < rankedCols.length; j++) {
			const xi = rankedCols[i]!;
			const xj = rankedCols[j]!;
			const corrSql = dialect.quoteIdent === POSTGRES_DIALECT.quoteIdent
				? `CORR(${xi}, ${xj})`
				: `CORR(${xi}, ${xj})`;
			// Compute corr via a portable formula when CORR is unavailable;
			// SQLite, MySQL, MSSQL all lack it. We prefer the native fn
			// where present; fall back to the formula otherwise.
			const expr = dialectHasCorr(dialect)
				? corrSql
				: portableCorrExpr(xi, xj);
			const key = `pair__${i}_${j}`;
			exprs.push(`${expr} AS ${dialect.quoteIdent(key)}`);
			keys.push(key);
			pairs.push([i, j]);
		}
	}
	const nKey = 'pair__n';
	exprs.push(`COUNT(*) AS ${dialect.quoteIdent(nKey)}`);

	const text = `SELECT ${exprs.join(', ')} FROM ${baseFrom}`;
	if (looksLikeMutation(text)) {
		throw new Error('data-driver: refused suspicious SQL in compileCorrelationMatrix');
	}
	return { text, values: where.values, keys, pairs, nKey };
}

function dialectHasCorr(dialect: Dialect): boolean {
	// Postgres + Oracle + DuckDB (POSTGRES_DIALECT shape) have native CORR.
	// SQLite, MySQL, MSSQL, ClickHouse don't (or use it differently).
	return dialect === POSTGRES_DIALECT || dialect === ORACLE_DIALECT;
}

function portableCorrExpr(a: string, b: string): string {
	// Standard sample-Pearson formula:
	//   corr = (N*sum(ab) - sum(a)*sum(b)) /
	//          sqrt((N*sum(a^2) - sum(a)^2) * (N*sum(b^2) - sum(b)^2))
	// Computed as a single SELECT expression. NaN / divide-by-zero
	// surfaces as NULL in most dialects (SQLite returns 0; we coerce).
	const N = `CAST(COUNT(*) AS DOUBLE PRECISION)`;
	const sa = `SUM(CAST(${a} AS DOUBLE PRECISION))`;
	const sb = `SUM(CAST(${b} AS DOUBLE PRECISION))`;
	const sab = `SUM(CAST(${a} AS DOUBLE PRECISION) * CAST(${b} AS DOUBLE PRECISION))`;
	const saa = `SUM(CAST(${a} AS DOUBLE PRECISION) * CAST(${a} AS DOUBLE PRECISION))`;
	const sbb = `SUM(CAST(${b} AS DOUBLE PRECISION) * CAST(${b} AS DOUBLE PRECISION))`;
	const num = `(${N} * ${sab} - ${sa} * ${sb})`;
	const den = `SQRT((${N} * ${saa} - ${sa} * ${sa}) * (${N} * ${sbb} - ${sb} * ${sb}))`;
	// `NULLIF` guards against zero-variance columns producing NaN.
	return `(${num}) / NULLIF(${den}, 0)`;
}

export function readCorrelationRow(
	row: Readonly<Record<string, unknown>> | undefined,
	keys: readonly string[],
	pairs: readonly (readonly [number, number])[],
	nKey: string,
	columnCount: number,
): { matrix: (number | null)[][]; nonNullCount: number } {
	const matrix: (number | null)[][] = [];
	for (let i = 0; i < columnCount; i++) {
		const r: (number | null)[] = [];
		for (let j = 0; j < columnCount; j++) {
			r.push(i === j ? 1 : null);
		}
		matrix.push(r);
	}
	for (let k = 0; k < keys.length; k++) {
		const [i, j] = pairs[k]!;
		const raw = row?.[keys[k]!];
		const v = numericFromRaw(raw);
		matrix[i]![j] = v;
		matrix[j]![i] = v;
	}
	const nonNullCount = numericFromRaw(row?.[nKey]) ?? 0;
	return { matrix, nonNullCount };
}

// ---------------------------------------------------------------------------
// Outliers (Phase 0.5) -- compile helpers used by tool-level glue
// ---------------------------------------------------------------------------

export const OUTLIER_THRESHOLD_DEFAULTS = { iqr: 1.5, zscore: 3 } as const;
export const OUTLIER_EXAMPLES_DEFAULT = 20;
export const OUTLIER_EXAMPLES_MAX = 50;

export function clampOutlierExamples(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return OUTLIER_EXAMPLES_DEFAULT;
	return Math.min(Math.max(1, Math.floor(n)), OUTLIER_EXAMPLES_MAX);
}

export function outlierThreshold(request: OutlierRequest): number {
	if (typeof request.threshold === 'number' && Number.isFinite(request.threshold) && request.threshold > 0) {
		return request.threshold;
	}
	return OUTLIER_THRESHOLD_DEFAULTS[request.method];
}

/**
 * Build the bounds-discovery aggregate for an outlier query. IQR
 * needs three percentiles + count; zscore needs avg + stddev + count.
 */
export function outlierBoundsRequest(request: OutlierRequest): AggregateRequest {
	const aggregations: AggregateSpec[] =
		request.method === 'iqr'
			? [
				{ column: request.column, function: 'percentile', args: { p: 0.25 } },
				{ column: request.column, function: 'percentile', args: { p: 0.50 } },
				{ column: request.column, function: 'percentile', args: { p: 0.75 } },
				{ column: request.column, function: 'count_non_null' },
			]
			: [
				{ column: request.column, function: 'avg' },
				{ column: request.column, function: 'stddev' },
				{ column: request.column, function: 'count_non_null' },
			];
	const out: { aggregations: AggregateSpec[]; where?: readonly WhereClause[] } = { aggregations };
	if (request.where !== undefined && request.where.length > 0) out.where = request.where;
	return out as AggregateRequest;
}

/**
 * Compile the outlier-counts query: number of values below `lower`
 * and above `upper`. One round-trip; two scalar results.
 */
export function compileOutlierCounts(
	target: string,
	request: OutlierRequest,
	lower: number,
	upper: number,
	knownColumns: readonly string[],
	dialect: Dialect,
	{ asTableExpr, paramStartIndex = 1 }: { asTableExpr?: string; paramStartIndex?: number } = {},
): CompiledHistogram {
	const columnSet = new Set(knownColumns.map(c => c.toLowerCase()));
	if (!columnSet.has(request.column.toLowerCase())) {
		throw new Error(`data-driver: unknown column '${request.column}' in outliers`);
	}
	const colSql = dialect.quoteIdent(request.column);
	const fromClause = asTableExpr !== undefined ? asTableExpr : quoteTarget(target, dialect);
	const where = compileWhere(request.where ?? [], knownColumns, dialect, paramStartIndex);
	const guardedWhere = where.text === ''
		? `WHERE ${colSql} IS NOT NULL`
		: `${where.text} AND ${colSql} IS NOT NULL`;
	const text =
		`SELECT` +
		`  SUM(CASE WHEN ${colSql} < ${literal(lower, dialect)} THEN 1 ELSE 0 END) AS below_count,` +
		`  SUM(CASE WHEN ${colSql} > ${literal(upper, dialect)} THEN 1 ELSE 0 END) AS above_count` +
		` FROM ${fromClause} ${guardedWhere}`;
	if (looksLikeMutation(text)) {
		throw new Error('data-driver: refused suspicious SQL in compileOutlierCounts');
	}
	return { text, values: where.values };
}

/**
 * Compile the example-collection sample query: up to `examples`
 * outlier values + their side. Uses LIMIT (or TOP for MSSQL); ordered
 * by absolute deviation from the bounds so the most extreme values
 * surface first.
 */
export function compileOutlierExamples(
	target: string,
	request: OutlierRequest,
	lower: number,
	upper: number,
	knownColumns: readonly string[],
	dialect: Dialect,
	{ asTableExpr, paramStartIndex = 1 }: { asTableExpr?: string; paramStartIndex?: number } = {},
): CompiledHistogram {
	const columnSet = new Set(knownColumns.map(c => c.toLowerCase()));
	if (!columnSet.has(request.column.toLowerCase())) {
		throw new Error(`data-driver: unknown column '${request.column}' in outliers`);
	}
	const colSql = dialect.quoteIdent(request.column);
	const fromClause = asTableExpr !== undefined ? asTableExpr : quoteTarget(target, dialect);
	const examples = clampOutlierExamples(request.examples);
	const where = compileWhere(request.where ?? [], knownColumns, dialect, paramStartIndex);
	const outlierPred = `(${colSql} < ${literal(lower, dialect)} OR ${colSql} > ${literal(upper, dialect)})`;
	const guardedWhere = where.text === ''
		? `WHERE ${colSql} IS NOT NULL AND ${outlierPred}`
		: `${where.text} AND ${colSql} IS NOT NULL AND ${outlierPred}`;
	// Order by extremity; pick the values furthest outside the bounds.
	const orderExpr =
		`CASE WHEN ${colSql} < ${literal(lower, dialect)} THEN ${literal(lower, dialect)} - ${colSql}` +
		` ELSE ${colSql} - ${literal(upper, dialect)} END`;
	const topClause = dialect === MSSQL_DIALECT ? ` TOP ${examples}` : '';
	const tailLimit = dialect === MSSQL_DIALECT ? '' : ' ' + dialect.limitClause(examples);
	const text =
		`SELECT${topClause} ${colSql} AS value, ` +
		`  CASE WHEN ${colSql} < ${literal(lower, dialect)} THEN 'below' ELSE 'above' END AS side` +
		` FROM ${fromClause} ${guardedWhere}` +
		` ORDER BY ${orderExpr} DESC${tailLimit}`;
	if (looksLikeMutation(text)) {
		throw new Error('data-driver: refused suspicious SQL in compileOutlierExamples');
	}
	return { text, values: where.values };
}

export function readOutlierCountsRow(row: Readonly<Record<string, unknown>> | undefined): { below: number; above: number } {
	const below = numericFromRaw(row?.['below_count'] ?? row?.['BELOW_COUNT'] ?? row?.['Below_count']) ?? 0;
	const above = numericFromRaw(row?.['above_count'] ?? row?.['ABOVE_COUNT'] ?? row?.['Above_count']) ?? 0;
	return { below, above };
}

export function readOutlierExampleRows(
	rows: readonly Readonly<Record<string, unknown>>[],
): { value: number; side: 'below' | 'above' }[] {
	const out: { value: number; side: 'below' | 'above' }[] = [];
	for (const r of rows) {
		const v = numericFromRaw(r['value'] ?? r['VALUE'] ?? r['Value']);
		const side = String(r['side'] ?? r['SIDE'] ?? r['Side'] ?? '');
		if (v === null) continue;
		if (side !== 'below' && side !== 'above') continue;
		out.push({ value: v, side });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Driver-side orchestrators: thin wrappers around the compile helpers
// each driver wires through its own row-runner. Keeps every driver's
// histogram() / correlationMatrix() / outliers() impl one line of glue.
// ---------------------------------------------------------------------------

function buildOrchestratorOptions(deps: OrchestratorDeps): { asTableExpr?: string; paramStartIndex?: number } {
	const out: { asTableExpr?: string; paramStartIndex?: number } = {};
	if (deps.asTableExpr !== undefined) out.asTableExpr = deps.asTableExpr;
	if (deps.paramStartIndex !== undefined) out.paramStartIndex = deps.paramStartIndex;
	return out;
}

export interface OrchestratorDeps {
	readonly target: string;
	readonly knownColumns: readonly string[];
	readonly dialect: Dialect;
	readonly aggregate: (req: AggregateRequest) => Promise<AggregateResult>;
	readonly runRows: (sql: string, values: readonly unknown[]) => Promise<readonly Readonly<Record<string, unknown>>[]>;
	readonly asTableExpr?: string;
	readonly paramStartIndex?: number;
}

export async function executeHistogram(
	request: HistogramRequest,
	deps: OrchestratorDeps,
): Promise<HistogramResult> {
	const buckets = clampHistogramBuckets(request.buckets);
	const mode: HistogramMode = request.mode ?? 'equal-width';

	const boundsResult = await deps.aggregate(histogramBoundsRequest(request));
	const lower = boundsResult.values[`${request.column}__min`] ?? null;
	const upper = boundsResult.values[`${request.column}__max`] ?? null;
	const nonNullCount = boundsResult.values[`${request.column}__count_non_null`] ?? 0;
	const totalCount = boundsResult.values['*__count'] ?? nonNullCount;
	const nullCount = Math.max(0, totalCount - nonNullCount);

	if (lower === null || upper === null || nonNullCount === 0) {
		return {
			target: deps.target, column: request.column, mode,
			bounds: { lower, upper },
			buckets: [],
			nonNullCount, nullCount,
		};
	}

	const compiled = compileHistogramBuckets(
		deps.target, { ...request, buckets }, lower, upper, deps.knownColumns, deps.dialect,
		buildOrchestratorOptions(deps),
	);
	const rows = await deps.runRows(compiled.text, compiled.values);
	const out = readHistogramRows(rows, lower, upper, buckets, mode);
	return {
		target: deps.target, column: request.column, mode,
		bounds: { lower, upper },
		buckets: out,
		nonNullCount, nullCount,
	};
}

export async function executeCorrelationMatrix(
	request: CorrelationMatrixRequest,
	deps: OrchestratorDeps,
): Promise<CorrelationMatrixResult> {
	const method: CorrelationMethod = request.method ?? 'pearson';
	const compiled = compileCorrelationMatrix(
		deps.target, request, deps.knownColumns, deps.dialect,
		buildOrchestratorOptions(deps),
	);
	const rows = await deps.runRows(compiled.text, compiled.values);
	const row = rows[0];
	const { matrix, nonNullCount } = readCorrelationRow(row, compiled.keys, compiled.pairs, compiled.nKey, request.columns.length);
	return {
		target: deps.target,
		columns: request.columns,
		method,
		nonNullCount,
		matrix,
	};
}

export async function executeOutliers(
	request: OutlierRequest,
	deps: OrchestratorDeps,
): Promise<OutlierResult> {
	const threshold = outlierThreshold(request);
	const boundsResult = await deps.aggregate(outlierBoundsRequest(request));
	const v = boundsResult.values;
	const nonNullCount = v[`${request.column}__count_non_null`] ?? 0;

	let center: number | null;
	let spread: number | null;
	let lower: number | null;
	let upper: number | null;
	if (request.method === 'iqr') {
		const q1 = v[`${request.column}__percentile_0_25`] ?? null;
		const q2 = v[`${request.column}__percentile_0_5`] ?? null;
		const q3 = v[`${request.column}__percentile_0_75`] ?? null;
		center = q2;
		spread = q1 !== null && q3 !== null ? q3 - q1 : null;
		if (q1 !== null && q3 !== null && spread !== null) {
			lower = q1 - threshold * spread;
			upper = q3 + threshold * spread;
		} else { lower = null; upper = null; }
	} else {
		const mean = v[`${request.column}__avg`] ?? null;
		const sd = v[`${request.column}__stddev`] ?? null;
		center = mean;
		spread = sd;
		if (mean !== null && sd !== null && sd > 0) {
			lower = mean - threshold * sd;
			upper = mean + threshold * sd;
		} else { lower = null; upper = null; }
	}

	if (lower === null || upper === null || nonNullCount === 0) {
		return {
			target: deps.target, column: request.column, method: request.method, threshold,
			nonNullCount, lowerBound: lower, upperBound: upper,
			belowCount: 0, aboveCount: 0, outlierCount: 0,
			center, spread, examples: [],
		};
	}

	const countsCompiled = compileOutlierCounts(
		deps.target, request, lower, upper, deps.knownColumns, deps.dialect,
		buildOrchestratorOptions(deps),
	);
	const exCompiled = compileOutlierExamples(
		deps.target, request, lower, upper, deps.knownColumns, deps.dialect,
		buildOrchestratorOptions(deps),
	);

	const [countRows, exRows] = await Promise.all([
		deps.runRows(countsCompiled.text, countsCompiled.values),
		deps.runRows(exCompiled.text, exCompiled.values),
	]);
	const counts = readOutlierCountsRow(countRows[0]);
	const examples = readOutlierExampleRows(exRows);

	return {
		target: deps.target, column: request.column, method: request.method, threshold,
		nonNullCount,
		lowerBound: lower, upperBound: upper,
		belowCount: counts.below, aboveCount: counts.above,
		outlierCount: counts.below + counts.above,
		center, spread,
		examples,
	};
}

// ---------------------------------------------------------------------------
// Wall-clock timeout wrapper
// ---------------------------------------------------------------------------

/**
 * Races `op` against a timeout. On timeout, attempts `onTimeout()`
 * to abort the underlying client call cleanly.
 */
export async function withTimeout<T>(
	op: Promise<T>,
	timeoutMs: number,
	onTimeout?: () => void,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			if (onTimeout !== undefined) {
				try { onTimeout(); } catch { /* best-effort */ }
			}
			reject(new Error(`data-driver: query timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	try {
		return await Promise.race([op, timeout]);
	} finally {
		if (timer !== undefined) { clearTimeout(timer); }
	}
}
