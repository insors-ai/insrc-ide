/**
 * Shared math + IO contract for `data.distribution.normality-test.{rdbms,file}`
 * (Phase 5b.5 of plans/analyzers/data-analyzer-skills.md).
 *
 * Jarque-Bera test:
 *   JB = n/6 * (S^2 + (K - 3)^2 / 4)
 * follows chi-squared(2) under the null. Closed-form p-value
 * `exp(-JB / 2)` -- no external stats library needed.
 *
 * Skewness + kurtosis are now requested server-side (Phase 0.1.x
 * extension) when the dialect supports them; the skill falls back to
 * sample-based moments when the engine returns null (e.g. SQLite, or
 * when the column has fewer than n=4 non-null values). `momentSource`
 * records which path was used so the caller can distinguish
 * full-table from sample-derived results.
 */

interface AggregateSpec {
	readonly column: string;
	readonly function: string;
}

export const NORMALITY_TEST_SAMPLE_SIZE = 50;

export type NormalityVerdict = 'normal' | 'non-normal' | 'inconclusive';
export type MomentSource = 'sample' | 'server' | 'unknown';

export interface NormalityTestOutput {
	readonly target: string;
	readonly column: string;
	readonly sampleSize: number;
	readonly count: number | null;
	readonly mean: number | null;
	readonly stddev: number | null;
	readonly skewness: number | null;
	readonly kurtosis: number | null;
	readonly momentSource: MomentSource;
	readonly alpha: number;
	readonly jbStatistic: number | null;
	readonly pValue: number | null;
	readonly verdict: NormalityVerdict;
	readonly interpretation: string;
}

export function clampAlpha(a: number | undefined): number {
	if (typeof a !== 'number' || !Number.isFinite(a)) return 0.05;
	return Math.min(Math.max(0.001, a), 0.5);
}

export function normalityTestAggregationsFor(column: string): AggregateSpec[] {
	return [
		{ column, function: 'count_non_null' },
		{ column, function: 'avg' },
		{ column, function: 'stddev' },
		{ column, function: 'skewness' },
		{ column, function: 'kurtosis' },
	];
}

export function buildNormalityTest(
	target: string,
	column: string,
	alpha: number,
	aggValues: Readonly<Record<string, number | string | null>>,
	sample: { columns: readonly string[]; rows: readonly Readonly<Record<string, unknown>>[] },
): NormalityTestOutput {
	const count = numericFromAgg(aggValues[`${column}__count_non_null`]);
	const mean = numericFromAgg(aggValues[`${column}__avg`]);
	const stddev = numericFromAgg(aggValues[`${column}__stddev`]);
	// Phase 0.1.x: skewness + kurtosis come back from the engine on
	// dialects that support them (DuckDB native; others: null).
	const serverSkewness = numericFromAgg(aggValues[`${column}__skewness`]);
	const serverKurtosis = numericFromAgg(aggValues[`${column}__kurtosis`]);

	let skewness: number | null = null;
	let kurtosis: number | null = null;
	let jbStatistic: number | null = null;
	let pValue: number | null = null;
	let verdict: NormalityVerdict = 'inconclusive';
	let interpretation = '';
	let momentSource: MomentSource = 'unknown';

	// DuckDB returns excess kurtosis already; we add 3 to match the
	// Pearson-style kurtosis the rest of this module assumes.
	const serverKurtosisPearson = serverKurtosis !== null ? serverKurtosis + 3 : null;

	const haveServer = serverSkewness !== null && serverKurtosisPearson !== null
		&& count !== null && count >= 4 && stddev !== null && stddev > 0;

	if (haveServer) {
		skewness = serverSkewness;
		kurtosis = serverKurtosisPearson;
		momentSource = 'server';
		const n = count!;
		if (n >= 50) {
			jbStatistic = (n / 6) * (skewness! * skewness! + Math.pow(kurtosis! - 3, 2) / 4);
			pValue = Math.exp(-jbStatistic / 2);
			if (pValue >= alpha) {
				verdict = 'normal';
				interpretation = `JB statistic = ${jbStatistic.toFixed(2)}, p = ${pValue.toFixed(4)}; cannot reject normality at alpha=${alpha} (full-table moments)`;
			} else {
				verdict = 'non-normal';
				interpretation = describeShape(skewness!, kurtosis!, jbStatistic, pValue, alpha) + ' (full-table moments)';
			}
		} else {
			verdict = 'inconclusive';
			interpretation = `n=${n} below the 50-row floor for Jarque-Bera; moments computed but verdict suppressed`;
		}
		return {
			target, column,
			sampleSize: n,
			count, mean, stddev,
			skewness, kurtosis, momentSource,
			alpha, jbStatistic, pValue,
			verdict, interpretation,
		};
	}

	// Sample-based fallback: dialect doesn't support server-side
	// skewness/kurtosis (SQLite / older MySQL etc).
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

	if (n >= 4) {
		const sampleMean = values.reduce((a, b) => a + b, 0) / n;
		let m2 = 0, m3 = 0, m4 = 0;
		for (const x of values) {
			const d = x - sampleMean;
			const d2 = d * d;
			m2 += d2;
			m3 += d2 * d;
			m4 += d2 * d2;
		}
		m2 /= n; m3 /= n; m4 /= n;
		const sampleStddev = Math.sqrt(m2);
		if (sampleStddev > 0) {
			skewness = m3 / Math.pow(sampleStddev, 3);
			kurtosis = m4 / Math.pow(sampleStddev, 4);
			momentSource = 'sample';
			if (n >= 50) {
				jbStatistic = (n / 6) * (skewness * skewness + Math.pow(kurtosis - 3, 2) / 4);
				pValue = Math.exp(-jbStatistic / 2);
				if (pValue >= alpha) {
					verdict = 'normal';
					interpretation = `JB statistic = ${jbStatistic.toFixed(2)}, p = ${pValue.toFixed(4)}; cannot reject normality at alpha=${alpha}`;
				} else {
					verdict = 'non-normal';
					interpretation = describeShape(skewness, kurtosis, jbStatistic, pValue, alpha);
				}
			} else {
				verdict = 'inconclusive';
				interpretation = `sample size n=${n} below the 50-row floor for Jarque-Bera; moments computed but verdict suppressed`;
			}
		} else {
			interpretation = 'sample is constant (stddev = 0); normality undefined';
		}
	} else {
		interpretation = `sample too small (n=${n}); need at least 4 non-null observations`;
	}

	return {
		target, column,
		sampleSize: n,
		count, mean, stddev,
		skewness, kurtosis, momentSource,
		alpha, jbStatistic, pValue,
		verdict, interpretation,
	};
}

function numericFromAgg(v: number | string | null | undefined): number | null {
	if (v === null || v === undefined) return null;
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function describeShape(skewness: number, kurtosis: number, jb: number, p: number, alpha: number): string {
	const parts: string[] = [`JB statistic = ${jb.toFixed(2)}, p = ${p.toExponential(2)} (< alpha=${alpha})`];
	if (Math.abs(skewness) > 1) parts.push(skewness > 0 ? 'right-skewed (positive skew)' : 'left-skewed (negative skew)');
	else if (Math.abs(skewness) > 0.5) parts.push(skewness > 0 ? 'mildly right-skewed' : 'mildly left-skewed');
	const excessKurt = kurtosis - 3;
	if (excessKurt > 1) parts.push('heavy-tailed (leptokurtic)');
	else if (excessKurt < -1) parts.push('light-tailed (platykurtic)');
	return parts.join('; ');
}

export function emptyNormalityTest(target: string, column: string, alpha: number): NormalityTestOutput {
	return {
		target, column,
		sampleSize: 0,
		count: null, mean: null, stddev: null,
		skewness: null, kurtosis: null,
		momentSource: 'unknown',
		alpha, jbStatistic: null, pValue: null,
		verdict: 'inconclusive', interpretation: '',
	};
}

export const NORMALITY_TEST_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:         { type: 'string' },
		column:         { type: 'string' },
		sampleSize:     { type: 'number' },
		count:          { type: ['number', 'null'] },
		mean:           { type: ['number', 'null'] },
		stddev:         { type: ['number', 'null'] },
		skewness:       { type: ['number', 'null'] },
		kurtosis:       { type: ['number', 'null'] },
		momentSource:   { type: 'string', enum: ['sample', 'server', 'unknown'] },
		alpha:          { type: 'number' },
		jbStatistic:    { type: ['number', 'null'] },
		pValue:         { type: ['number', 'null'] },
		verdict:        { type: 'string', enum: ['normal', 'non-normal', 'inconclusive'] },
		interpretation: { type: 'string' },
	},
	required: ['target', 'column', 'sampleSize', 'count', 'mean', 'stddev',
	           'skewness', 'kurtosis', 'momentSource', 'alpha',
	           'jbStatistic', 'pValue', 'verdict', 'interpretation'],
	additionalProperties: false,
};
