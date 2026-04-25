/**
 * JSONL driver (kind: `jsonl`, `ndjson`).
 *
 * Each non-empty line is a JSON record. describe() samples the first
 * 100 records and merges the observed field types into a union
 * schema. sample() streams through the file applying the WHERE
 * predicate until it hits the limit; the full file is never loaded
 * into memory.
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
import {
	FILE_DESCRIBE_SAMPLE_ROWS,
	clampFileLimit,
	inferColumnTypes,
	rowMatchesWhere,
} from './file-common.js';

const log = getLogger('db-jsonl');

class JsonlDriver implements FileDriver {
	readonly family = 'file' as const;
	readonly kind: string;

	private schemaCache: SchemaDescription | null = null;

	constructor(
		readonly id: string,
		kind: 'jsonl' | 'ndjson',
		private readonly path: string,
	) {
		this.kind = kind;
	}

	async describe(_target?: string): Promise<SchemaDescription> {
		if (this.schemaCache !== null) { return this.schemaCache; }

		const rows = await this.readRows(FILE_DESCRIBE_SAMPLE_ROWS);
		if (rows.length === 0) {
			throw new Error(`data-driver: jsonl '${this.path}' has no records`);
		}
		const columnSet = new Set<string>();
		for (const r of rows) {
			for (const k of Object.keys(r)) { columnSet.add(k); }
		}
		const columnNames = Array.from(columnSet).sort();
		const types = inferColumnTypes(rows, columnNames);
		const columns: ColumnDescription[] = columnNames.map(name => ({
			name,
			type: types.get(name) ?? 'any',
			nullable: rows.some(r => r[name] === null || r[name] === undefined),
		}));

		this.schemaCache = { target: this.path, columns, source: 'inferred' };
		return this.schemaCache;
	}

	async sample(_target: string | undefined, opts: SampleOpts): Promise<SampleResult> {
		const schema = await this.describe();
		const cols = schema.columns.map(c => c.name);
		const where = opts.where ?? [];
		for (const w of where) {
			if (!cols.includes(w.column)) {
				throw new Error(`data-driver: unknown column '${w.column}' in where clause`);
			}
		}
		const limit = clampFileLimit(opts.limit);
		const rows: Record<string, unknown>[] = [];
		await this.streamRows((row) => {
			if (rowMatchesWhere(row, where)) {
				rows.push(row);
				return rows.length >= limit;
			}
			return false;
		});
		log.debug({ path: this.path, out: rows.length }, 'jsonl sample');
		return {
			target: this.path,
			columns: cols,
			rows,
			truncated: rows.length >= limit,
			metadata: { samplingMethod: 'first' },
		};
	}

	async close(): Promise<void> { /* no persistent resources */ }

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
			const src = createReadStream(this.path, { encoding: 'utf8' });
			const rl = createInterface({ input: src, crlfDelay: Infinity });
			let lineNo = 0;
			let done = false;

			rl.on('line', (line) => {
				if (done) { return; }
				lineNo++;
				const trimmed = line.trim();
				if (trimmed === '') { return; }
				let parsed: unknown;
				try { parsed = JSON.parse(trimmed); }
				catch (err) {
					done = true;
					rl.close();
					src.destroy();
					rejectPromise(new Error(
						`data-driver: invalid JSON on line ${lineNo}: ${(err as Error).message}`,
					));
					return;
				}
				if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
					// Skip non-object records; the schema is only meaningful
					// for object-shaped entries.
					return;
				}
				const stop = onRow(parsed as Record<string, unknown>);
				if (stop) {
					done = true;
					rl.close();
					src.destroy();
				}
			});
			rl.once('close', () => { if (!done) { resolvePromise(); } });
			rl.once('error', rejectPromise);
			src.once('error', rejectPromise);
		});
	}
}

// ---------------------------------------------------------------------------

function makeFactory(kind: 'jsonl' | 'ndjson') {
	return async (config: ConnectionConfig) => {
		if (config.path === undefined) {
			throw new Error(`data-driver: ${kind} connection '${config.id}' missing path`);
		}
		return new JsonlDriver(config.id, kind, config.path);
	};
}

registerDriver({ kind: 'jsonl',  family: 'file', factory: makeFactory('jsonl') });
registerDriver({ kind: 'ndjson', family: 'file', factory: makeFactory('ndjson') });
