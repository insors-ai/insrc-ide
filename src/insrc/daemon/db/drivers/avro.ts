/**
 * Avro driver (kind: `avro`).
 *
 * Avro OCF (Object Container File). Schema lives in the header, so
 * describe() is zero-cost -- no row sample needed. sample() streams
 * records via `avsc.createFileDecoder` and applies WHERE in-process.
 *
 * The header schema maps onto our ColumnDescription shape for
 * record-typed top-level schemas. Non-record top-level schemas
 * (rare in practice) are rejected in phase 1.
 */

import avsc from 'avsc';

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

const log = getLogger('db-avro');

class AvroDriver implements FileDriver {
	readonly family = 'file' as const;
	readonly kind = 'avro';

	private schemaCache: SchemaDescription | null = null;

	constructor(readonly id: string, private readonly path: string) { }

	async describe(_target?: string): Promise<SchemaDescription> {
		if (this.schemaCache !== null) { return this.schemaCache; }
		const headerType = await this.loadHeaderType();
		if (headerType.typeName !== 'record') {
			throw new Error(
				`data-driver: avro '${this.path}' top-level schema is not a record ` +
				`(got ${headerType.typeName})`,
			);
		}
		const fields = (headerType as unknown as { fields: { name: string; type: avsc.Type }[] }).fields;
		const columns: ColumnDescription[] = fields.map((f) => ({
			name: f.name,
			type: avroTypeName(f.type),
			nullable: isNullableType(f.type),
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
		await new Promise<void>((resolvePromise, rejectPromise) => {
			const decoder = avsc.createFileDecoder(this.path);
			decoder.on('data', (record: Record<string, unknown>) => {
				if (rowMatchesWhere(record, where)) {
					rows.push(record);
					if (rows.length >= limit) {
						decoder.destroy();
					}
				}
			});
			decoder.once('end', resolvePromise);
			decoder.once('close', resolvePromise);
			decoder.once('error', rejectPromise);
		});

		log.debug({ path: this.path, out: rows.length }, 'avro sample');
		return { target: this.path, columns: cols, rows, truncated: rows.length >= limit };
	}

	async close(): Promise<void> { /* no persistent resources */ }

	// -------------------------------------------------------------------------

	private loadHeaderType(): Promise<avsc.Type> {
		return new Promise((resolvePromise, rejectPromise) => {
			const decoder = avsc.createFileDecoder(this.path);
			decoder.once('metadata', (type: avsc.Type) => {
				decoder.destroy();
				resolvePromise(type);
			});
			decoder.once('error', rejectPromise);
		});
	}
}

// ---------------------------------------------------------------------------

function avroTypeName(t: avsc.Type): string {
	// avsc exposes `typeName` ('record' / 'string' / 'long' / 'union' / ...)
	// Unions serialize as `["null","string"]` etc.; report the non-null
	// branch when it collapses to one. Duck-type the `.types` array
	// since avsc exports WrappedUnionType / UnwrappedUnionType as
	// separate classes.
	const branches = (t as { types?: avsc.Type[] }).types;
	if (Array.isArray(branches)) {
		const nonNull = branches.filter(b => b.typeName !== 'null');
		if (nonNull.length === 1) { return nonNull[0]!.typeName; }
		return nonNull.map(b => b.typeName).join('|');
	}
	return t.typeName;
}

function isNullableType(t: avsc.Type): boolean {
	const branches = (t as { types?: avsc.Type[] }).types;
	if (Array.isArray(branches)) {
		return branches.some(b => b.typeName === 'null');
	}
	return t.typeName === 'null';
}

// ---------------------------------------------------------------------------

registerDriver({
	kind: 'avro',
	family: 'file',
	factory: async (config: ConnectionConfig) => {
		if (config.path === undefined) {
			throw new Error(`data-driver: avro connection '${config.id}' missing path`);
		}
		return new AvroDriver(config.id, config.path);
	},
});
