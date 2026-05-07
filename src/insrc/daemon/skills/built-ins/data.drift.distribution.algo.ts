/**
 * Shared math + IO contract for `data.drift.distribution.{rdbms,file}`
 * (Phase 5f.1 of plans/analyzers/data-analyzer-skills.md).
 *
 * Jensen-Shannon divergence between two windows of one numeric column.
 * Symmetric (D(A,B) == D(B,A)), bounded (0..log(2)), and well-defined
 * when one distribution has zero mass in a bin where the other has
 * positive mass. KL divergence (per-direction) is reported alongside
 * for familiarity.
 *
 * Two modes share one output shape:
 *
 *   - `source: 'sample'` (default) -- both windows pull a 50-row sample;
 *     histograms + JS computed in JS over those samples. Sample-based
 *     verdict; sampleSize fields populated.
 *
 *   - `source: 'full-table'` -- 4 server-side aggregate round-trips:
 *     parallel min/max/count_non_null per window, then parallel bucket
 *     count_where aggregates per window (N count_where specs each, one
 *     per shared-range bucket). The skill derives joint min/max from
 *     the per-window bounds, builds shared bucket edges, then issues
 *     the bucket queries. Histogram + JS run client-side on the
 *     server-derived bucket counts -- exact for the entire population,
 *     not estimated from a sample.
 *
 * Verdict ladder uses normalized JS (jsDivergence / log(2), so 0 =
 * identical, 1 = maximally divergent):
 *   <  0.05 -> identical
 *   <  0.20 -> similar
 *   <  0.50 -> shifted
 *   >= 0.50 -> divergent
 */

import type { SkillToolResult } from '../types.js';

export const DRIFT_SAMPLE_DEFAULT = 50;
export const DRIFT_BINS_DEFAULT = 10;
const LOG2 = Math.log(2);

export type DriftSource = 'sample' | 'full-table';

/**
 * Window-filter clause shape accepted by the skill. Mirrors the
 * comparison + null + IN ops on the parent WhereClause -- enough to
 * express time-windowing (`>=` / `<` / `between`) and category
 * filtering (`= / != / in`) without exposing regex / like which are
 * irrelevant for windowing.
 */
export interface DriftWhereClauseIn {
	readonly column: string;
	readonly op: '=' | '!=' | 'in' | 'is null' | 'is not null'
	           | '<' | '<=' | '>' | '>=' | 'between';
	readonly value?: unknown;
}

export interface WindowStats {
	readonly sampleSize: number;
	readonly min: number | null;
	readonly max: number | null;
	readonly mean: number | null;
}

export type DriftVerdict = 'identical' | 'similar' | 'shifted' | 'divergent' | 'inconclusive';

export interface DriftDistributionOutput {
	readonly target: string;
	readonly column: string;
	readonly windowA: WindowStats;
	readonly windowB: WindowStats;
	readonly sharedRange: { lower: number | null; upper: number | null };
	readonly bins: number;
	readonly jsDivergence: number | null;
	readonly normalizedJs: number | null;
	readonly klAFromB: number | null;
	readonly klBFromA: number | null;
	readonly verdict: DriftVerdict;
	readonly interpretation: string;
	readonly source: DriftSource;
}

export function clampDriftSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return DRIFT_SAMPLE_DEFAULT;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

export function clampDriftBins(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return DRIFT_BINS_DEFAULT;
	return Math.min(Math.max(4, Math.floor(n)), 50);
}

export function emptyDrift(target: string, column: string, bins: number, source: DriftSource = 'sample'): DriftDistributionOutput {
	const empty: WindowStats = { sampleSize: 0, min: null, max: null, mean: null };
	return {
		target, column,
		windowA: empty,
		windowB: empty,
		sharedRange: { lower: null, upper: null },
		bins,
		jsDivergence: null, normalizedJs: null,
		klAFromB: null, klBFromA: null,
		verdict: 'inconclusive',
		interpretation: '',
		source,
	};
}

export function collectToolErrors(pairs: readonly (readonly [string, SkillToolResult])[]): string[] {
	const out: string[] = [];
	for (const [name, res] of pairs) {
		if (res.isError) out.push(`${name} error: ${res.content.slice(0, 200)}`);
	}
	return out;
}

interface SampleLike {
	readonly target: string;
	readonly columns: readonly string[];
	readonly rows: readonly Readonly<Record<string, unknown>>[];
}

export function isSampleLike(v: unknown): v is SampleLike {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& Array.isArray(o['columns'])
		&& Array.isArray(o['rows']);
}

export function extractNumbers(sample: SampleLike, col: string): number[] {
	if (!sample.columns.includes(col)) return [];
	const out: number[] = [];
	for (const row of sample.rows) {
		const raw = row[col];
		if (raw === null || raw === undefined) continue;
		const num = typeof raw === 'number' ? raw : Number(raw);
		if (Number.isFinite(num)) out.push(num);
	}
	return out;
}

export function describeWindow(values: readonly number[]): WindowStats {
	if (values.length === 0) return { sampleSize: 0, min: null, max: null, mean: null };
	let mn = values[0]!, mx = values[0]!, sum = 0;
	for (const v of values) {
		if (v < mn) mn = v;
		if (v > mx) mx = v;
		sum += v;
	}
	return { sampleSize: values.length, min: mn, max: mx, mean: sum / values.length };
}

export interface BuiltDrift {
	readonly output: DriftDistributionOutput;
	readonly notes: readonly string[];
	readonly degradedConfidence: 'medium' | null;
}

export function buildDrift(
	target: string,
	column: string,
	aValues: readonly number[],
	bValues: readonly number[],
	binCount: number,
): BuiltDrift {
	const aStats = describeWindow(aValues);
	const bStats = describeWindow(bValues);

	if (aValues.length < 4 || bValues.length < 4) {
		return {
			output: { ...emptyDrift(target, column, binCount), windowA: aStats, windowB: bStats },
			notes: [`drift-distribution: insufficient data (window A n=${aValues.length}, window B n=${bValues.length}); need >= 4 in each`],
			degradedConfidence: 'medium',
		};
	}

	const lo = Math.min(...aValues, ...bValues);
	const hi = Math.max(...aValues, ...bValues);
	if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
		return {
			output: {
				...emptyDrift(target, column, binCount),
				windowA: aStats, windowB: bStats,
				sharedRange: { lower: lo, upper: hi },
			},
			notes: ['drift-distribution: union range is degenerate (constant column or single-point sample)'],
			degradedConfidence: 'medium',
		};
	}

	const aBins = histogram(aValues, lo, hi, binCount);
	const bBins = histogram(bValues, lo, hi, binCount);
	return assembleDriftFromBins(target, column, aStats, bStats, lo, hi, aBins, bBins, binCount, 'sample');
}

/**
 * Phase 5f.1 Track-C -- full-table mode: inputs are server-derived
 * per-window stats + per-bucket counts. Produces the same output
 * shape as the sample mode with `source: 'full-table'`.
 */
export function buildDriftFromBucketCounts(
	target: string,
	column: string,
	aStats: WindowStats,
	bStats: WindowStats,
	sharedLo: number | null,
	sharedHi: number | null,
	aBucketCounts: readonly number[],
	bBucketCounts: readonly number[],
	binCount: number,
): BuiltDrift {
	const aTotal = aStats.sampleSize;
	const bTotal = bStats.sampleSize;
	if (aTotal < 4 || bTotal < 4) {
		return {
			output: { ...emptyDrift(target, column, binCount, 'full-table'), windowA: aStats, windowB: bStats },
			notes: [`drift-distribution: insufficient data (window A n=${aTotal}, window B n=${bTotal}); need >= 4 in each`],
			degradedConfidence: 'medium',
		};
	}
	if (sharedLo === null || sharedHi === null
		|| !Number.isFinite(sharedLo) || !Number.isFinite(sharedHi)
		|| sharedHi <= sharedLo) {
		return {
			output: {
				...emptyDrift(target, column, binCount, 'full-table'),
				windowA: aStats, windowB: bStats,
				sharedRange: { lower: sharedLo, upper: sharedHi },
			},
			notes: ['drift-distribution: union range is degenerate (constant column across both windows)'],
			degradedConfidence: 'medium',
		};
	}
	if (aBucketCounts.length !== binCount || bBucketCounts.length !== binCount) {
		return {
			output: {
				...emptyDrift(target, column, binCount, 'full-table'),
				windowA: aStats, windowB: bStats,
				sharedRange: { lower: sharedLo, upper: sharedHi },
			},
			notes: [`drift-distribution: bucket count mismatch (a=${aBucketCounts.length}, b=${bBucketCounts.length}, expected=${binCount})`],
			degradedConfidence: 'medium',
		};
	}
	return assembleDriftFromBins(target, column, aStats, bStats, sharedLo, sharedHi, aBucketCounts, bBucketCounts, binCount, 'full-table');
}

function assembleDriftFromBins(
	target: string,
	column: string,
	aStats: WindowStats,
	bStats: WindowStats,
	lo: number,
	hi: number,
	aBins: readonly number[],
	bBins: readonly number[],
	binCount: number,
	source: DriftSource,
): BuiltDrift {
	const pA = laplaceProbabilities(aBins);
	const pB = laplaceProbabilities(bBins);
	const pM = pA.map((a, i) => 0.5 * (a + pB[i]!));
	const klAfromM = klDivergence(pA, pM);
	const klBfromM = klDivergence(pB, pM);
	const js = 0.5 * (klAfromM + klBfromM);
	const normalizedJs = js / LOG2;
	const klAfromB = klDivergence(pA, pB);
	const klBfromA = klDivergence(pB, pA);

	let verdict: DriftVerdict;
	let interpretation: string;
	const tag = source === 'full-table' ? ' (full-table)' : '';
	if (normalizedJs < 0.05) {
		verdict = 'identical';
		interpretation = `JS=${js.toFixed(4)}, normalized=${normalizedJs.toFixed(3)}${tag}; distributions are statistically identical`;
	} else if (normalizedJs < 0.20) {
		verdict = 'similar';
		interpretation = `JS=${js.toFixed(4)}, normalized=${normalizedJs.toFixed(3)}${tag}; minor shape differences but broadly similar`;
	} else if (normalizedJs < 0.50) {
		verdict = 'shifted';
		interpretation = `JS=${js.toFixed(4)}, normalized=${normalizedJs.toFixed(3)}${tag}; noticeable shift between windows -- mean / variance / shape changed`;
	} else {
		verdict = 'divergent';
		interpretation = `JS=${js.toFixed(4)}, normalized=${normalizedJs.toFixed(3)}${tag}; distributions are markedly different`;
	}

	return {
		output: {
			target, column,
			windowA: aStats,
			windowB: bStats,
			sharedRange: { lower: lo, upper: hi },
			bins: binCount,
			jsDivergence: js,
			normalizedJs,
			klAFromB: klAfromB,
			klBFromA: klBfromA,
			verdict,
			interpretation,
			source,
		},
		notes: [],
		degradedConfidence: null,
	};
}

function histogram(values: readonly number[], lo: number, hi: number, binCount: number): number[] {
	const counts = new Array<number>(binCount).fill(0);
	const width = (hi - lo) / binCount;
	if (width <= 0) return counts;
	for (const v of values) {
		let idx = Math.floor((v - lo) / width);
		if (idx >= binCount) idx = binCount - 1;
		if (idx < 0)         idx = 0;
		counts[idx]!++;
	}
	return counts;
}

function laplaceProbabilities(counts: readonly number[]): number[] {
	const n = counts.reduce((a, b) => a + b, 0);
	const denom = n + counts.length;
	return counts.map(c => (c + 1) / denom);
}

function klDivergence(p: readonly number[], q: readonly number[]): number {
	let total = 0;
	for (let i = 0; i < p.length; i++) {
		const pi = p[i]!;
		const qi = q[i]!;
		if (pi > 0 && qi > 0) total += pi * Math.log(pi / qi);
	}
	return total;
}

export const DRIFT_WHERE_SCHEMA = {
	type: 'array',
	items: {
		type: 'object',
		properties: {
			column: { type: 'string' },
			op: {
				type: 'string',
				enum: ['=', '!=', 'in', 'is null', 'is not null', '<', '<=', '>', '>=', 'between'],
			},
			value:  {},
		},
		required: ['column', 'op'],
		additionalProperties: false,
	},
} as const;

// ---------------------------------------------------------------------------
// Full-table mode helpers (Phase 5f.1 Track-C)
// ---------------------------------------------------------------------------

interface AggregateSpec {
	readonly column: string;
	readonly function: string;
	readonly args?: { readonly predicate?: readonly { readonly column: string; readonly op: string; readonly value?: unknown }[] };
}

/** Per-window bounds aggregations: min, max, count_non_null. */
export function driftBoundsAggregationsFor(column: string): AggregateSpec[] {
	return [
		{ column, function: 'count_non_null' },
		{ column, function: 'min' },
		{ column, function: 'max' },
	];
}

export interface DriftBounds {
	readonly count: number | null;
	readonly min: number | null;
	readonly max: number | null;
}

export function parseDriftBounds(values: Readonly<Record<string, number | string | null>>, column: string): DriftBounds {
	return {
		count: numericFromAgg(values[`${column}__count_non_null`]),
		min:   numericFromAgg(values[`${column}__min`]),
		max:   numericFromAgg(values[`${column}__max`]),
	};
}

/**
 * Build N evenly-spaced bucket edges over [lo, hi]. Returns the
 * `binCount + 1` boundary values; bucket i covers [edges[i], edges[i+1]).
 * The last bucket is closed at the top: [edges[N-1], edges[N]].
 */
export function buildBucketEdges(lo: number, hi: number, binCount: number): number[] {
	const edges = new Array<number>(binCount + 1);
	const width = (hi - lo) / binCount;
	for (let i = 0; i <= binCount; i++) {
		edges[i] = lo + i * width;
	}
	// Force the final edge to exactly hi (eliminates floating-point drift).
	edges[binCount] = hi;
	return edges;
}

/**
 * Per-bucket count_where aggregations. The `column` field on each
 * spec is a unique tag (`bucket_<index>`) so the result keys don't
 * collide -- count_where signatures don't include literal values, so
 * 10 specs with identical predicate shape would otherwise produce
 * identical keys. Tag-prefix disambiguation is the lightweight fix.
 *
 * count_where skips column validation (rdbms-common.ts:567), so the
 * synthetic tag is accepted by every dialect.
 */
export function driftBucketAggregationsFor(column: string, edges: readonly number[]): AggregateSpec[] {
	const out: AggregateSpec[] = [];
	for (let i = 0; i < edges.length - 1; i++) {
		const low  = edges[i]!;
		const high = edges[i + 1]!;
		const isLast = i === edges.length - 2;
		// Last bucket is inclusive at the top edge so the max value
		// doesn't fall outside every bin.
		const upperOp = isLast ? '<=' : '<';
		out.push({
			column: `bucket_${i}`,
			function: 'count_where',
			args: {
				predicate: [
					{ column, op: '>=',     value: low  },
					{ column, op: upperOp,  value: high },
				],
			},
		});
	}
	return out;
}

export function parseDriftBucketCounts(
	values: Readonly<Record<string, number | string | null>>,
	column: string,
	binCount: number,
): number[] {
	const out: number[] = [];
	for (let i = 0; i < binCount; i++) {
		// countWhereSignature joins each clause's `<safeCol>_<safeOp>`
		// with `__`; for `>=` and `<` ops the safeOp strips to '' so the
		// signature is `<col>___<col>_` regardless of bucket. The
		// disambiguating prefix is the spec's `column` tag, set to
		// `bucket_<i>`.
		const sigLast = i === binCount - 1 ? `${column}___${column}_` : `${column}___${column}_`;
		const key = `bucket_${i}__count_where_${sigLast}`;
		const v = numericFromAgg(values[key]);
		out.push(v ?? 0);
	}
	return out;
}

function numericFromAgg(v: number | string | null | undefined): number | null {
	if (v === null || v === undefined) return null;
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

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

const WINDOW_STATS_SCHEMA = {
	type: 'object',
	properties: {
		sampleSize: { type: 'number' },
		min:        { type: ['number', 'null'] },
		max:        { type: ['number', 'null'] },
		mean:       { type: ['number', 'null'] },
	},
	required: ['sampleSize', 'min', 'max', 'mean'],
	additionalProperties: false,
} as const;

export const DRIFT_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:       { type: 'string' },
		column:       { type: 'string' },
		windowA:      WINDOW_STATS_SCHEMA,
		windowB:      WINDOW_STATS_SCHEMA,
		sharedRange: {
			type: 'object',
			properties: {
				lower: { type: ['number', 'null'] },
				upper: { type: ['number', 'null'] },
			},
			required: ['lower', 'upper'],
			additionalProperties: false,
		},
		bins:           { type: 'number' },
		jsDivergence:   { type: ['number', 'null'] },
		normalizedJs:   { type: ['number', 'null'] },
		klAFromB:       { type: ['number', 'null'] },
		klBFromA:       { type: ['number', 'null'] },
		verdict:        { type: 'string', enum: ['identical', 'similar', 'shifted', 'divergent', 'inconclusive'] },
		interpretation: { type: 'string' },
		source:         { type: 'string', enum: ['sample', 'full-table'] },
	},
	required: ['target', 'column', 'windowA', 'windowB', 'sharedRange',
	           'bins', 'jsDivergence', 'normalizedJs', 'klAFromB', 'klBFromA',
	           'verdict', 'interpretation', 'source'],
	additionalProperties: false,
};
