/**
 * Excel driver (kind: `xlsx`).
 *
 * Each sheet in the workbook is a `target`. describe/sample require
 * the sheet name; `db.file.describe` without a target returns the
 * first sheet with a warning (phase 1 convention -- add
 * `list_targets` in phase 3).
 *
 * Streams via `exceljs`' worksheet reader so multi-sheet workbooks
 * don't read every sheet when only one is asked for.
 */

import ExcelJS from 'exceljs';

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

const log = getLogger('db-xlsx');

class XlsxDriver implements FileDriver {
	readonly family = 'file' as const;
	readonly kind = 'xlsx';

	private readonly schemaCache = new Map<string, SchemaDescription>();

	constructor(readonly id: string, private readonly path: string) { }

	async describe(target?: string): Promise<SchemaDescription> {
		const sheet = await this.resolveSheetName(target);
		const cached = this.schemaCache.get(sheet);
		if (cached !== undefined) { return cached; }

		const rows = await this.readSheet(sheet, FILE_DESCRIBE_SAMPLE_ROWS);
		if (rows.length === 0) {
			throw new Error(`data-driver: xlsx sheet '${sheet}' is empty`);
		}
		const columnSet = new Set<string>();
		for (const r of rows) { for (const k of Object.keys(r)) { columnSet.add(k); } }
		const names = Array.from(columnSet);
		const types = inferColumnTypes(rows, names);
		const columns: ColumnDescription[] = names.map(n => ({
			name: n,
			type: types.get(n) ?? 'any',
			nullable: rows.some(r => r[n] === null || r[n] === undefined || r[n] === ''),
		}));
		const schema: SchemaDescription = { target: sheet, columns, source: 'header' };
		this.schemaCache.set(sheet, schema);
		return schema;
	}

	async sample(target: string | undefined, opts: SampleOpts): Promise<SampleResult> {
		const sheet = await this.resolveSheetName(target);
		const schema = await this.describe(sheet);
		const cols = schema.columns.map(c => c.name);
		const where = opts.where ?? [];
		for (const w of where) {
			if (!cols.includes(w.column)) {
				throw new Error(`data-driver: unknown column '${w.column}' in where clause`);
			}
		}
		const limit = clampFileLimit(opts.limit);
		// ExcelJS' streaming reader can't filter mid-stream easily; we
		// read up to `limit + 1000` rows and filter in memory. The
		// 5s wall-clock envelope at the tool layer catches pathological
		// cases.
		const rows = await this.readSheet(sheet, limit + 1000);
		const out: Record<string, unknown>[] = [];
		for (const r of rows) {
			if (rowMatchesWhere(r, where)) {
				out.push(r);
				if (out.length >= limit) { break; }
			}
		}
		log.debug({ path: this.path, sheet, out: out.length }, 'xlsx sample');
		return { target: sheet, columns: cols, rows: out, truncated: out.length >= limit };
	}

	async close(): Promise<void> { /* no persistent resources */ }

	// -------------------------------------------------------------------------

	private async resolveSheetName(target?: string): Promise<string> {
		if (target !== undefined && target !== '') { return target; }
		const wb = new ExcelJS.Workbook();
		await wb.xlsx.readFile(this.path);
		const first = wb.worksheets[0];
		if (first === undefined) {
			throw new Error(`data-driver: xlsx '${this.path}' has no sheets`);
		}
		return first.name;
	}

	private async readSheet(
		sheetName: string,
		maxRows: number,
	): Promise<Record<string, unknown>[]> {
		const wb = new ExcelJS.Workbook();
		await wb.xlsx.readFile(this.path);
		const ws = wb.getWorksheet(sheetName);
		if (ws === undefined) {
			throw new Error(`data-driver: xlsx sheet '${sheetName}' not found in '${this.path}'`);
		}
		const out: Record<string, unknown>[] = [];
		let headers: string[] | null = null;
		ws.eachRow({ includeEmpty: false }, (row, _idx) => {
			if (out.length >= maxRows) { return; }
			const vals = row.values as unknown[];
			// row.values is 1-indexed; drop [0].
			const stripped = vals.slice(1);
			if (headers === null) {
				headers = stripped.map((v, i) => String(v ?? `col${i + 1}`));
				return;
			}
			const rec: Record<string, unknown> = {};
			for (let i = 0; i < headers.length; i++) {
				const key = headers[i] ?? `col${i + 1}`;
				rec[key] = stripped[i] ?? null;
			}
			out.push(rec);
		});
		return out;
	}
}

// ---------------------------------------------------------------------------

registerDriver({
	kind: 'xlsx',
	family: 'file',
	factory: async (config: ConnectionConfig) => {
		if (config.path === undefined) {
			throw new Error(`data-driver: xlsx connection '${config.id}' missing path`);
		}
		return new XlsxDriver(config.id, config.path);
	},
});
