/**
 * Parquet driver (kind: `parquet`).
 *
 * Columnar storage; schema lives in the file footer. Uses
 * `parquetjs-lite` for read-only access (no Parquet writes from
 * the data driver -- ever).
 *
 * describe() reads the footer once + maps the Parquet schema onto
 * our SchemaDescription. sample() walks records via the cursor
 * + applies WHERE in process. Both pay only the footer-read cost
 * up front; record bodies stream on demand.
 *
 * No type definitions ship with parquetjs-lite, so the API surface
 * is wrapped behind a small `ParquetReader` shape.
 */

import { ParquetReader } from 'parquetjs-lite';

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

const log = getLogger('db-parquet');

class ParquetDriver implements FileDriver {
	readonly family = 'file' as const;
	readonly kind = 'parquet';

	private schemaCache: SchemaDescription | null = null;

	constructor(readonly id: string, private readonly path: string) { }

	async describe(_target?: string): Promise<SchemaDescription> {
		if (this.schemaCache !== null) { return this.schemaCache; }
		const reader = await ParquetReader.openFile(this.path);
		try {
			const schema = reader.getSchema();
			const columns: ColumnDescription[] = Object.entries(schema.fields).map(([name, f]) => ({
				name,
				type: f.type ?? 'unknown',
				nullable: f.optional === true || f.repeated === true,
			}));
			this.schemaCache = { target: this.path, columns, source: 'header' };
			return this.schemaCache;
		} finally {
			await reader.close();
		}
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

		const reader = await ParquetReader.openFile(this.path);
		const rows: Record<string, unknown>[] = [];
		try {
			const cursor = reader.getCursor();
			while (rows.length < limit) {
				const record = await cursor.next();
				if (record === null) { break; }
				if (rowMatchesWhere(record, where)) {
					rows.push(record);
				}
			}
		} finally {
			await reader.close();
		}
		log.debug({ path: this.path, out: rows.length }, 'parquet sample');
		return { target: this.path, columns: cols, rows, truncated: rows.length >= limit };
	}

	async close(): Promise<void> { /* no persistent resources */ }
}

// ---------------------------------------------------------------------------

registerDriver({
	kind: 'parquet',
	family: 'file',
	factory: async (config: ConnectionConfig) => {
		if (config.path === undefined) {
			throw new Error(`data-driver: parquet connection '${config.id}' missing path`);
		}
		return new ParquetDriver(config.id, config.path);
	},
});
