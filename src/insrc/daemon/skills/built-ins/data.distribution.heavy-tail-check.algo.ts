/**
 * Shared math + IO contract for `data.distribution.heavy-tail-check.{rdbms,file}`
 * (Phase 5b.6 of plans/analyzers/data-analyzer-skills.md).
 *
 * Sample-based kurtosis verdict. Excess kurtosis (kurtosis - 3) is
 * the signal:
 *   excess >  +threshold  -> heavy-tailed (leptokurtic)
 *   excess <  -threshold  -> light-tailed (platykurtic)
 *   |excess| <= threshold -> mesokurtic
 */

interface AggregateSpec {
	readonly column: string;
	readonly function: string;
}

export const HEAVY_TAIL_SAMPLE_SIZE = 50;

export type HeavyTailVerdict = 'heavy-tailed' | 'light-tailed' | 'mesokurtic' | 'inconclusive';

export interface HeavyTailOutput {
	readonly target: string;
	readonly column: string;
	readonly sampleSize: number;
	readonly count: number | null;
	readonly mean: number | null;
	readonly stddev: number | null;
	readonly kurtosis: number | null;
	readonly excessKurtosis: number | null;
	readonly threshold: number;
	readonly verdict: HeavyTailVerdict;
	readonly interpretation: string;
}

export function clampHeavyTailThreshold(t: number | undefined): number {
	if (typeof t !== 'number' || !Number.isFinite(t)) return 1.0;
	return Math.min(Math.max(0.1, t), 10);
}

export function heavyTailAggregationsFor(column: string): AggregateSpec[] {
	return [
		{ column, function: 'count_non_null' },
		{ column, function: 'avg' },
		{ column, function: 'stddev' },
		{ column, function: 'kurtosis' },
	];
}

export function buildHeavyTailCheck(
	target: string,
	column: string,
	threshold: number,
	aggValues: Readonly<Record<string, number | string | null>>,
	sample: { columns: readonly string[]; rows: readonly Readonly<Record<string, unknown>>[] },
): HeavyTailOutput {
	const count = numericFromAgg(aggValues[`${column}__count_non_null`]);
	const mean = numericFromAgg(aggValues[`${column}__avg`]);
	const stddev = numericFromAgg(aggValues[`${column}__stddev`]);
	const serverKurtosis = numericFromAgg(aggValues[`${column}__kurtosis`]);

	// DuckDB returns excess kurtosis already; if it's present and the
	// row count clears the floor, use it directly instead of computing
	// sample kurtosis.
	if (serverKurtosis !== null && count !== null && count >= 50) {
		const excessKurtosis = serverKurtosis;
		const kurtosis = excessKurtosis + 3;
		let verdict: HeavyTailVerdict;
		let interpretation: string;
		if (excessKurtosis > threshold) {
			verdict = 'heavy-tailed';
			interpretation = `excess kurtosis ${excessKurtosis.toFixed(2)} > +${threshold}; heavier tails than normal (full-table)`;
		} else if (excessKurtosis < -threshold) {
			verdict = 'light-tailed';
			interpretation = `excess kurtosis ${excessKurtosis.toFixed(2)} < -${threshold}; lighter tails than normal (full-table)`;
		} else {
			verdict = 'mesokurtic';
			interpretation = `excess kurtosis ${excessKurtosis.toFixed(2)} within ±${threshold}; normal-shaped tails (full-table)`;
		}
		return {
			target, column,
			sampleSize: count,
			count, mean, stddev,
			kurtosis, excessKurtosis,
			threshold,
			verdict, interpretation,
		};
	}

	const values: number[] = [];
	if (sample.columns.includes(column)) {
		for (const row of sample.rows) {
			const raw = row[column];
			if (raw === null || raw === undefined) continue;
			const num = typeof raw === 'number' ? raw : Number(raw);
			if (Number.isFinite(num)) values.push(num);
		}
	}
	const n = values.length;

	let kurtosis: number | null = null;
	let excessKurtosis: number | null = null;
	let verdict: HeavyTailVerdict = 'inconclusive';
	let interpretation = '';

	if (n >= 4) {
		const sampleMean = values.reduce((a, b) => a + b, 0) / n;
		let m2 = 0, m4 = 0;
		for (const x of values) {
			const d = x - sampleMean;
			const d2 = d * d;
			m2 += d2;
			m4 += d2 * d2;
		}
		m2 /= n; m4 /= n;
		if (m2 > 0) {
			kurtosis = m4 / (m2 * m2);
			excessKurtosis = kurtosis - 3;
			if (n >= 50) {
				if (excessKurtosis > threshold) {
					verdict = 'heavy-tailed';
					interpretation = `excess kurtosis ${excessKurtosis.toFixed(2)} > +${threshold}; heavier tails than normal -- consider MAD over IQR / Z-score for outlier detection`;
				} else if (excessKurtosis < -threshold) {
					verdict = 'light-tailed';
					interpretation = `excess kurtosis ${excessKurtosis.toFixed(2)} < -${threshold}; lighter tails than normal (uniform-like)`;
				} else {
					verdict = 'mesokurtic';
					interpretation = `excess kurtosis ${excessKurtosis.toFixed(2)} within ±${threshold}; normal-shaped tails`;
				}
			} else {
				interpretation = `sample size n=${n} below the 50-row floor; verdict suppressed (kurtosis estimate too noisy)`;
			}
		} else {
			interpretation = 'sample is constant (variance = 0); kurtosis undefined';
		}
	} else {
		interpretation = `sample too small (n=${n}); need at least 4 non-null observations`;
	}

	return {
		target, column,
		sampleSize: n,
		count, mean, stddev,
		kurtosis, excessKurtosis,
		threshold,
		verdict, interpretation,
	};
}

export function emptyHeavyTailCheck(target: string, column: string, threshold: number): HeavyTailOutput {
	return {
		target, column,
		sampleSize: 0,
		count: null, mean: null, stddev: null,
		kurtosis: null, excessKurtosis: null,
		threshold,
		verdict: 'inconclusive', interpretation: '',
	};
}

function numericFromAgg(v: number | string | null | undefined): number | null {
	if (v === null || v === undefined) return null;
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

export const HEAVY_TAIL_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:         { type: 'string' },
		column:         { type: 'string' },
		sampleSize:     { type: 'number' },
		count:          { type: ['number', 'null'] },
		mean:           { type: ['number', 'null'] },
		stddev:         { type: ['number', 'null'] },
		kurtosis:       { type: ['number', 'null'] },
		excessKurtosis: { type: ['number', 'null'] },
		threshold:      { type: 'number' },
		verdict:        { type: 'string', enum: ['heavy-tailed', 'light-tailed', 'mesokurtic', 'inconclusive'] },
		interpretation: { type: 'string' },
	},
	required: ['target', 'column', 'sampleSize', 'count', 'mean', 'stddev',
	           'kurtosis', 'excessKurtosis', 'threshold', 'verdict', 'interpretation'],
	additionalProperties: false,
};
