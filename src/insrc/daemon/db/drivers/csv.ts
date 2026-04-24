/**
 * CSV + TSV driver (kinds: `csv`, `tsv`).
 *
 * Streams via `csv-parse`. Header row is required for column
 * names (no data.csv support without a header in phase 1). Schema
 * is inferred from the first `FILE_DESCRIBE_SAMPLE_ROWS` rows;
 * sample applies WHERE + limit in-process.
 *
 * Sample-time streaming stops early once limit is hit -- the whole
 * file is never loaded into memory.
 */

import { createReadStream, statSync } from 'node:fs';
import { parse } from 'csv-parse';

import { getLogger } from '../../../shared/logger.js';
import type {
	ColumnDescription,
	ConnectionConfig,
	FileDriver,
	SampleOpts,
	SampleResult,
	SchemaDescription,
} from '../../../shared/db-driver.js';
import { registerDriver } from '../registry.js';
import {
	FILE_DESCRIBE_SAMPLE_ROWS,
	clampFileLimit,
	inferColumnTypes,
	rowMatchesWhere,
} from './file-common.js';

const log = getLogger('db-csv');

interface CsvOptions {
	readonly delimiter: string;
	readonly header: boolean;
	readonly quote: string | false;
}

function readOptions(config: ConnectionConfig, defaultDelim: string): CsvOptions {
	const o = (config.options ?? {}) as Record<string, unknown>;
	return {
		delimiter: typeof o['delimiter'] === 'string' ? o['delimiter'] : defaultDelim,
		header: o['header'] === false ? false : true,
		quote: typeof o['quote'] === 'string' ? o['quote'] : '"',
	};
}

class CsvDriver implements FileDriver {
	readonly family = 'file' as const;
	readonly kind: string;

	private schemaCache: SchemaDescription | null = null;

	constructor(
		readonly id: string,
		kind: 'csv' | 'tsv',
		private readonly path: string,
		private readonly options: CsvOptions,
	) {
		this.kind = kind;
	}

	async describe(_target?: string): Promise<SchemaDescription> {
		if (this.schemaCache !== null) { return this.schemaCache; }

		const rows = await this.readRows(FILE_DESCRIBE_SAMPLE_ROWS);
		if (rows.length === 0) {
			throw new Error(`data-driver: csv '${this.path}' is empty`);
		}
		const first = rows[0] as Record<string, unknown>;
		const columnNames = Object.keys(first);
		const types = inferColumnTypes(rows, columnNames);

		const columns: ColumnDescription[] = columnNames.map((name) => ({
			name,
			type: types.get(name) ?? 'string',
			nullable: rows.some(r => {
				const v = r[name];
				return v === null || v === undefined || v === '';
			}),
		}));
		this.schemaCache = {
			target: this.path,
			columns,
			source: 'inferred',
		};
		return this.schemaCache;
	}

	async sample(_target: string | undefined, opts: SampleOpts): Promise<SampleResult> {
		const schema = await this.describe();
		const colNames = schema.columns.map(c => c.name);
		const limit = clampFileLimit(opts.limit);
		const where = opts.where ?? [];
		for (const w of where) {
			if (!colNames.includes(w.column)) {
				throw new Error(`data-driver: unknown column '${w.column}' in where clause`);
			}
		}

		const rows: Record<string, unknown>[] = [];
		await this.streamRows((row) => {
			if (rowMatchesWhere(row, where)) {
				rows.push(row);
				return rows.length >= limit;
			}
			return false;
		});

		log.debug({ path: this.path, out: rows.length }, 'csv sample');
		return {
			target: this.path,
			columns: colNames,
			rows,
			truncated: rows.length >= limit,
		};
	}

	async close(): Promise<void> { /* no persistent resources */ }

	// -------------------------------------------------------------------------
	// Internal streaming
	// -------------------------------------------------------------------------

	private async readRows(max: number): Promise<Record<string, unknown>[]> {
		const out: Record<string, unknown>[] = [];
		await this.streamRows((row) => {
			out.push(row);
			return out.length >= max;
		});
		return out;
	}

	private streamRows(
		onRow: (row: Record<string, unknown>) => boolean,
	): Promise<void> {
		return new Promise((resolvePromise, rejectPromise) => {
			const parser = parse({
				delimiter: this.options.delimiter,
				columns: this.options.header,
				skip_empty_lines: true,
				trim: true,
				quote: this.options.quote === false ? undefined : this.options.quote,
				relax_quotes: true,
			});
			const src = createReadStream(this.path);
			src.pipe(parser);

			parser.on('data', (row: Record<string, unknown>) => {
				const stop = onRow(row);
				if (stop) {
					parser.destroy();
					src.destroy();
				}
			});
			parser.once('end', resolvePromise);
			parser.once('close', resolvePromise);
			parser.once('error', rejectPromise);
			src.once('error', rejectPromise);
		});
	}
}

// ---------------------------------------------------------------------------
// Factory + registration
// ---------------------------------------------------------------------------

function makeFactory(kind: 'csv' | 'tsv', defaultDelim: string) {
	return async (config: ConnectionConfig) => {
		if (config.path === undefined) {
			throw new Error(`data-driver: ${kind} connection '${config.id}' missing path`);
		}
		// Pool has already resolved the path to absolute + verified the
		// file exists; stat() is a cheap way to catch the rare case
		// where it disappeared between pool build + factory call.
		statSync(config.path);
		const options = readOptions(config, defaultDelim);
		return new CsvDriver(config.id, kind, config.path, options);
	};
}

registerDriver({ kind: 'csv', family: 'file', factory: makeFactory('csv', ',') });
registerDriver({ kind: 'tsv', family: 'file', factory: makeFactory('tsv', '\t') });
