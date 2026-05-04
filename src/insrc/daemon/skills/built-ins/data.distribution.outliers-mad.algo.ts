/**
 * Shared math + IO contract for `data.distribution.outliers-mad.{rdbms,file}`
 * (Phase 5b.4 of plans/analyzers/data-analyzer-skills.md).
 *
 * Modified Z-score outlier detection via MAD (median absolute
 * deviation). Best-fit for heavy-tailed columns where Z-score and
 * IQR under-detect. Bounds: median ± threshold × MAD × (1/0.6745);
 * default threshold 3.5.
 *
 * Phase 0.1.x extension: MAD now requested server-side via the
 * `mad` aggregate (DuckDB native). Falls back to sample-based MAD
 * when the engine doesn't support it (madSource: 'sample').
 */

interface AggregateSpec {
	readonly column: string;
	readonly function: string;
	readonly args?: { readonly p?: number };
}

const MAD_TO_SIGMA = 1 / 0.6745;  // ~1.4826
const MOD_Z_FACTOR = 0.6745;

export interface MadExample {
	readonly value: number;
	readonly modifiedZ: number;
}

export interface OutliersMadOutput {
	readonly target: string;
	readonly column: string;
	readonly threshold: number;
	readonly median: number | null;
	readonly mad: number | null;
	readonly madSource: 'sample' | 'server' | 'unknown';
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
	readonly examples: { readonly low: readonly MadExample[]; readonly high: readonly MadExample[] };
}

export const MAD_DEFAULT_THRESHOLD = 3.5;

export function clampMadThreshold(t: number | undefined): number {
	if (typeof t !== 'number' || !Number.isFinite(t)) return MAD_DEFAULT_THRESHOLD;
	return Math.min(Math.max(0.5, t), 10);
}

export function outliersMadAggregationsFor(column: string): AggregateSpec[] {
	return [
		{ column, function: 'count' },
		{ column, function: 'count_non_null' },
		{ column, function: 'min' },
		{ column, function: 'max' },
		{ column, function: 'percentile', args: { p: 0.5 } },
		{ column, function: 'mad' },
	];
}

export function buildOutliersMad(
	target: string,
	column: string,
	threshold: number,
	aggValues: Readonly<Record<string, number | string | null>>,
	sample: { columns: readonly string[]; rows: readonly Readonly<Record<string, unknown>>[] },
): OutliersMadOutput {
	const count = numericFromAgg(aggValues[`${column}__count`]);
	const nonNullCount = numericFromAgg(aggValues[`${column}__count_non_null`]);
	const min = numericFromAgg(aggValues[`${column}__min`]);
	const max = numericFromAgg(aggValues[`${column}__max`]);
	const median = numericFromAgg(aggValues[`${column}__percentile_0_5`]);
	const serverMad = numericFromAgg(aggValues[`${column}__mad`]);

	const sampleValues: number[] = [];
	if (sample.columns.includes(column)) {
		for (const row of sample.rows) {
			const raw = row[column];
			if (raw === null || raw === undefined) continue;
			const num = typeof raw === 'number' ? raw : Number(raw);
			if (Number.isFinite(num)) sampleValues.push(num);
		}
	}

	let mad: number | null = null;
	let madSource: 'sample' | 'server' | 'unknown' = 'unknown';
	if (serverMad !== null) {
		mad = serverMad;
		madSource = 'server';
	} else if (median !== null && sampleValues.length > 0) {
		const deviations = sampleValues.map(x => Math.abs(x - median)).sort((a, b) => a - b);
		const mid = Math.floor(deviations.length / 2);
		mad = deviations.length % 2 === 0
			? (deviations[mid - 1]! + deviations[mid]!) / 2
			: deviations[mid]!;
		madSource = 'sample';
	}

	let lowerBound: number | null = null;
	let upperBound: number | null = null;
	let hasFullTableOutliers: boolean | null = null;
	if (median !== null && mad !== null && mad > 0) {
		const halfWidth = threshold * mad * MAD_TO_SIGMA;
		lowerBound = median - halfWidth;
		upperBound = median + halfWidth;
		if (min !== null && max !== null) {
			hasFullTableOutliers = min < lowerBound || max > upperBound;
		}
	}

	let sampleOutlierCount = 0;
	const low: MadExample[] = [];
	const high: MadExample[] = [];
	if (median !== null && mad !== null && mad > 0 && lowerBound !== null && upperBound !== null) {
		for (const num of sampleValues) {
			const modZ = MOD_Z_FACTOR * (num - median) / mad;
			if (num < lowerBound) {
				sampleOutlierCount++;
				if (low.length < 3) low.push({ value: num, modifiedZ: modZ });
			} else if (num > upperBound) {
				sampleOutlierCount++;
				if (high.length < 3) high.push({ value: num, modifiedZ: modZ });
			}
		}
	}
	const sampleSize = sampleValues.length;
	const sampleOutlierRate = sampleSize > 0 ? sampleOutlierCount / sampleSize : null;

	return {
		target, column, threshold,
		median, mad, madSource,
		lowerBound, upperBound,
		min, max,
		count, nonNullCount,
		hasFullTableOutliers,
		sampleSize, sampleOutlierCount, sampleOutlierRate,
		examples: { low, high },
	};
}

export function emptyOutliersMad(target: string, column: string, threshold: number): OutliersMadOutput {
	return {
		target, column, threshold,
		median: null, mad: null, madSource: 'unknown',
		lowerBound: null, upperBound: null,
		min: null, max: null,
		count: null, nonNullCount: null,
		hasFullTableOutliers: null,
		sampleSize: 0, sampleOutlierCount: 0, sampleOutlierRate: null,
		examples: { low: [], high: [] },
	};
}

function numericFromAgg(v: number | string | null | undefined): number | null {
	if (v === null || v === undefined) return null;
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

const MAD_EXAMPLE_SCHEMA = {
	type: 'object',
	properties: { value: { type: 'number' }, modifiedZ: { type: 'number' } },
	required: ['value', 'modifiedZ'],
	additionalProperties: false,
} as const;

export const OUTLIERS_MAD_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:               { type: 'string' },
		column:               { type: 'string' },
		threshold:            { type: 'number' },
		median:               { type: ['number', 'null'] },
		mad:                  { type: ['number', 'null'] },
		madSource:            { type: 'string', enum: ['sample', 'server', 'unknown'] },
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
				low:  { type: 'array', items: MAD_EXAMPLE_SCHEMA },
				high: { type: 'array', items: MAD_EXAMPLE_SCHEMA },
			},
			required: ['low', 'high'],
			additionalProperties: false,
		},
	},
	required: ['target', 'column', 'threshold', 'median', 'mad', 'madSource',
	           'lowerBound', 'upperBound', 'min', 'max', 'count', 'nonNullCount',
	           'hasFullTableOutliers', 'sampleSize', 'sampleOutlierCount',
	           'sampleOutlierRate', 'examples'],
	additionalProperties: false,
};
