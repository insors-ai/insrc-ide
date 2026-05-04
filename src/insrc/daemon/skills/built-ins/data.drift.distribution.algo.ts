/**
 * Shared math + IO contract for `data.drift.distribution.{rdbms,file}`
 * (Phase 5f.1 of plans/analyzers/data-analyzer-skills.md).
 *
 * Jensen-Shannon divergence between two sample windows of one numeric
 * column. Symmetric (D(A,B) == D(B,A)), bounded (0..log(2)), and
 * well-defined when one distribution has zero mass in a bin where the
 * other has positive mass. KL divergence (per-direction) is reported
 * alongside for familiarity.
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

export interface DriftWhereClauseIn {
	readonly column: string;
	readonly op: '=' | '!=' | 'in' | 'is null';
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
}

export function clampDriftSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return DRIFT_SAMPLE_DEFAULT;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

export function clampDriftBins(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return DRIFT_BINS_DEFAULT;
	return Math.min(Math.max(4, Math.floor(n)), 50);
}

export function emptyDrift(target: string, column: string, bins: number): DriftDistributionOutput {
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
	if (normalizedJs < 0.05) {
		verdict = 'identical';
		interpretation = `JS=${js.toFixed(4)}, normalized=${normalizedJs.toFixed(3)}; distributions are statistically identical`;
	} else if (normalizedJs < 0.20) {
		verdict = 'similar';
		interpretation = `JS=${js.toFixed(4)}, normalized=${normalizedJs.toFixed(3)}; minor shape differences but broadly similar`;
	} else if (normalizedJs < 0.50) {
		verdict = 'shifted';
		interpretation = `JS=${js.toFixed(4)}, normalized=${normalizedJs.toFixed(3)}; noticeable shift between windows -- mean / variance / shape changed`;
	} else {
		verdict = 'divergent';
		interpretation = `JS=${js.toFixed(4)}, normalized=${normalizedJs.toFixed(3)}; distributions are markedly different`;
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
			op:     { type: 'string', enum: ['=', '!=', 'in', 'is null'] },
			value:  {},
		},
		required: ['column', 'op'],
		additionalProperties: false,
	},
} as const;

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
	},
	required: ['target', 'column', 'windowA', 'windowB', 'sharedRange',
	           'bins', 'jsDivergence', 'normalizedJs', 'klAFromB', 'klBFromA',
	           'verdict', 'interpretation'],
	additionalProperties: false,
};
