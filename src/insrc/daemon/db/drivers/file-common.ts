/**
 * Shared helpers for file-family drivers (CSV, TSV, JSONL, JSON,
 * Excel, Avro, Arrow, BSON, Parquet, fixed-width).
 *
 * Concerns here:
 *   - path resolution relative to the repo root; rejects paths that
 *     escape the repo unless the fs-access gate is granted (gate
 *     itself lands with the analyzer design's §7.3 wiring; for now
 *     we apply the unconditional in-repo rule).
 *   - limit / timeout clamping (reuses the RDBMS caps since file
 *     samples are row-shaped).
 *   - type inference for text-format row samples (CSV/TSV).
 */

import type { WhereClause } from '../../../shared/db-driver.js';

export const FILE_SAMPLE_LIMIT = 50;
export const FILE_SAMPLE_TIMEOUT_MS = 5_000;
export const FILE_DESCRIBE_SAMPLE_ROWS = 100;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export function clampFileLimit(n: number): number {
	return Math.min(Math.max(1, Math.floor(n)), FILE_SAMPLE_LIMIT);
}

// ---------------------------------------------------------------------------
// Type inference for text-format row samples
// ---------------------------------------------------------------------------

/**
 * Infer a single SQL-ish type per column from N sample rows.
 * Returns `'integer'` / `'number'` / `'boolean'` / `'string'` /
 * `'null'`; mixed columns fall back to `'string'`.
 */
export function inferColumnTypes(
	rows: readonly Readonly<Record<string, unknown>>[],
	columns: readonly string[],
): Map<string, string> {
	const acc = new Map<string, Set<string>>();
	for (const col of columns) { acc.set(col, new Set()); }

	for (const row of rows) {
		for (const col of columns) {
			const v = row[col];
			acc.get(col)!.add(guessScalarType(v));
		}
	}

	const out = new Map<string, string>();
	for (const [col, types] of acc) {
		types.delete('null'); // nullability tracked separately
		if (types.size === 0) { out.set(col, 'null'); continue; }
		if (types.size === 1) { out.set(col, types.values().next().value ?? 'string'); continue; }
		// 'integer' + 'number' collapse to 'number'.
		if (types.size === 2 && types.has('integer') && types.has('number')) {
			out.set(col, 'number');
			continue;
		}
		out.set(col, 'string');
	}
	return out;
}

function guessScalarType(v: unknown): string {
	if (v === null || v === undefined || v === '') { return 'null'; }
	if (typeof v === 'boolean') { return 'boolean'; }
	if (typeof v === 'number') { return Number.isInteger(v) ? 'integer' : 'number'; }
	if (typeof v !== 'string') { return typeof v; }
	if (/^-?\d+$/.test(v)) { return 'integer'; }
	if (/^-?\d*\.\d+$/.test(v) || /^-?\d+\.\d*$/.test(v)) { return 'number'; }
	if (v === 'true' || v === 'false') { return 'boolean'; }
	return 'string';
}

// ---------------------------------------------------------------------------
// WHERE evaluation (for file drivers -- we filter in-process)
// ---------------------------------------------------------------------------

/**
 * Evaluate a list of WhereClause objects against an in-memory row.
 * File drivers stream through rows and apply this per row; there is
 * no query engine. Column validation is the caller's responsibility
 * (we do it in the describe step before sample).
 */
export function rowMatchesWhere(
	row: Readonly<Record<string, unknown>>,
	clauses: readonly WhereClause[],
): boolean {
	for (const c of clauses) {
		const v = row[c.column];
		switch (c.op) {
			case '=':
				if (!looseEqual(v, c.value)) { return false; }
				break;
			case '!=':
				if (looseEqual(v, c.value)) { return false; }
				break;
			case 'is null':
				if (v !== null && v !== undefined && v !== '') { return false; }
				break;
			case 'in':
				if (!Array.isArray(c.value) || !c.value.some(x => looseEqual(v, x))) {
					return false;
				}
				break;
		}
	}
	return true;
}

function looseEqual(a: unknown, b: unknown): boolean {
	if (a === b) { return true; }
	// Text-file rows arrive as strings before type inference; the
	// LLM often supplies typed values ("limit": 42). Coerce for
	// comparison only.
	if (typeof a === 'string' && typeof b !== 'string') {
		return a === String(b);
	}
	if (typeof b === 'string' && typeof a !== 'string') {
		return String(a) === b;
	}
	return false;
}
