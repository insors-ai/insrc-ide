/**
 * Shared math + IO contract for `data.distribution.outliers-zscore.{rdbms,file}`
 * (Phase 5b.3 of plans/analyzers/data-analyzer-skills.md).
 *
 * Z-score outlier detection: |x - mean| / stddev > threshold.
 * Parametric -- assumes roughly normal data; for skewed columns
 * prefer IQR (5b.2) or MAD (5b.4).
 *
 * Reuses the shared utilities from outliers-iqr.algo (sample
 * clamping, tool-error collection, type guards) so the 5b family
 * has one canonical home for the plumbing primitives.
 */

interface AggregateSpec {
	readonly column: string;
	readonly function: string;
}

export interface ZScoreExample {
	readonly value: number;
	readonly z: number;
}

export interface OutliersZScoreOutput {
	readonly target: string;
	readonly column: string;
	readonly threshold: number;
	readonly mean: number | null;
	readonly stddev: number | null;
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
	readonly examples: { readonly low: readonly ZScoreExample[]; readonly high: readonly ZScoreExample[] };
}

export const ZSCORE_DEFAULT_THRESHOLD = 3.0;

export function clampZScoreThreshold(t: number | undefined): number {
	if (typeof t !== 'number' || !Number.isFinite(t)) return ZSCORE_DEFAULT_THRESHOLD;
	return Math.min(Math.max(0.5, t), 10);
}

export function outliersZScoreAggregationsFor(column: string): AggregateSpec[] {
	return [
		{ column, function: 'count' },
		{ column, function: 'count_non_null' },
		{ column, function: 'min' },
		{ column, function: 'max' },
		{ column, function: 'avg' },
		{ column, function: 'stddev' },
	];
}

export function buildOutliersZScore(
	target: string,
	column: string,
	threshold: number,
	aggValues: Readonly<Record<string, number | null>>,
	sample: { columns: readonly string[]; rows: readonly Readonly<Record<string, unknown>>[] },
): OutliersZScoreOutput {
	const v = aggValues;
	const count = v[`${column}__count`] ?? null;
	const nonNullCount = v[`${column}__count_non_null`] ?? null;
	const min = v[`${column}__min`] ?? null;
	const max = v[`${column}__max`] ?? null;
	const mean = v[`${column}__avg`] ?? null;
	const stddev = v[`${column}__stddev`] ?? null;

	let lowerBound: number | null = null;
	let upperBound: number | null = null;
	let hasFullTableOutliers: boolean | null = null;
	if (mean !== null && stddev !== null && stddev > 0) {
		lowerBound = mean - threshold * stddev;
		upperBound = mean + threshold * stddev;
		if (min !== null && max !== null) {
			hasFullTableOutliers = min < lowerBound || max > upperBound;
		}
	}

	let sampleObserved = 0;
	let sampleOutlierCount = 0;
	const low: ZScoreExample[] = [];
	const high: ZScoreExample[] = [];
	if (sample.columns.includes(column) && mean !== null && stddev !== null && stddev > 0) {
		for (const row of sample.rows) {
			const raw = row[column];
			if (raw === null || raw === undefined) continue;
			const num = typeof raw === 'number' ? raw : Number(raw);
			if (!Number.isFinite(num)) continue;
			sampleObserved++;
			const z = (num - mean) / stddev;
			if (z < -threshold) {
				sampleOutlierCount++;
				if (low.length < 3) low.push({ value: num, z });
			} else if (z > threshold) {
				sampleOutlierCount++;
				if (high.length < 3) high.push({ value: num, z });
			}
		}
	}
	const sampleOutlierRate = sampleObserved > 0 ? sampleOutlierCount / sampleObserved : null;

	return {
		target, column, threshold,
		mean, stddev,
		lowerBound, upperBound,
		min, max,
		count, nonNullCount,
		hasFullTableOutliers,
		sampleSize: sampleObserved,
		sampleOutlierCount,
		sampleOutlierRate,
		examples: { low, high },
	};
}

export function emptyOutliersZScore(target: string, column: string, threshold: number): OutliersZScoreOutput {
	return {
		target, column, threshold,
		mean: null, stddev: null,
		lowerBound: null, upperBound: null,
		min: null, max: null,
		count: null, nonNullCount: null,
		hasFullTableOutliers: null,
		sampleSize: 0, sampleOutlierCount: 0, sampleOutlierRate: null,
		examples: { low: [], high: [] },
	};
}

const Z_EXAMPLE_SCHEMA = {
	type: 'object',
	properties: {
		value: { type: 'number' },
		z:     { type: 'number' },
	},
	required: ['value', 'z'],
	additionalProperties: false,
} as const;

export const OUTLIERS_ZSCORE_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:               { type: 'string' },
		column:               { type: 'string' },
		threshold:            { type: 'number' },
		mean:                 { type: ['number', 'null'] },
		stddev:               { type: ['number', 'null'] },
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
				low:  { type: 'array', items: Z_EXAMPLE_SCHEMA },
				high: { type: 'array', items: Z_EXAMPLE_SCHEMA },
			},
			required: ['low', 'high'],
			additionalProperties: false,
		},
	},
	required: ['target', 'column', 'threshold', 'mean', 'stddev', 'lowerBound', 'upperBound',
	           'min', 'max', 'count', 'nonNullCount', 'hasFullTableOutliers',
	           'sampleSize', 'sampleOutlierCount', 'sampleOutlierRate', 'examples'],
	additionalProperties: false,
};
