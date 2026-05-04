/**
 * Shared math + IO contract for `data.distribution.outliers-iqr.{rdbms,file}`
 * (Phase 5b.2 of plans/analyzers/data-analyzer-skills.md).
 *
 * Tukey-IQR outlier detection. Both wrappers ask the engine for
 * count + non-null + min + max + p25 + p75 (one round-trip), then
 * pull a 50-row sample for outlier examples + an estimated rate.
 * The math (bounds derivation, sample partitioning) lives here; the
 * wrappers just bridge transports.
 */

interface AggregateSpec {
	readonly column: string;
	readonly function: string;
	readonly args?: { readonly p?: number };
}

export type OutliersSource = 'sample' | 'full-table';

export interface OutliersIqrOutput {
	readonly target: string;
	readonly column: string;
	readonly k: number;
	readonly q1: number | null;
	readonly q3: number | null;
	readonly iqr: number | null;
	readonly lowerBound: number | null;
	readonly upperBound: number | null;
	readonly min: number | null;
	readonly max: number | null;
	readonly count: number | null;
	readonly nonNullCount: number | null;
	readonly hasFullTableOutliers: boolean | null;
	readonly sampleSize: number;
	readonly sampleOutlierCount: number;
	readonly sampleOutlierRate: number | null;
	readonly examples: { readonly low: readonly number[]; readonly high: readonly number[] };
	readonly source: OutliersSource;
	readonly fullTableBelowCount: number | null;
	readonly fullTableAboveCount: number | null;
	readonly fullTableOutlierCount: number | null;
	readonly fullTableOutlierRate: number | null;
}

export const OUTLIERS_IQR_DEFAULT_K = 1.5;
export const OUTLIERS_IQR_DEFAULT_SAMPLE = 50;

export function clampIqrMultiplier(k: number | undefined): number {
	if (typeof k !== 'number' || !Number.isFinite(k)) return OUTLIERS_IQR_DEFAULT_K;
	return Math.min(Math.max(0.1, k), 10);
}

export function clampSampleSize(n: number | undefined, max = 50): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return max;
	return Math.min(Math.max(1, Math.floor(n)), max);
}

export function outliersIqrAggregationsFor(column: string): AggregateSpec[] {
	return [
		{ column, function: 'count' },
		{ column, function: 'count_non_null' },
		{ column, function: 'min' },
		{ column, function: 'max' },
		{ column, function: 'percentile', args: { p: 0.25 } },
		{ column, function: 'percentile', args: { p: 0.75 } },
	];
}

export function buildOutliersIqr(
	target: string,
	column: string,
	k: number,
	aggValues: Readonly<Record<string, number | string | null>>,
	sample: { columns: readonly string[]; rows: readonly Readonly<Record<string, unknown>>[] },
): OutliersIqrOutput {
	const count = numericFromAgg(aggValues[`${column}__count`]);
	const nonNullCount = numericFromAgg(aggValues[`${column}__count_non_null`]);
	const min = numericFromAgg(aggValues[`${column}__min`]);
	const max = numericFromAgg(aggValues[`${column}__max`]);
	const q1  = numericFromAgg(aggValues[`${column}__percentile_0_25`]);
	const q3  = numericFromAgg(aggValues[`${column}__percentile_0_75`]);

	let iqr: number | null = null;
	let lowerBound: number | null = null;
	let upperBound: number | null = null;
	let hasFullTableOutliers: boolean | null = null;
	if (q1 !== null && q3 !== null) {
		iqr = q3 - q1;
		lowerBound = q1 - k * iqr;
		upperBound = q3 + k * iqr;
		if (min !== null && max !== null) {
			hasFullTableOutliers = min < lowerBound || max > upperBound;
		}
	}

	let sampleObserved = 0;
	let sampleOutlierCount = 0;
	const low: number[] = [];
	const high: number[] = [];
	if (sample.columns.includes(column) && lowerBound !== null && upperBound !== null) {
		for (const row of sample.rows) {
			const raw = row[column];
			if (raw === null || raw === undefined) continue;
			const num = typeof raw === 'number' ? raw : Number(raw);
			if (!Number.isFinite(num)) continue;
			sampleObserved++;
			if (num < lowerBound) {
				sampleOutlierCount++;
				if (low.length < 3) low.push(num);
			} else if (num > upperBound) {
				sampleOutlierCount++;
				if (high.length < 3) high.push(num);
			}
		}
	}
	const sampleOutlierRate = sampleObserved > 0 ? sampleOutlierCount / sampleObserved : null;

	return {
		target, column, k,
		q1, q3, iqr,
		lowerBound, upperBound,
		min, max,
		count, nonNullCount,
		hasFullTableOutliers,
		sampleSize: sampleObserved,
		sampleOutlierCount,
		sampleOutlierRate,
		examples: { low, high },
		source: 'sample',
		fullTableBelowCount: null,
		fullTableAboveCount: null,
		fullTableOutlierCount: null,
		fullTableOutlierRate: null,
	};
}

interface FullTableOutlierInput {
	readonly target: string;
	readonly column: string;
	readonly threshold: number;
	readonly nonNullCount: number;
	readonly lowerBound: number | null;
	readonly upperBound: number | null;
	readonly belowCount: number;
	readonly aboveCount: number;
	readonly center: number | null;
	readonly spread: number | null;
	readonly examples: readonly { readonly value: number; readonly side: 'below' | 'above' }[];
}

/**
 * Build an OutliersIqrOutput from a `db_sql_outliers` tool result.
 * Drops the sample-based fields (set to 0/null) and populates the
 * fullTable* fields with precise counts.
 */
export function buildOutliersIqrFromOutlierTool(o: FullTableOutlierInput): OutliersIqrOutput {
	const total = o.belowCount + o.aboveCount;
	const rate = o.nonNullCount > 0 ? total / o.nonNullCount : null;
	const low = o.examples.filter(e => e.side === 'below').slice(0, 3).map(e => e.value);
	const high = o.examples.filter(e => e.side === 'above').slice(0, 3).map(e => e.value);
	// IQR semantics: center=median, spread=iqr.
	return {
		target: o.target, column: o.column, k: o.threshold,
		q1: null, q3: null, iqr: o.spread,
		lowerBound: o.lowerBound, upperBound: o.upperBound,
		min: null, max: null,
		count: o.nonNullCount, nonNullCount: o.nonNullCount,
		hasFullTableOutliers: total > 0,
		sampleSize: 0, sampleOutlierCount: 0, sampleOutlierRate: null,
		examples: { low, high },
		source: 'full-table',
		fullTableBelowCount: o.belowCount,
		fullTableAboveCount: o.aboveCount,
		fullTableOutlierCount: total,
		fullTableOutlierRate: rate,
	};
}

export function emptyOutliersIqr(target: string, column: string, k: number): OutliersIqrOutput {
	return {
		target, column, k,
		q1: null, q3: null, iqr: null,
		lowerBound: null, upperBound: null,
		min: null, max: null,
		count: null, nonNullCount: null,
		hasFullTableOutliers: null,
		sampleSize: 0, sampleOutlierCount: 0, sampleOutlierRate: null,
		examples: { low: [], high: [] },
		source: 'sample',
		fullTableBelowCount: null, fullTableAboveCount: null,
		fullTableOutlierCount: null, fullTableOutlierRate: null,
	};
}

function numericFromAgg(v: number | string | null | undefined): number | null {
	if (v === null || v === undefined) return null;
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

export const OUTLIERS_IQR_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:               { type: 'string' },
		column:               { type: 'string' },
		k:                    { type: 'number' },
		q1:                   { type: ['number', 'null'] },
		q3:                   { type: ['number', 'null'] },
		iqr:                  { type: ['number', 'null'] },
		lowerBound:           { type: ['number', 'null'] },
		upperBound:           { type: ['number', 'null'] },
		min:                  { type: ['number', 'null'] },
		max:                  { type: ['number', 'null'] },
		count:                { type: ['number', 'null'] },
		nonNullCount:         { type: ['number', 'null'] },
		hasFullTableOutliers: { type: ['boolean', 'null'] },
		sampleSize:           { type: 'number' },
		sampleOutlierCount:   { type: 'number' },
		sampleOutlierRate:    { type: ['number', 'null'] },
		examples: {
			type: 'object',
			properties: {
				low:  { type: 'array', items: { type: 'number' } },
				high: { type: 'array', items: { type: 'number' } },
			},
			required: ['low', 'high'],
			additionalProperties: false,
		},
		source:                { type: 'string', enum: ['sample', 'full-table'] },
		fullTableBelowCount:   { type: ['number', 'null'] },
		fullTableAboveCount:   { type: ['number', 'null'] },
		fullTableOutlierCount: { type: ['number', 'null'] },
		fullTableOutlierRate:  { type: ['number', 'null'] },
	},
	required: ['target', 'column', 'k', 'q1', 'q3', 'iqr', 'lowerBound', 'upperBound',
	           'min', 'max', 'count', 'nonNullCount', 'hasFullTableOutliers',
	           'sampleSize', 'sampleOutlierCount', 'sampleOutlierRate', 'examples',
	           'source', 'fullTableBelowCount', 'fullTableAboveCount',
	           'fullTableOutlierCount', 'fullTableOutlierRate'],
	additionalProperties: false,
};

export interface AggregateResultRaw {
	readonly target: string;
	readonly values: Readonly<Record<string, number | null>>;
}

export interface SampleResultRaw {
	readonly target: string;
	readonly columns: readonly string[];
	readonly rows: readonly Readonly<Record<string, unknown>>[];
}

export function isAggregateResult(v: unknown): v is AggregateResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && typeof o['values'] === 'object' && o['values'] !== null;
}

export function isSampleResult(v: unknown): v is SampleResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& Array.isArray(o['columns'])
		&& Array.isArray(o['rows']);
}

export function collectToolErrors(
	pairs: readonly (readonly [string, { isError?: boolean; content?: string }])[],
): string[] {
	const out: string[] = [];
	for (const [name, res] of pairs) {
		if (res.isError === true) out.push(`${name} error: ${(res.content ?? '').slice(0, 200)}`);
	}
	return out;
}
