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
	AggregateSpec,
	DistinctRequest,
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
	const text = `SELECT ${exprs.join(', ')} FROM ${quotedTarget}`;
	if (looksLikeMutation(text)) {
		throw new Error(`data-driver: refused suspicious SQL: ${text}`);
	}
	return { text, values: [], keys };
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
