/**
 * data.drift.distribution.rdbms -- Phase 5f.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic drift skill: compares the distribution of one numeric
 * column between two windows of the same table, returning the
 * Jensen-Shannon divergence (JS) plus the per-direction KL
 * divergences. Activates the `drift` family.
 *
 * The two windows are defined by caller-supplied `WhereClause[]`
 * inputs (`windowAWhere`, `windowBWhere`) -- typically a date
 * column split before / after some cutover, or a category column
 * filtered to two cohorts. The skill samples 50 rows from each
 * window, builds a fixed-bin histogram over the union range, and
 * computes JS over the smoothed densities.
 *
 * Why JS instead of raw KL: JS divergence is symmetric (D(A,B) ==
 * D(B,A)), bounded (0 .. log(2) ≈ 0.693), and well-defined when
 * one distribution has zero mass in a bin where the other has
 * positive mass. KL divergence, by contrast, is asymmetric and
 * blows up to infinity on zero-mass bins -- workable but needs
 * Laplace smoothing to stay finite. We surface both: KL for
 * familiarity (per-direction "how surprised would A be by data
 * from B?"), JS as the primary verdict input.
 *
 * Verdict ladder uses normalized JS (jsDivergence / log(2), so
 * 0 = identical, 1 = maximally divergent):
 *   <  0.05 -> identical
 *   <  0.20 -> similar
 *   <  0.50 -> shifted
 *   >= 0.50 -> divergent
 *
 * Sample-based; 50 rows per window. The verdict is a *signal* at
 * this n -- a precise full-table KL/JS would need a server-side
 * histogram tool that doesn't exist yet.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult, SkillToolResult } from '../types.js';

const SAMPLE_DEFAULT = 50;
const BINS_DEFAULT = 10;
const LOG2 = Math.log(2);

interface WhereClauseIn {
	readonly column: string;
	readonly op: '=' | '!=' | 'in' | 'is null';
	readonly value?: unknown;
}

interface DriftDistributionInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly windowAWhere: readonly WhereClauseIn[];
	readonly windowBWhere: readonly WhereClauseIn[];
	readonly sampleSize?: number;
	readonly bins?: number;
}

interface WindowStats {
	readonly sampleSize: number;
	readonly min: number | null;
	readonly max: number | null;
	readonly mean: number | null;
}

type Verdict = 'identical' | 'similar' | 'shifted' | 'divergent' | 'inconclusive';

interface DriftDistributionOutput {
	readonly target: string;
	readonly column: string;
	readonly windowA: WindowStats;
	readonly windowB: WindowStats;
	readonly sharedRange: { lower: number | null; upper: number | null };
	readonly bins: number;
	readonly jsDivergence: number | null;       // 0..log(2); symmetric
	readonly normalizedJs: number | null;        // jsDivergence / log(2); 0..1
	readonly klAFromB: number | null;            // KL(A || B) with Laplace smoothing
	readonly klBFromA: number | null;            // KL(B || A) with Laplace smoothing
	readonly verdict: Verdict;
	readonly interpretation: string;
}

const WHERE_SCHEMA = {
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

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<DriftDistributionInput, DriftDistributionOutput> = {
	id: 'data.drift.distribution.rdbms',
	name: 'Drift: distribution divergence (RDBMS)',
	description:
		'Jensen-Shannon divergence between two sample windows of a numeric column. Caller supplies two ' +
		'WhereClause[] filters; skill samples 50 rows from each, builds a shared-range histogram, computes ' +
		'JS + per-direction KL (Laplace-smoothed). Returns normalizedJs (0=identical, 1=maximally ' +
		'divergent) + verdict (identical / similar / shifted / divergent / inconclusive). Sample-based.',
	family: 'drift',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId:  { type: 'string' },
			target:        { type: 'string' },
			column:        { type: 'string' },
			windowAWhere:  WHERE_SCHEMA,
			windowBWhere:  WHERE_SCHEMA,
			sampleSize:    { type: 'integer', minimum: 1, maximum: 50 },
			bins:          { type: 'integer', minimum: 4, maximum: 50, description: 'Histogram bin count; default 10.' },
		},
		required: ['connectionId', 'target', 'column', 'windowAWhere', 'windowBWhere'],
		additionalProperties: false,
	},
	outputs: {
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
	},
	toolDeps: ['db_sql_sample'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_sample'],
			reason: 'two parallel samples (one per window) feed the histograms',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<DriftDistributionOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampSample(input.sampleSize);
		const binCount = clampBins(input.bins);
		const col = input.column;

		const [aTool, bTool] = await Promise.all([
			deps.runTool({
				id: `${callBase}-a`,
				name: 'db_sql_sample',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					limit: sampleSize,
					where: input.windowAWhere,
				},
			}),
			deps.runTool({
				id: `${callBase}-b`,
				name: 'db_sql_sample',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					limit: sampleSize,
					where: input.windowBWhere,
				},
			}),
		]);

		const errors = collectToolErrors([['db_sql_sample (A)', aTool], ['db_sql_sample (B)', bTool]]);
		if (errors.length > 0) {
			return {
				value: empty(input.target, col, binCount),
				confidence: 'low',
				notes: errors,
				toolCalls: [],
			};
		}
		if (!isSampleResult(aTool.data) || !isSampleResult(bTool.data)) {
			return {
				value: empty(input.target, col, binCount),
				confidence: 'low',
				notes: ['drift-distribution: one or both sample tool results were missing structured data'],
				toolCalls: [],
			};
		}

		const aValues = extractNumbers(aTool.data, col);
		const bValues = extractNumbers(bTool.data, col);

		const aStats = describeWindow(aValues);
		const bStats = describeWindow(bValues);

		// Need at least a few values in each window to compute meaningful divergence.
		if (aValues.length < 4 || bValues.length < 4) {
			return {
				value: {
					...empty(input.target, col, binCount),
					windowA: aStats,
					windowB: bStats,
				},
				confidence: 'medium',
				notes: [`drift-distribution: insufficient data (window A n=${aValues.length}, window B n=${bValues.length}); need >= 4 in each`],
				toolCalls: [],
			};
		}

		// Shared bin range = union of min/max across both windows.
		const lo = Math.min(...aValues, ...bValues);
		const hi = Math.max(...aValues, ...bValues);
		if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
			return {
				value: {
					...empty(input.target, col, binCount),
					windowA: aStats, windowB: bStats,
					sharedRange: { lower: lo, upper: hi },
				},
				confidence: 'medium',
				notes: ['drift-distribution: union range is degenerate (constant column or single-point sample)'],
				toolCalls: [],
			};
		}

		const aBins = histogram(aValues, lo, hi, binCount);
		const bBins = histogram(bValues, lo, hi, binCount);

		// Convert counts -> probabilities with Laplace smoothing
		// (epsilon = 1; total adjustment = binCount).
		const pA = laplaceProbabilities(aBins);
		const pB = laplaceProbabilities(bBins);
		const pM = pA.map((a, i) => 0.5 * (a + pB[i]!));

		const klAfromM = klDivergence(pA, pM);
		const klBfromM = klDivergence(pB, pM);
		const js = 0.5 * (klAfromM + klBfromM);
		const normalizedJs = js / LOG2;

		const klAfromB = klDivergence(pA, pB);
		const klBfromA = klDivergence(pB, pA);

		let verdict: Verdict;
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
			value: {
				target: aTool.data.target,
				column: col,
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
			confidence: 'high',
			toolCalls: [],
		};
	},
};

function extractNumbers(
	sample: { columns: readonly string[]; rows: readonly Readonly<Record<string, unknown>>[] },
	col: string,
): number[] {
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

function describeWindow(values: readonly number[]): WindowStats {
	if (values.length === 0) return { sampleSize: 0, min: null, max: null, mean: null };
	let mn = values[0]!, mx = values[0]!, sum = 0;
	for (const v of values) {
		if (v < mn) mn = v;
		if (v > mx) mx = v;
		sum += v;
	}
	return { sampleSize: values.length, min: mn, max: mx, mean: sum / values.length };
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

/**
 * Laplace-smoothed probabilities: each count is incremented by 1
 * before normalising to keep probabilities strictly positive (so
 * KL stays finite). Equivalent to a uniform-prior Bayesian update.
 */
function laplaceProbabilities(counts: readonly number[]): number[] {
	const n = counts.reduce((a, b) => a + b, 0);
	const denom = n + counts.length;
	return counts.map(c => (c + 1) / denom);
}

/** D_KL(p || q) = Σ p_i * log(p_i / q_i). Assumes both inputs are
 *  strictly positive (use laplaceProbabilities to ensure that). */
function klDivergence(p: readonly number[], q: readonly number[]): number {
	let total = 0;
	for (let i = 0; i < p.length; i++) {
		const pi = p[i]!;
		const qi = q[i]!;
		if (pi > 0 && qi > 0) total += pi * Math.log(pi / qi);
	}
	return total;
}

function clampSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return SAMPLE_DEFAULT;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

function clampBins(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return BINS_DEFAULT;
	return Math.min(Math.max(4, Math.floor(n)), 50);
}

function empty(target: string, column: string, bins: number): DriftDistributionOutput {
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

function collectToolErrors(
	pairs: readonly (readonly [string, SkillToolResult])[],
): string[] {
	const out: string[] = [];
	for (const [name, res] of pairs) {
		if (res.isError) out.push(`${name} error: ${res.content.slice(0, 200)}`);
	}
	return out;
}

interface SampleResultRaw {
	readonly target: string;
	readonly columns: readonly string[];
	readonly rows: readonly Readonly<Record<string, unknown>>[];
}

function isSampleResult(v: unknown): v is SampleResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& Array.isArray(o['columns'])
		&& Array.isArray(o['rows']);
}

export function registerDataDriftDistributionRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
