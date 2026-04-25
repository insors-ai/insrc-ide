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

import type { SampleOpts, WhereClause } from '../../../shared/db-driver.js';

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
