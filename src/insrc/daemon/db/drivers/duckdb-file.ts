/**
 * DuckDB-backed FileDriver -- one implementation for every file kind
 * DuckDB reads natively (csv / tsv / jsonl / ndjson / json / parquet
 * / arrow / feather). Replaces the bespoke per-format drivers per
 * plans/data-driver-duckdb-files.md Phase 1.
 *
 * Why a single driver:
 *   - One SQL surface. describe / sample / sampleShape / aggregate
 *     all flow through DuckDB SQL: `read_csv_auto`, `read_json_auto`,
 *     `read_parquet`, etc. No per-format aggregation code paths.
 *   - Streaming + projection pushdown. CSV / JSONL stream
 *     memory-bounded; Parquet projects only referenced columns.
 *   - DuckDB's analytical surface (percentiles, regr_*, kurtosis,
 *     mad, mode, entropy, window functions, approximate aggregates)
 *     becomes available to Family-5 skills for free.
 *
 * Path safety:
 *   - The driver pool resolves connection.path to absolute + verifies
 *     existence before this factory runs, so config.path arrives
 *     trusted (Phase 0.3).
 *   - File paths flow into DuckDB via `?` parameters, never string-
 *     interpolated. Reader options (delimiter, header, ...) are
 *     resolved from connection config and stitched into the reader-
 *     function call as literals, but only after passing the option-
 *     value validators below.
 *
 * No-go:
 *   - No `httpfs` / S3 / Azure path support (extension stays disabled
 *     in the pool init, Phase 0.4).
 *   - No raw SQL accepted from callers. Only structured WhereClause /
 *     AggregateRequest objects compile to SQL via the existing
 *     rdbms-common helpers.
 */

import { existsSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

import { getLogger } from '../../../shared/logger.js';
import type {
	AggregateRequest,
	AggregateResult,
	ColumnDescription,
	ConnectionConfig,
	FileDriver,
	SampleOpts,
	SampleResult,
	ScanOpts,
	SchemaDescription,
	ShapeReport,
} from '../../../shared/db-driver.js';
import { registerDriver } from '../registry.js';
import { withConnection } from '../duckdb-pool.js';
import { clampFileLimit } from './file-common.js';
import {
	POSTGRES_DIALECT,
	compileAggregateExprs,
	compileWhere,
	readAggregateRow,
} from './rdbms-common.js';
import { inferShape } from './shape-common.js';

const log = getLogger('db-duckdb-file');

// ---------------------------------------------------------------------------
// File kinds + reader-expression mapping
// ---------------------------------------------------------------------------

/** Kinds the DuckDB driver handles natively. avro / bson / fixed-width
 *  / xlsx come later via the converter path (Phase 2). */
export type DuckDBFileKind =
	| 'csv' | 'tsv'
	| 'jsonl' | 'ndjson'
	| 'json'
	| 'parquet'
	| 'arrow' | 'feather';

const NATIVE_KINDS: readonly DuckDBFileKind[] = [
	'csv', 'tsv', 'jsonl', 'ndjson', 'json', 'parquet', 'arrow', 'feather',
];

/**
 * Per-kind reader-function syntax. The `?` is a literal placeholder
 * for the path parameter; the rest is dialect-fixed. Caller is
 * responsible for stitching in already-validated reader options.
 *
 * `extraSql` lets the caller append already-validated options like
 * `, hive_partitioning=true` (per Phase 4.3) for directory-as-table
 * connections. The CSV `optionsSql` and Phase-4 directory options
 * compose by concatenation.
 */
function readerExpression(kind: DuckDBFileKind, optionsSql: string, extraSql = ''): string {
	switch (kind) {
		case 'csv':
			// `read_csv_auto` is the auto-detecting variant: it samples
			// rows to infer types, handles quoting, and respects the
			// header / delim options we splice in.
			return `read_csv_auto(?${optionsSql}${extraSql})`;
		case 'tsv':
			// TSV is just CSV with a tab delimiter; the connection's
			// options carry user overrides (header, quote).
			return `read_csv_auto(?, delim='\\t'${optionsSql}${extraSql})`;
		case 'jsonl':
		case 'ndjson':
			// `read_json_auto` with `format='newline_delimited'` reads
			// one JSON value per line.
			return `read_json_auto(?, format='newline_delimited'${extraSql})`;
		case 'json':
			// Single-doc / array-of-docs; DuckDB auto-detects the shape.
			return `read_json_auto(?${extraSql})`;
		case 'parquet':
			return `read_parquet(?${extraSql})`;
		case 'arrow':
		case 'feather':
			// `arrow` extension provides `read_arrow`. Best-effort: when
			// the extension is unavailable (offline / 404), the engine
			// surfaces a clean "function does not exist" error which the
			// tool layer renders as success: false.
			return `read_arrow(?${extraSql})`;
	}
}

// ---------------------------------------------------------------------------
// Directory glob assembly (Phase 4.4 of plans/data-driver-duckdb-files.md)
// ---------------------------------------------------------------------------

/** File-extension glob pattern per kind, used when path is a directory. */
function globExtensionFor(kind: DuckDBFileKind): string {
	switch (kind) {
		case 'csv':     return '*.csv';
		case 'tsv':     return '*.tsv';
		case 'jsonl':   return '*.jsonl';
		case 'ndjson':  return '*.ndjson';
		case 'json':    return '*.json';
		case 'parquet': return '*.parquet';
		case 'arrow':   return '*.arrow';
		case 'feather': return '*.feather';
	}
}

/**
 * Resolve the path argument to feed into `read_xxx(?)`. For a
 * single-file connection: just the absolute path. For a directory
 * connection: a glob string DuckDB's readers accept directly
 * (`/path/*.csv` or `/path/**\/*.csv` when recursive). DuckDB walks
 * the tree itself; the driver doesn't pre-enumerate files.
 */
function resolveReaderPath(
	kind: DuckDBFileKind,
	rootPath: string,
	isDirectory: boolean,
	recursive: boolean,
): string {
	if (!isDirectory) return rootPath;
	const ext = globExtensionFor(kind);
	const middle = recursive ? `**${sep}${ext}` : ext;
	return join(rootPath, middle);
}

// ---------------------------------------------------------------------------
// Reader-option assembly (CSV / TSV)
// ---------------------------------------------------------------------------

interface ResolvedCsvOptions {
	readonly delimiter: string | undefined;
	readonly header: boolean | undefined;
	readonly quote: string | undefined | false;
}

/**
 * Pull CSV/TSV options off the connection config + validate. Anything
 * outside the allowed shape is rejected here so the SQL we splice
 * stays trustworthy. Strings are checked against a strict allow-list
 * (single character, no SQL meta) -- DuckDB's options are
 * positional / named-arg syntax that doesn't take parameter binds.
 */
function resolveCsvOptions(config: ConnectionConfig): ResolvedCsvOptions {
	const o = (config.options ?? {}) as Record<string, unknown>;
	let delimiter: string | undefined;
	if (typeof o['delimiter'] === 'string') {
		const d = o['delimiter'];
		if (d.length === 0 || d.length > 2) {
			throw new Error(`data-driver: csv delimiter must be 1-2 chars, got '${d}'`);
		}
		// Block quote / backslash to keep the SQL splice trivial; one
		// or two visible ASCII characters covers every real-world case.
		if (/['"\\]/.test(d)) {
			throw new Error(`data-driver: csv delimiter '${d}' contains an unsupported character`);
		}
		delimiter = d;
	}
	let header: boolean | undefined;
	if (typeof o['header'] === 'boolean') header = o['header'];
	let quote: string | undefined | false;
	if (typeof o['quote'] === 'string') {
		const q = o['quote'];
		if (q.length !== 1 || /[\\]/.test(q)) {
			throw new Error(`data-driver: csv quote must be a single non-backslash char`);
		}
		quote = q;
	} else if (o['quote'] === false) {
		quote = false;
	}
	return { delimiter, header, quote };
}

/** Build the comma-prefixed `, opt=val` suffix to splice after the
 *  path parameter in `read_csv_auto(?, ...)`. Only emits options the
 *  user explicitly set; DuckDB's defaults handle the rest. */
function csvOptionsSql(opts: ResolvedCsvOptions): string {
	const parts: string[] = [];
	if (opts.delimiter !== undefined) parts.push(`delim='${opts.delimiter}'`);
	if (opts.header !== undefined) parts.push(`header=${opts.header}`);
	if (opts.quote === false) {
		parts.push(`quote=''`);
	} else if (opts.quote !== undefined) {
		parts.push(`quote='${opts.quote}'`);
	}
	return parts.length === 0 ? '' : `, ${parts.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Driver class
// ---------------------------------------------------------------------------

class DuckDBFileDriver implements FileDriver {
	readonly family = 'file' as const;
	readonly kind: DuckDBFileKind;

	private schemaCache: SchemaDescription | null = null;

	constructor(
		readonly id: string,
		kind: DuckDBFileKind,
		private readonly path: string,
		private readonly csvOpts: ResolvedCsvOptions,
		private readonly isDirectory: boolean,
		private readonly recursive: boolean,
		private readonly hivePartitioning: boolean,
	) {
		this.kind = kind;
	}

	// ---------------------------------------------------------------------------
	// FileDriver methods
	// ---------------------------------------------------------------------------

	async describe(_target?: string): Promise<SchemaDescription> {
		if (this.schemaCache !== null) return this.schemaCache;

		const expr = this.readerExpr();
		const sql = `DESCRIBE SELECT * FROM ${expr}`;
		log.debug({ id: this.id, sql }, 'describe');

		const readPath = this.readerPath();
		const rows = await withConnection(async (conn) => {
			const reader = await conn.runAndReadAll(sql, [readPath]);
			return reader.getRowObjects();
		});
		if (rows.length === 0) {
			throw new Error(`data-driver: ${this.kind} '${readPath}' has no columns`);
		}

		const columns: ColumnDescription[] = rows.map(r => ({
			name: String(r['column_name']),
			type: String(r['column_type']),
			// DuckDB DESCRIBE's `null` column is `'YES'` / `'NO'`;
			// older versions surface a boolean.
			nullable: r['null'] === 'YES' || r['null'] === true,
		}));
		this.schemaCache = {
			target: this.path,
			columns,
			source: this.kind === 'parquet' || this.kind === 'arrow' || this.kind === 'feather'
				? 'header'
				: 'inferred',
		};
		return this.schemaCache;
	}

	async sample(_target: string | undefined, opts: SampleOpts): Promise<SampleResult> {
		const schema = await this.describe();
		const cols = schema.columns.map(c => c.name);
		const limit = clampFileLimit(opts.limit);
		const expr = this.readerExpr();

		// WHERE compiled via the same compileWhere helper RDBMS drivers
		// use -- structured clauses, parametrised values, column names
		// validated against the schema. The path parameter is bound at
		// position 1; subsequent `?`s are the WHERE values.
		const where = compileWhere(opts.where ?? [], cols, POSTGRES_DIALECT, 2);
		const whereText = where.text === '' ? '' : ` ${where.text}`;
		const sql = `SELECT * FROM ${expr}${whereText} LIMIT ${limit}`;
		log.debug({ id: this.id, sql }, 'sample');

		const params = [this.readerPath(), ...where.values];
		const rows = await withConnection(async (conn) => {
			const reader = await conn.runAndReadAll(sql, params as never[]);
			return reader.getRowObjects();
		});

		return {
			target: this.path,
			columns: cols,
			rows,
			truncated: rows.length >= limit,
			metadata: { samplingMethod: 'first' },
		};
	}

	async sampleShape(opts: ScanOpts): Promise<ShapeReport> {
		// Nested-shape inference doesn't have a clean DuckDB native --
		// `JSON_STRUCTURE` aggregates can describe one row's shape but
		// merging across rows is what shape-common.ts already does.
		// So: pull a sample via DuckDB (fast streaming), run the
		// existing inferShape over the materialised rows.
		const limit = Math.min(Math.max(1, opts.limit), 1000);
		const expr = this.readerExpr();
		const sql = `SELECT * FROM ${expr} LIMIT ${limit}`;
		const rows = await withConnection(async (conn) => {
			const reader = await conn.runAndReadAll(sql, [this.readerPath()]);
			return reader.getRowObjects() as readonly unknown[];
		});
		return inferShape(rows);
	}

	async aggregate(_target: string | undefined, request: AggregateRequest): Promise<AggregateResult> {
		const schema = await this.describe();
		const cols = schema.columns.map(c => c.name);
		const { exprs, keys } = compileAggregateExprs(request, cols, POSTGRES_DIALECT);
		const expr = this.readerExpr();
		const sql = `SELECT ${exprs.join(', ')} FROM ${expr}`;
		log.debug({ id: this.id, sql }, 'aggregate');

		const row = await withConnection(async (conn) => {
			const reader = await conn.runAndReadAll(sql, [this.readerPath()]);
			return reader.getRowObjects()[0] as Readonly<Record<string, unknown>> | undefined;
		});
		return { target: this.path, values: readAggregateRow(row, keys) };
	}

	async close(): Promise<void> {
		// The DuckDB instance is daemon-wide and outlives every driver;
		// per-driver close is a no-op.
	}

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	/** SQL `read_xxx(?, ...)` expression. The `?` binds to the
	 *  caller-provided path / glob from `readerPath()`. */
	private readerExpr(): string {
		const optsSql = (this.kind === 'csv' || this.kind === 'tsv')
			? csvOptionsSql(this.csvOpts)
			: '';
		const extra = this.hivePartitioning ? `, hive_partitioning=true` : '';
		return readerExpression(this.kind, optsSql, extra);
	}

	/** Path / glob to bind as the reader's first parameter. */
	private readerPath(): string {
		return resolveReaderPath(this.kind, this.path, this.isDirectory, this.recursive);
	}
}

// ---------------------------------------------------------------------------
// Factory + registration
// ---------------------------------------------------------------------------

function makeFactory(kind: DuckDBFileKind) {
	return async (config: ConnectionConfig) => {
		if (config.path === undefined) {
			throw new Error(`data-driver: ${kind} connection '${config.id}' missing path`);
		}
		if (!existsSync(config.path)) {
			throw new Error(`data-driver: ${kind} '${config.path}' does not exist`);
		}
		// Phase 4.1 -- a connection's path may be a single file or a
		// directory. Stat tells us which; downstream logic switches
		// between absolute path and DuckDB-glob accordingly.
		const stat = statSync(config.path);
		const isDirectory = stat.isDirectory();
		const recursive = config.recursive === true && isDirectory;
		const hivePartitioning = config.partitioning === 'hive' && isDirectory;

		const csvOpts = (kind === 'csv' || kind === 'tsv')
			? resolveCsvOptions(config)
			: { delimiter: undefined, header: undefined, quote: undefined };
		return new DuckDBFileDriver(
			config.id, kind, config.path, csvOpts,
			isDirectory, recursive, hivePartitioning,
		);
	};
}

/** Register the DuckDB-backed driver for every native file kind.
 *  Idempotent: re-importing this module is harmless (the registry
 *  warns + replaces). Modules importing the bespoke per-format
 *  drivers earlier in the boot sequence are overridden when this
 *  module's import lands -- intentional, since we're consolidating.
 */
export function registerDuckDBFileDriver(): void {
	for (const kind of NATIVE_KINDS) {
		registerDriver({ kind, family: 'file', factory: makeFactory(kind) });
	}
}

// Self-register on import (matches the convention every other driver
// module follows). The driver pool's lazy DuckDB init means no DuckDB
// work happens until the first describe / sample / etc. call -- the
// import is cheap.
registerDuckDBFileDriver();
