/**
 * JSON driver (kind: `json`).
 *
 * Dual-mode:
 *   - Root is an array-of-objects -> rdbms-shape (describe + sample).
 *     Each element is a record; schema inferred from the first N.
 *   - Root is an object -> kv-shape (get returns the whole doc;
 *     sampleShape over its top-level fields).
 *
 * Unlike JSONL we have to read the whole file -- single JSON isn't
 * line-delimited. Target size is therefore smaller: a sample is a
 * JSON.parse + filter. No streaming parser in phase 1.
 */

import { readFile } from 'node:fs/promises';

import { getLogger } from '../../../shared/logger.js';
import type {
	ColumnDescription,
	ConnectionConfig,
	FileDriver,
	KvValue,
	SampleOpts,
	SampleResult,
	ScanOpts,
	SchemaDescription,
	ShapeReport,
} from '../../../shared/db-driver.js';
import { registerDriver } from '../registry.js';
import { inferShape } from './kv-common.js';
import {
	FILE_DESCRIBE_SAMPLE_ROWS,
	clampFileLimit,
	inferColumnTypes,
	rowMatchesWhere,
} from './file-common.js';

const log = getLogger('db-json');

type Mode = 'record-array' | 'single-doc';

interface LoadedJson {
	readonly mode: Mode;
	readonly records: readonly Readonly<Record<string, unknown>>[];
	readonly doc: unknown;
}

class JsonDriver implements FileDriver {
	readonly family = 'file' as const;
	readonly kind = 'json';

	private cache: LoadedJson | null = null;
	private schemaCache: SchemaDescription | null = null;

	constructor(readonly id: string, private readonly path: string) { }

	async describe(_target?: string): Promise<SchemaDescription> {
		if (this.schemaCache !== null) { return this.schemaCache; }
		const loaded = await this.load();
		if (loaded.mode !== 'record-array') {
			throw new Error(
				`data-driver: json '${this.path}' is a single document; ` +
				`use db.file.sample_shape / db.file.get instead of describe`,
			);
		}
		const sample = loaded.records.slice(0, FILE_DESCRIBE_SAMPLE_ROWS);
		const columnSet = new Set<string>();
		for (const r of sample) {
			for (const k of Object.keys(r)) { columnSet.add(k); }
		}
		const columnNames = Array.from(columnSet).sort();
		const types = inferColumnTypes(sample, columnNames);
		const columns: ColumnDescription[] = columnNames.map(name => ({
			name,
			type: types.get(name) ?? 'any',
			nullable: sample.some(r => r[name] === null || r[name] === undefined),
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
		const loaded = await this.load();
		const rows: Record<string, unknown>[] = [];
		for (const row of loaded.records) {
			if (rowMatchesWhere(row, where)) {
				rows.push(row as Record<string, unknown>);
				if (rows.length >= limit) { break; }
			}
		}
		log.debug({ path: this.path, out: rows.length }, 'json sample');
		return { target: this.path, columns: cols, rows, truncated: rows.length >= limit };
	}

	async get(path: string): Promise<KvValue> {
		const loaded = await this.load();
		if (path === '' || path === '/') {
			return { key: this.path, value: loaded.doc, type: classify(loaded.doc) };
		}
		const val = resolveJsonPointer(loaded.doc, path);
		return { key: path, value: val, type: classify(val) };
	}

	async sampleShape(opts: ScanOpts): Promise<ShapeReport> {
		const loaded = await this.load();
		if (loaded.mode === 'record-array') {
			return inferShape(loaded.records.slice(0, opts.limit));
		}
		return inferShape([loaded.doc]);
	}

	async close(): Promise<void> { /* nothing to release */ }

	// -------------------------------------------------------------------------

	private async load(): Promise<LoadedJson> {
		if (this.cache !== null) { return this.cache; }
		const text = await readFile(this.path, 'utf8');
		let doc: unknown;
		try { doc = JSON.parse(text); }
		catch (err) {
			throw new Error(
				`data-driver: '${this.path}' is not valid JSON: ${(err as Error).message}`,
			);
		}
		if (Array.isArray(doc) && doc.every(d => d !== null && typeof d === 'object' && !Array.isArray(d))) {
			this.cache = {
				mode: 'record-array',
				records: doc as Readonly<Record<string, unknown>>[],
				doc,
			};
		} else {
			this.cache = { mode: 'single-doc', records: [], doc };
		}
		return this.cache;
	}
}

// ---------------------------------------------------------------------------

function classify(v: unknown): KvValue['type'] {
	if (v === null || v === undefined) { return 'null'; }
	if (Array.isArray(v)) { return 'array'; }
	if (v instanceof Uint8Array) { return 'binary'; }
	switch (typeof v) {
		case 'string': return 'string';
		case 'number': return 'number';
		case 'boolean': return 'boolean';
		case 'object': return 'object';
		default: return 'string';
	}
}

/**
 * Minimal RFC 6901 JSON Pointer resolution. We only need it for
 * `db.file.get` on single-doc JSON; covers `/foo/bar/0` style
 * addresses.
 */
function resolveJsonPointer(doc: unknown, pointer: string): unknown {
	if (pointer === '') { return doc; }
	if (!pointer.startsWith('/')) {
		throw new Error(`data-driver: json pointer must start with '/': got '${pointer}'`);
	}
	const tokens = pointer.slice(1).split('/').map(t =>
		t.replace(/~1/g, '/').replace(/~0/g, '~'),
	);
	let cur: unknown = doc;
	for (const token of tokens) {
		if (cur === null || typeof cur !== 'object') {
			return undefined;
		}
		if (Array.isArray(cur)) {
			const idx = Number(token);
			if (!Number.isInteger(idx)) { return undefined; }
			cur = cur[idx];
		} else {
			cur = (cur as Record<string, unknown>)[token];
		}
	}
	return cur;
}

registerDriver({
	kind: 'json',
	family: 'file',
	factory: async (config: ConnectionConfig) => {
		if (config.path === undefined) {
			throw new Error(`data-driver: json connection '${config.id}' missing path`);
		}
		return new JsonDriver(config.id, config.path);
	},
});
