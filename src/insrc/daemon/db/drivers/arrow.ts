/**
 * Arrow / Feather driver (kind: `arrow`, `feather`).
 *
 * Apache Arrow IPC file + stream format. `apache-arrow` reads the
 * schema from the footer, so describe() is zero-cost; sample()
 * materializes up to N rows from the record batches.
 *
 * `.arrow` = IPC file format (v2 / v3), `.feather` = same format in
 * modern usage (v2). Old feather v1 files are rare; if someone hits
 * one we'll add a branch.
 */

import { readFile } from 'node:fs/promises';
import * as Arrow from 'apache-arrow';

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

const log = getLogger('db-arrow');

class ArrowDriver implements FileDriver {
	readonly family = 'file' as const;
	readonly kind: string;

	private tableCache: Arrow.Table | null = null;
	private schemaCache: SchemaDescription | null = null;

	constructor(
		readonly id: string,
		kind: 'arrow' | 'feather',
		private readonly path: string,
	) {
		this.kind = kind;
	}

	async describe(_target?: string): Promise<SchemaDescription> {
		if (this.schemaCache !== null) { return this.schemaCache; }
		const table = await this.load();
		const columns: ColumnDescription[] = table.schema.fields.map((f) => ({
			name: f.name,
			type: f.type.toString(),
			nullable: f.nullable,
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
		const table = await this.load();

		const rows: Record<string, unknown>[] = [];
		const n = table.numRows;
		for (let i = 0; i < n && rows.length < limit; i++) {
			const row = table.get(i);
			if (row === null) { continue; }
			const rec: Record<string, unknown> = {};
			for (const name of cols) {
				rec[name] = (row as { [k: string]: unknown })[name];
			}
			if (rowMatchesWhere(rec, where)) {
				rows.push(rec);
			}
		}
		log.debug({ path: this.path, out: rows.length }, 'arrow sample');
		return { target: this.path, columns: cols, rows, truncated: rows.length >= limit };
	}

	async close(): Promise<void> { this.tableCache = null; }

	// -------------------------------------------------------------------------

	private async load(): Promise<Arrow.Table> {
		if (this.tableCache !== null) { return this.tableCache; }
		const buf = await readFile(this.path);
		this.tableCache = Arrow.tableFromIPC(buf);
		return this.tableCache;
	}
}

// ---------------------------------------------------------------------------

function makeFactory(kind: 'arrow' | 'feather') {
	return async (config: ConnectionConfig) => {
		if (config.path === undefined) {
			throw new Error(`data-driver: ${kind} connection '${config.id}' missing path`);
		}
		return new ArrowDriver(config.id, kind, config.path);
	};
}

registerDriver({ kind: 'arrow',   family: 'file', factory: makeFactory('arrow') });
registerDriver({ kind: 'feather', family: 'file', factory: makeFactory('feather') });
