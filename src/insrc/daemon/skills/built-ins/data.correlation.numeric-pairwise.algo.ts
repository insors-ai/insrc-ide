/**
 * Shared math + IO contract for `data.correlation.numeric-pairwise.{rdbms,file}`
 * (Phase 5c.1 of plans/analyzers/data-analyzer-skills.md).
 *
 * Both wrappers feed in already-fetched sample rows + the candidate
 * column list; the algo computes Pearson + Spearman per unordered
 * pair and produces the typed output with classification.
 */

export const CORRELATION_DEFAULT_SAMPLE = 50;
export const CORRELATION_MAX_COLUMNS = 15;
export const CORRELATION_MIN_PAIR_OVERLAP = 5;
export const CORRELATION_TOP_K_REPORTED = 3;
const STRONG_THRESHOLD = 0.7;
const MODERATE_THRESHOLD = 0.4;
const WEAK_THRESHOLD = 0.2;

const NUMERIC_TYPE_TOKENS = [
	'int', 'integer', 'bigint', 'smallint', 'tinyint',
	'decimal', 'numeric', 'number',
	'real', 'float', 'double',
	'money',
] as const;

export type Classification =
	| 'strong-positive' | 'moderate-positive' | 'weak-positive'
	| 'strong-negative' | 'moderate-negative' | 'weak-negative'
	| 'none' | 'inconclusive';

export interface PairResult {
	readonly columnA: string;
	readonly columnB: string;
	readonly overlapN: number;
	readonly pearson: number | null;
	readonly spearman: number | null;
	readonly classification: Classification;
}

export interface CorrelationOutput {
	readonly target: string;
	readonly sampleSize: number;
	readonly evaluatedColumns: readonly string[];
	readonly truncatedColumns: boolean;
	readonly pairs: readonly PairResult[];
	readonly topPositive: readonly PairResult[];
	readonly topNegative: readonly PairResult[];
	readonly interpretation: string;
}

export function isNumericType(declaredType: string): boolean {
	const lower = declaredType.toLowerCase();
	return NUMERIC_TYPE_TOKENS.some(tok => lower.includes(tok));
}

export function clampCorrelationSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return CORRELATION_DEFAULT_SAMPLE;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

export function buildCorrelationOutput(
	target: string,
	evaluatedColumns: readonly string[],
	truncatedColumns: boolean,
	rows: readonly Readonly<Record<string, unknown>>[],
): CorrelationOutput {
	const pairs: PairResult[] = [];
	for (let i = 0; i < evaluatedColumns.length; i++) {
		for (let j = i + 1; j < evaluatedColumns.length; j++) {
			pairs.push(computePair(evaluatedColumns[i]!, evaluatedColumns[j]!, rows));
		}
	}
	const sortedPairs = [...pairs].sort((a, b) => {
		const aR = a.pearson === null ? -1 : Math.abs(a.pearson);
		const bR = b.pearson === null ? -1 : Math.abs(b.pearson);
		return bR - aR;
	});
	const topPositive = sortedPairs.filter(p => p.pearson !== null && p.pearson > 0).slice(0, CORRELATION_TOP_K_REPORTED);
	const topNegative = sortedPairs.filter(p => p.pearson !== null && p.pearson < 0).slice(0, CORRELATION_TOP_K_REPORTED);
	const interpretation = describePairs(sortedPairs, evaluatedColumns.length);
	return {
		target,
		sampleSize: rows.length,
		evaluatedColumns,
		truncatedColumns,
		pairs: sortedPairs,
		topPositive,
		topNegative,
		interpretation,
	};
}

function computePair(colA: string, colB: string, rows: readonly Readonly<Record<string, unknown>>[]): PairResult {
	const xs: number[] = [];
	const ys: number[] = [];
	for (const row of rows) {
		const a = toNumber(row[colA]);
		const b = toNumber(row[colB]);
		if (a === null || b === null) continue;
		xs.push(a); ys.push(b);
	}
	const n = xs.length;
	if (n < CORRELATION_MIN_PAIR_OVERLAP) {
		return { columnA: colA, columnB: colB, overlapN: n, pearson: null, spearman: null, classification: 'inconclusive' };
	}
	const pearson = pearsonR(xs, ys);
	const spearman = spearmanR(xs, ys);
	return { columnA: colA, columnB: colB, overlapN: n, pearson, spearman, classification: classify(pearson) };
}

function pearsonR(xs: number[], ys: number[]): number | null {
	const n = xs.length;
	let xMean = 0, yMean = 0;
	for (let i = 0; i < n; i++) { xMean += xs[i]!; yMean += ys[i]!; }
	xMean /= n; yMean /= n;
	let sxx = 0, syy = 0, sxy = 0;
	for (let i = 0; i < n; i++) {
		const dx = xs[i]! - xMean;
		const dy = ys[i]! - yMean;
		sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
	}
	if (sxx === 0 || syy === 0) return null;
	return sxy / Math.sqrt(sxx * syy);
}

function spearmanR(xs: number[], ys: number[]): number | null {
	return pearsonR(ranks(xs), ranks(ys));
}

function ranks(values: number[]): number[] {
	const n = values.length;
	const idx = values.map((v, i) => ({ v, i }));
	idx.sort((a, b) => a.v - b.v);
	const out = new Array<number>(n);
	let i = 0;
	while (i < n) {
		let j = i;
		while (j + 1 < n && idx[j + 1]!.v === idx[i]!.v) j++;
		const avgRank = (i + j) / 2 + 1;
		for (let k = i; k <= j; k++) out[idx[k]!.i] = avgRank;
		i = j + 1;
	}
	return out;
}

function classify(r: number | null): Classification {
	if (r === null) return 'inconclusive';
	const a = Math.abs(r);
	if (a < WEAK_THRESHOLD) return 'none';
	const sign: 'positive' | 'negative' = r > 0 ? 'positive' : 'negative';
	if (a >= STRONG_THRESHOLD)   return `strong-${sign}`   as Classification;
	if (a >= MODERATE_THRESHOLD) return `moderate-${sign}` as Classification;
	return `weak-${sign}` as Classification;
}

function describePairs(pairs: readonly PairResult[], colCount: number): string {
	const total = pairs.length;
	if (total === 0) return `no pairs to evaluate (${colCount} numeric columns found)`;
	const counts: Record<string, number> = {};
	for (const p of pairs) counts[p.classification] = (counts[p.classification] ?? 0) + 1;
	const strong   = (counts['strong-positive']   ?? 0) + (counts['strong-negative']   ?? 0);
	const moderate = (counts['moderate-positive'] ?? 0) + (counts['moderate-negative'] ?? 0);
	const weak     = (counts['weak-positive']     ?? 0) + (counts['weak-negative']     ?? 0);
	const none     = counts['none'] ?? 0;
	const inconc   = counts['inconclusive'] ?? 0;
	const top = pairs[0];
	if (top === undefined || top.pearson === null) {
		return `${total} pairs evaluated; all inconclusive (insufficient overlap or constant columns)`;
	}
	const topR = top.pearson.toFixed(3);
	const topSp = top.spearman === null ? 'n/a' : top.spearman.toFixed(3);
	return `${total} pairs from ${colCount} numeric columns: ${strong} strong, ${moderate} moderate, ${weak} weak, ${none} none, ${inconc} inconclusive. ` +
	       `Top: ${top.columnA}↔${top.columnB} Pearson=${topR} Spearman=${topSp} (${top.classification})`;
}

function toNumber(raw: unknown): number | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
	if (typeof raw === 'bigint') return Number(raw);
	if (typeof raw === 'string') {
		const n = Number(raw);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

export function emptyCorrelationOutput(target: string): CorrelationOutput {
	return {
		target,
		sampleSize: 0,
		evaluatedColumns: [],
		truncatedColumns: false,
		pairs: [],
		topPositive: [],
		topNegative: [],
		interpretation: '',
	};
}

const PAIR_SCHEMA = {
	type: 'object',
	properties: {
		columnA: { type: 'string' },
		columnB: { type: 'string' },
		overlapN: { type: 'number' },
		pearson:  { type: ['number', 'null'] },
		spearman: { type: ['number', 'null'] },
		classification: { type: 'string' },
	},
	required: ['columnA', 'columnB', 'overlapN', 'pearson', 'spearman', 'classification'],
	additionalProperties: false,
} as const;

export const CORRELATION_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:           { type: 'string' },
		sampleSize:       { type: 'number' },
		evaluatedColumns: { type: 'array', items: { type: 'string' } },
		truncatedColumns: { type: 'boolean' },
		pairs:            { type: 'array', items: PAIR_SCHEMA },
		topPositive:      { type: 'array', items: PAIR_SCHEMA },
		topNegative:      { type: 'array', items: PAIR_SCHEMA },
		interpretation:   { type: 'string' },
	},
	required: ['target', 'sampleSize', 'evaluatedColumns', 'truncatedColumns',
	           'pairs', 'topPositive', 'topNegative', 'interpretation'],
	additionalProperties: false,
};

export interface DescribeColumn { readonly name: string; readonly type?: string }
export interface DescribeResult { readonly columns: readonly DescribeColumn[] }

export function isDescribeResult(v: unknown): v is DescribeResult {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return Array.isArray(o['columns']);
}

export interface SampleResultRaw {
	readonly target: string;
	readonly columns: readonly string[];
	readonly rows: readonly Readonly<Record<string, unknown>>[];
}

export function isCorrelationSampleResult(v: unknown): v is SampleResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && Array.isArray(o['columns']) && Array.isArray(o['rows']);
}

export function pickNumericColumns(cols: readonly DescribeColumn[]): string[] {
	return cols
		.filter(c => typeof c.name === 'string' && c.name.length > 0)
		.filter(c => isNumericType(c.type ?? ''))
		.map(c => c.name);
}
