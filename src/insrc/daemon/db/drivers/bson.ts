/**
 * BSON driver (kind: `bson`).
 *
 * Targets `mongodump` output: a length-prefixed stream of BSON
 * documents. describe() samples the first 100 docs and merges
 * observed fields; sample() streams + filters + limits.
 */

import { readFile } from 'node:fs/promises';
import { BSON, deserialize } from 'bson';

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

const log = getLogger('db-bson');

class BsonDriver implements FileDriver {
	readonly family = 'file' as const;
	readonly kind = 'bson';

	private schemaCache: SchemaDescription | null = null;

	constructor(readonly id: string, private readonly path: string) { }

	async describe(_target?: string): Promise<SchemaDescription> {
		if (this.schemaCache !== null) { return this.schemaCache; }
		const rows = await this.readDocs(FILE_DESCRIBE_SAMPLE_ROWS);
		if (rows.length === 0) {
			throw new Error(`data-driver: bson '${this.path}' has no documents`);
		}
		const columnSet = new Set<string>();
		for (const r of rows) { for (const k of Object.keys(r)) { columnSet.add(k); } }
		const names = Array.from(columnSet).sort();
		const types = inferColumnTypes(rows, names);
		const columns: ColumnDescription[] = names.map(n => ({
			name: n,
			type: types.get(n) ?? 'any',
			nullable: rows.some(r => r[n] === null || r[n] === undefined),
		}));
		this.schemaCache = { target: this.path, columns, source: 'header' };
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
		// The file is small enough in practice (mongodump shards by
		// collection); read fully, iterate.
		const all = await this.readDocs(Number.POSITIVE_INFINITY);
		for (const r of all) {
			if (rowMatchesWhere(r, where)) {
				rows.push(r);
				if (rows.length >= limit) { break; }
			}
		}
		log.debug({ path: this.path, out: rows.length }, 'bson sample');
		return {
			target: this.path,
			columns: cols,
			rows,
			truncated: rows.length >= limit,
			metadata: { samplingMethod: 'first' },
		};
	}

	async close(): Promise<void> { /* nothing to release */ }

	// -------------------------------------------------------------------------

	/**
	 * Iterate the length-prefixed document stream. Each document
	 * starts with a little-endian int32 byte length (inclusive of
	 * itself). `max` caps the iteration.
	 */
	private async readDocs(max: number): Promise<Record<string, unknown>[]> {
		const buf = await readFile(this.path);
		const out: Record<string, unknown>[] = [];
		let off = 0;
		while (off < buf.length && out.length < max) {
			if (off + 4 > buf.length) {
				throw new Error(`data-driver: bson '${this.path}' truncated at byte ${off}`);
			}
			const len = buf.readInt32LE(off);
			if (len < 5 || off + len > buf.length) {
				throw new Error(`data-driver: bson '${this.path}' invalid length ${len} at byte ${off}`);
			}
			const doc = deserialize(buf.subarray(off, off + len), { promoteLongs: true }) as Record<string, unknown>;
			out.push(doc);
			off += len;
		}
		return out;
	}
}

// Silence lint: BSON namespace import is retained for possible future
// extended-type configuration even though we only call deserialize.
void BSON;

// ---------------------------------------------------------------------------

registerDriver({
	kind: 'bson',
	family: 'file',
	factory: async (config: ConnectionConfig) => {
		if (config.path === undefined) {
			throw new Error(`data-driver: bson connection '${config.id}' missing path`);
		}
		return new BsonDriver(config.id, config.path);
	},
});
