/**
 * Shared math + IO contract for `data.correlation.categorical-pairwise.{rdbms,file}`
 * (Phase 5c.2 of plans/analyzers/data-analyzer-skills.md).
 */

export const CORR_CAT_DEFAULT_SAMPLE = 50;
export const CORR_CAT_MAX_COLUMNS = 15;
export const CORR_CAT_MIN_PAIR_OVERLAP = 5;
export const CORR_CAT_TOP_K_REPORTED = 5;
export const CORR_CAT_MAX_DISTINCT_PER_COL = 25;
const STRONG_THRESHOLD = 0.7;
const MODERATE_THRESHOLD = 0.4;
const WEAK_THRESHOLD = 0.2;

const CATEGORICAL_TYPE_TOKENS = [
	'text', 'varchar', 'nvarchar', 'character', 'char',
	'string', 'enum', 'bool', 'boolean',
] as const;

export type CatClassification = 'strong' | 'moderate' | 'weak' | 'none' | 'inconclusive';

export interface CatPairResult {
	readonly columnA: string;
	readonly columnB: string;
	readonly overlapN: number;
	readonly cramerV: number | null;
	readonly chiSquared: number | null;
	readonly distinctA: number;
	readonly distinctB: number;
	readonly classification: CatClassification;
}

export interface CorrelationCatOutput {
	readonly target: string;
	readonly sampleSize: number;
	readonly evaluatedColumns: readonly string[];
	readonly droppedHighCardinality: readonly string[];
	readonly truncatedColumns: boolean;
	readonly pairs: readonly CatPairResult[];
	readonly topAssociated: readonly CatPairResult[];
	readonly interpretation: string;
}

export function isCategoricalType(declaredType: string): boolean {
	const lower = declaredType.toLowerCase();
	return CATEGORICAL_TYPE_TOKENS.some(tok => lower.includes(tok));
}

export function clampCorrCatSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return CORR_CAT_DEFAULT_SAMPLE;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

export function clampMaxDistinct(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return CORR_CAT_MAX_DISTINCT_PER_COL;
	return Math.min(Math.max(2, Math.floor(n)), 50);
}

export function pickCategoricalColumns(cols: readonly { name: string; type?: string }[]): string[] {
	return cols
		.filter(c => typeof c.name === 'string' && c.name.length > 0)
		.filter(c => isCategoricalType(c.type ?? ''))
		.map(c => c.name);
}

export interface CardinalityFilterResult {
	readonly evaluatedColumns: string[];
	readonly droppedHighCardinality: string[];
}

export function filterByCardinality(
	candidateCols: readonly string[],
	rows: readonly Readonly<Record<string, unknown>>[],
	maxDistinct: number,
): CardinalityFilterResult {
	const distinctByCol = new Map<string, Set<string>>();
	for (const col of candidateCols) {
		const set = new Set<string>();
		for (const row of rows) {
			const v = row[col];
			if (v === null || v === undefined) continue;
			set.add(stringifyCategory(v));
			if (set.size > maxDistinct) break;
		}
		distinctByCol.set(col, set);
	}
	const droppedHighCardinality: string[] = [];
	const evaluatedColumns: string[] = [];
	for (const col of candidateCols) {
		const distinct = distinctByCol.get(col)!.size;
		if (distinct > maxDistinct) droppedHighCardinality.push(col);
		else                        evaluatedColumns.push(col);
	}
	return { evaluatedColumns, droppedHighCardinality };
}

export function buildCorrelationCatOutput(
	target: string,
	evaluatedColumns: readonly string[],
	droppedHighCardinality: readonly string[],
	truncatedColumns: boolean,
	rows: readonly Readonly<Record<string, unknown>>[],
): CorrelationCatOutput {
	const pairs: CatPairResult[] = [];
	for (let i = 0; i < evaluatedColumns.length; i++) {
		for (let j = i + 1; j < evaluatedColumns.length; j++) {
			pairs.push(computePair(evaluatedColumns[i]!, evaluatedColumns[j]!, rows));
		}
	}
	const sortedPairs = [...pairs].sort((a, b) => {
		const aV = a.cramerV ?? -1;
		const bV = b.cramerV ?? -1;
		return bV - aV;
	});
	const topAssociated = sortedPairs.filter(p => p.cramerV !== null && p.cramerV >= WEAK_THRESHOLD).slice(0, CORR_CAT_TOP_K_REPORTED);
	const interpretation = describePairs(sortedPairs, evaluatedColumns.length, droppedHighCardinality.length);
	return {
		target,
		sampleSize: rows.length,
		evaluatedColumns,
		droppedHighCardinality,
		truncatedColumns,
		pairs: sortedPairs,
		topAssociated,
		interpretation,
	};
}

function computePair(colA: string, colB: string, rows: readonly Readonly<Record<string, unknown>>[]): CatPairResult {
	const cells = new Map<string, Map<string, number>>();
	const rowTotals = new Map<string, number>();
	const colTotals = new Map<string, number>();
	let n = 0;
	for (const row of rows) {
		const aRaw = row[colA];
		const bRaw = row[colB];
		if (aRaw === null || aRaw === undefined || bRaw === null || bRaw === undefined) continue;
		const a = stringifyCategory(aRaw);
		const b = stringifyCategory(bRaw);
		n++;
		let inner = cells.get(a);
		if (inner === undefined) { inner = new Map(); cells.set(a, inner); }
		inner.set(b, (inner.get(b) ?? 0) + 1);
		rowTotals.set(a, (rowTotals.get(a) ?? 0) + 1);
		colTotals.set(b, (colTotals.get(b) ?? 0) + 1);
	}
	const distinctA = rowTotals.size;
	const distinctB = colTotals.size;
	if (n < CORR_CAT_MIN_PAIR_OVERLAP || distinctA < 2 || distinctB < 2) {
		return { columnA: colA, columnB: colB, overlapN: n, cramerV: null, chiSquared: null, distinctA, distinctB, classification: 'inconclusive' };
	}
	let chiSquared = 0;
	for (const [a, inner] of cells) {
		const rowTotal = rowTotals.get(a)!;
		for (const [b, observed] of inner) {
			const colTotal = colTotals.get(b)!;
			const expected = (rowTotal * colTotal) / n;
			if (expected === 0) continue;
			const diff = observed - expected;
			chiSquared += (diff * diff) / expected;
		}
	}
	const denom = n * Math.min(distinctA - 1, distinctB - 1);
	const cramerV = denom === 0 ? null : Math.sqrt(chiSquared / denom);
	return { columnA: colA, columnB: colB, overlapN: n, cramerV, chiSquared, distinctA, distinctB, classification: classify(cramerV) };
}

function classify(v: number | null): CatClassification {
	if (v === null) return 'inconclusive';
	if (v >= STRONG_THRESHOLD)   return 'strong';
	if (v >= MODERATE_THRESHOLD) return 'moderate';
	if (v >= WEAK_THRESHOLD)     return 'weak';
	return 'none';
}

function describePairs(pairs: readonly CatPairResult[], colCount: number, dropped: number): string {
	const total = pairs.length;
	if (total === 0) return `no pairs to evaluate (${colCount} categorical columns; ${dropped} dropped as high-cardinality)`;
	const counts: Record<string, number> = {};
	for (const p of pairs) counts[p.classification] = (counts[p.classification] ?? 0) + 1;
	const strong   = counts['strong']       ?? 0;
	const moderate = counts['moderate']     ?? 0;
	const weak     = counts['weak']         ?? 0;
	const none     = counts['none']         ?? 0;
	const inconc   = counts['inconclusive'] ?? 0;
	const top = pairs[0];
	const droppedClause = dropped > 0 ? ` (${dropped} high-cardinality column${dropped === 1 ? '' : 's'} excluded)` : '';
	if (top === undefined || top.cramerV === null) {
		return `${total} pairs evaluated; all inconclusive${droppedClause}`;
	}
	return `${total} pairs from ${colCount} categorical columns: ${strong} strong, ${moderate} moderate, ${weak} weak, ${none} none, ${inconc} inconclusive${droppedClause}. ` +
	       `Top: ${top.columnA}↔${top.columnB} V=${top.cramerV.toFixed(3)} (${top.classification}, n=${top.overlapN})`;
}

function stringifyCategory(raw: unknown): string {
	if (typeof raw === 'string')  return raw;
	if (typeof raw === 'boolean') return raw ? 'true' : 'false';
	if (typeof raw === 'number')  return String(raw);
	if (typeof raw === 'bigint')  return raw.toString();
	return JSON.stringify(raw);
}

export function emptyCorrelationCatOutput(target: string): CorrelationCatOutput {
	return {
		target,
		sampleSize: 0,
		evaluatedColumns: [],
		droppedHighCardinality: [],
		truncatedColumns: false,
		pairs: [],
		topAssociated: [],
		interpretation: '',
	};
}

const PAIR_SCHEMA = {
	type: 'object',
	properties: {
		columnA:        { type: 'string' },
		columnB:        { type: 'string' },
		overlapN:       { type: 'number' },
		cramerV:        { type: ['number', 'null'] },
		chiSquared:     { type: ['number', 'null'] },
		distinctA:      { type: 'number' },
		distinctB:      { type: 'number' },
		classification: { type: 'string' },
	},
	required: ['columnA', 'columnB', 'overlapN', 'cramerV', 'chiSquared', 'distinctA', 'distinctB', 'classification'],
	additionalProperties: false,
} as const;

export const CORRELATION_CAT_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:                  { type: 'string' },
		sampleSize:              { type: 'number' },
		evaluatedColumns:        { type: 'array', items: { type: 'string' } },
		droppedHighCardinality:  { type: 'array', items: { type: 'string' } },
		truncatedColumns:        { type: 'boolean' },
		pairs:                   { type: 'array', items: PAIR_SCHEMA },
		topAssociated:           { type: 'array', items: PAIR_SCHEMA },
		interpretation:          { type: 'string' },
	},
	required: ['target', 'sampleSize', 'evaluatedColumns', 'droppedHighCardinality',
	           'truncatedColumns', 'pairs', 'topAssociated', 'interpretation'],
	additionalProperties: false,
};
