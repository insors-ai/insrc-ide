/**
 * Shared math + IO contract for `data.quality.validity.{rdbms,file}`
 * (Phase 5d.3 of plans/analyzers/data-analyzer-skills.md).
 *
 * Two modes share one output shape:
 *
 *   - `source: 'sample'` (default) -- regex evaluated in JS over a 50-row
 *     sample. matchCount / mismatchCount / matchRate reflect the sample.
 *     Examples populated from the sample's matched / mismatched values.
 *
 *   - `source: 'full-table'` (Phase 5d.3 Gap 1) -- exact full-table
 *     match-rate via server-side `count_where` aggregates with the new
 *     `regex` / `not regex` WhereClause ops. matchCount / mismatchCount
 *     / matchRate reflect the entire non-null population. `examples`
 *     stays empty in this mode (the aggregate path doesn't return rows);
 *     callers needing examples either run a follow-up sample call or
 *     stay in `mode: 'sample'`.
 */

export type ValiditySource = 'sample' | 'full-table';

export interface QualityValidityOutput {
	readonly target: string;
	readonly column: string;
	readonly pattern: string;
	readonly sampleSize: number;
	readonly matchCount: number;
	readonly mismatchCount: number;
	readonly matchRate: number | null;
	readonly score: number | null;
	readonly examples: { readonly matched: readonly string[]; readonly mismatched: readonly string[] };
	readonly source: ValiditySource;
	/** Full-table mode: total rows (incl. nulls). null in sample mode. */
	readonly totalRows: number | null;
	/** Full-table mode: non-null row count. null in sample mode. */
	readonly nonNullCount: number | null;
}

export function clampValiditySample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 50;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

export function buildValidity(
	target: string,
	column: string,
	pattern: string,
	re: RegExp,
	sample: { columns: readonly string[]; rows: readonly Readonly<Record<string, unknown>>[] },
): { output: QualityValidityOutput; missingColumn: boolean } {
	if (!sample.columns.includes(column)) {
		return { output: emptyValidity(target, column, pattern), missingColumn: true };
	}
	let matchCount = 0;
	let mismatchCount = 0;
	const matched: string[] = [];
	const mismatched: string[] = [];
	for (const row of sample.rows) {
		const v = row[column];
		if (v === null || v === undefined) continue;
		const s = typeof v === 'string' ? v : String(v);
		if (re.test(s)) {
			matchCount++;
			if (matched.length < 3) matched.push(s);
		} else {
			mismatchCount++;
			if (mismatched.length < 3) mismatched.push(s);
		}
	}
	const total = matchCount + mismatchCount;
	const matchRate = total > 0 ? matchCount / total : null;
	return {
		output: {
			target, column, pattern,
			sampleSize: total, matchCount, mismatchCount,
			matchRate, score: matchRate,
			examples: { matched, mismatched },
			source: 'sample',
			totalRows: null, nonNullCount: null,
		},
		missingColumn: false,
	};
}

/**
 * Phase 5d.3 Gap 1 -- the three aggregations a `mode: 'full-table'`
 * call must request. Caller sends them through `db_*_aggregate` and
 * passes the resulting flat values map back via
 * `buildValidityFromAggregate`.
 */
export function validityAggregationsFor(column: string, pattern: string): readonly {
	readonly column: string;
	readonly function: string;
	readonly args?: { readonly predicate?: readonly { readonly column: string; readonly op: string; readonly value?: unknown }[] };
}[] {
	return [
		{ column, function: 'count' },
		{ column, function: 'count_non_null' },
		{
			column,
			function: 'count_where',
			args: { predicate: [{ column, op: 'regex', value: pattern }] },
		},
	];
}

export function buildValidityFromAggregate(
	target: string,
	column: string,
	pattern: string,
	values: Readonly<Record<string, number | string | null>>,
): QualityValidityOutput {
	const totalRows    = numericFromAgg(values[`${column}__count`]);
	const nonNullCount = numericFromAgg(values[`${column}__count_non_null`]);
	// The countWhereSignature in rdbms-common.ts strips non-alnum from
	// the op, so 'regex' stays 'regex' (no underscore). The key shape
	// is `<column>__count_where_<column>_<op>`.
	const matchKey  = `${column}__count_where_${column}_regex`;
	const matchCount = numericFromAgg(values[matchKey]);
	if (totalRows === null || nonNullCount === null || matchCount === null) {
		return {
			...emptyValidity(target, column, pattern),
			source: 'full-table',
			totalRows, nonNullCount,
		};
	}
	const mismatchCount = Math.max(0, nonNullCount - matchCount);
	const matchRate = nonNullCount > 0 ? matchCount / nonNullCount : null;
	return {
		target, column, pattern,
		sampleSize: 0, matchCount, mismatchCount,
		matchRate, score: matchRate,
		examples: { matched: [], mismatched: [] },
		source: 'full-table',
		totalRows, nonNullCount,
	};
}

function numericFromAgg(v: number | string | null | undefined): number | null {
	if (v === null || v === undefined) return null;
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

export function emptyValidity(target: string, column: string, pattern: string): QualityValidityOutput {
	return {
		target, column, pattern,
		sampleSize: 0, matchCount: 0, mismatchCount: 0,
		matchRate: null, score: null,
		examples: { matched: [], mismatched: [] },
		source: 'sample',
		totalRows: null, nonNullCount: null,
	};
}

export const VALIDITY_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:        { type: 'string' },
		column:        { type: 'string' },
		pattern:       { type: 'string' },
		sampleSize:    { type: 'number' },
		matchCount:    { type: 'number' },
		mismatchCount: { type: 'number' },
		matchRate:     { type: ['number', 'null'] },
		score:         { type: ['number', 'null'] },
		examples: {
			type: 'object',
			properties: {
				matched:    { type: 'array', items: { type: 'string' } },
				mismatched: { type: 'array', items: { type: 'string' } },
			},
			required: ['matched', 'mismatched'],
			additionalProperties: false,
		},
		source:       { type: 'string', enum: ['sample', 'full-table'] },
		totalRows:    { type: ['number', 'null'] },
		nonNullCount: { type: ['number', 'null'] },
	},
	required: ['target', 'column', 'pattern', 'sampleSize', 'matchCount', 'mismatchCount',
	           'matchRate', 'score', 'examples', 'source', 'totalRows', 'nonNullCount'],
	additionalProperties: false,
};

export interface AggregateResultRaw {
	readonly target: string;
	readonly values: Readonly<Record<string, number | null>>;
}

export function isAggregateResult(v: unknown): v is AggregateResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['values'] === 'object' && o['values'] !== null;
}
