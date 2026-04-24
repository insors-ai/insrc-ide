/**
 * Fixed-width text driver (kind: `fixed-width`).
 *
 * Parses column-positioned text files (COBOL / mainframe exports /
 * banking formats). Requires a column spec in `options.columns`:
 *
 *   options: {
 *     columns: [
 *       { name: 'acct',   start: 0,  length: 10, type: 'string' },
 *       { name: 'amount', start: 10, length: 12, type: 'number' },
 *       { name: 'date',   start: 22, length: 8,  type: 'string' }
 *     ],
 *     encoding: 'utf8',      // optional; default utf8
 *     trim: true,            // optional; strip trailing whitespace
 *     skipFirstLine: false   // optional; true for files with a header
 *   }
 *
 * No in-band schema, so describe() just echoes the spec; sample()
 * streams + slices + converts.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

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
import { clampFileLimit, rowMatchesWhere } from './file-common.js';

const log = getLogger('db-fixed-width');

interface ColumnSpec {
	readonly name: string;
	readonly start: number;
	readonly length: number;
	readonly type: 'string' | 'integer' | 'number' | 'boolean';
}

interface FixedWidthOptions {
	readonly columns: readonly ColumnSpec[];
	readonly encoding: BufferEncoding;
	readonly trim: boolean;
	readonly skipFirstLine: boolean;
}

function readOptions(config: ConnectionConfig): FixedWidthOptions {
	const o = (config.options ?? {}) as Record<string, unknown>;
	const rawCols = o['columns'];
	if (!Array.isArray(rawCols) || rawCols.length === 0) {
		throw new Error(
			`data-driver: fixed-width connection '${config.id}' needs ` +
			`options.columns: { name, start, length, type }[]`,
		);
	}
	const columns: ColumnSpec[] = rawCols.map((c, i) => {
		if (
			c === null || typeof c !== 'object'
			|| typeof (c as ColumnSpec).name !== 'string'
			|| typeof (c as ColumnSpec).start !== 'number'
			|| typeof (c as ColumnSpec).length !== 'number'
			|| typeof (c as ColumnSpec).type !== 'string'
		) {
			throw new Error(
				`data-driver: fixed-width connection '${config.id}' column ${i} ` +
				`must be { name, start, length, type }`,
			);
		}
		const spec = c as ColumnSpec;
		if (!['string', 'integer', 'number', 'boolean'].includes(spec.type)) {
			throw new Error(
				`data-driver: fixed-width '${config.id}' column '${spec.name}' ` +
				`unknown type '${spec.type}'`,
			);
		}
		return spec;
	});
	return {
		columns,
		encoding: typeof o['encoding'] === 'string' ? (o['encoding'] as BufferEncoding) : 'utf8',
		trim: o['trim'] !== false,
		skipFirstLine: o['skipFirstLine'] === true,
	};
}

class FixedWidthDriver implements FileDriver {
	readonly family = 'file' as const;
	readonly kind = 'fixed-width';

	constructor(
		readonly id: string,
		private readonly path: string,
		private readonly options: FixedWidthOptions,
	) { }

	async describe(_target?: string): Promise<SchemaDescription> {
		const columns: ColumnDescription[] = this.options.columns.map(c => ({
			name: c.name,
			type: c.type,
			nullable: true,
		}));
		return { target: this.path, columns, source: 'introspect' };
	}

	async sample(_target: string | undefined, opts: SampleOpts): Promise<SampleResult> {
		const cols = this.options.columns.map(c => c.name);
		const where = opts.where ?? [];
		for (const w of where) {
			if (!cols.includes(w.column)) {
				throw new Error(`data-driver: unknown column '${w.column}' in where clause`);
			}
		}
		const limit = clampFileLimit(opts.limit);

		const rows: Record<string, unknown>[] = [];
		await new Promise<void>((resolvePromise, rejectPromise) => {
			const src = createReadStream(this.path, { encoding: this.options.encoding });
			const rl = createInterface({ input: src, crlfDelay: Infinity });
			let lineNo = 0;
			let done = false;
			rl.on('line', (line) => {
				if (done) { return; }
				lineNo++;
				if (this.options.skipFirstLine && lineNo === 1) { return; }
				const row = this.parseLine(line);
				if (rowMatchesWhere(row, where)) {
					rows.push(row);
					if (rows.length >= limit) {
						done = true;
						rl.close();
						src.destroy();
					}
				}
			});
			rl.once('close', () => { if (!done) { resolvePromise(); } });
			rl.once('error', rejectPromise);
			src.once('error', rejectPromise);
		});

		log.debug({ path: this.path, out: rows.length }, 'fixed-width sample');
		return { target: this.path, columns: cols, rows, truncated: rows.length >= limit };
	}

	async close(): Promise<void> { /* nothing to release */ }

	// -------------------------------------------------------------------------

	private parseLine(line: string): Record<string, unknown> {
		const row: Record<string, unknown> = {};
		for (const spec of this.options.columns) {
			let raw = line.slice(spec.start, spec.start + spec.length);
			if (this.options.trim) { raw = raw.trim(); }
			row[spec.name] = convert(raw, spec.type);
		}
		return row;
	}
}

function convert(raw: string, type: ColumnSpec['type']): unknown {
	if (raw === '') { return null; }
	switch (type) {
		case 'integer': {
			const n = Number.parseInt(raw, 10);
			return Number.isFinite(n) ? n : null;
		}
		case 'number': {
			const n = Number.parseFloat(raw);
			return Number.isFinite(n) ? n : null;
		}
		case 'boolean': return raw === 'Y' || raw === 'T' || raw === 'true' || raw === '1';
		case 'string':  return raw;
	}
}

// ---------------------------------------------------------------------------

registerDriver({
	kind: 'fixed-width',
	family: 'file',
	factory: async (config: ConnectionConfig) => {
		if (config.path === undefined) {
			throw new Error(`data-driver: fixed-width connection '${config.id}' missing path`);
		}
		return new FixedWidthDriver(config.id, config.path, readOptions(config));
	},
});
