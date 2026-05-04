/**
 * data.correlation.numeric-pairwise.rdbms -- Phase 5c.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic dependency skill: computes pairwise Pearson + Spearman
 * correlation between numeric columns over a 50-row sample. Returns
 * the full pair table sorted by |Pearson| descending plus convenience
 * top-3 positive / top-3 negative shortlists.
 *
 * Both correlations because they capture different relationships:
 *   - Pearson  measures LINEAR association (sensitive to outliers,
 *              breaks down on monotonic-but-curved relationships).
 *   - Spearman measures MONOTONIC association via rank-correlation
 *              (robust to outliers, picks up curved monotonic
 *              relationships Pearson misses).
 *
 * The two together steer interpretation: if Pearson ≈ Spearman,
 * the relationship is linear. If Spearman is much larger, look for
 * monotonic-but-non-linear (log / exp / power). If both are small,
 * the variables are unrelated OR have a non-monotonic relationship
 * (e.g. quadratic).
 *
 * v1 limits:
 *   - Sample-based at n=50; precise full-table corr() needs Phase 0.4
 *     `db_correlation_matrix`. Sample-based is sufficient for
 *     exploratory "which pairs are worth investigating?".
 *   - Up to 15 columns / 105 unordered pairs per call (matches the
 *     5c.4 co-null cap).
 *   - Numeric-column auto-discovery via lowercase-substring rules
 *     against the declared SQL type (int / float / decimal / numeric /
 *     real / double). Caller-supplied `columns` skip the filter.
 *
 * Pairs with `correlation.categorical-pairwise` (5c.2, Cramér's V --
 * pending) for the analogous categorical-column flow.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult, SkillToolResult } from '../types.js';

const SAMPLE_DEFAULT      = 50;
const MAX_COLUMNS         = 15;
const MIN_PAIR_OVERLAP    = 5;          // need >=5 paired non-null rows for a r value
const TOP_K_REPORTED      = 3;
const STRONG_THRESHOLD    = 0.7;
const MODERATE_THRESHOLD  = 0.4;
const WEAK_THRESHOLD      = 0.2;

const NUMERIC_TYPE_TOKENS = [
	'int', 'integer', 'bigint', 'smallint', 'tinyint',
	'decimal', 'numeric', 'number',
	'real', 'float', 'double',
	'money',
] as const;

interface CorrelationInput {
	readonly connectionId: string;
	readonly target: string;
	readonly columns?: readonly string[];   // explicit pick; skips auto-discovery
	readonly sampleSize?: number;
}

type Classification =
	| 'strong-positive' | 'moderate-positive' | 'weak-positive'
	| 'strong-negative' | 'moderate-negative' | 'weak-negative'
	| 'none' | 'inconclusive';

interface PairResult {
	readonly columnA: string;
	readonly columnB: string;
	readonly overlapN: number;          // # rows where both columns non-null
	readonly pearson: number | null;
	readonly spearman: number | null;
	readonly classification: Classification;
}

interface CorrelationOutput {
	readonly target: string;
	readonly sampleSize: number;
	readonly evaluatedColumns: readonly string[];
	readonly truncatedColumns: boolean;
	readonly pairs: readonly PairResult[];
	readonly topPositive: readonly PairResult[];
	readonly topNegative: readonly PairResult[];
	readonly interpretation: string;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<CorrelationInput, CorrelationOutput> = {
	id: 'data.correlation.numeric-pairwise.rdbms',
	name: 'Correlation: numeric pairwise (RDBMS)',
	description:
		'Pairwise Pearson + Spearman correlation across numeric columns over a 50-row sample. Auto- ' +
		'discovers numeric columns via `db_sql_describe` (caller-supplied `columns` skip the filter). ' +
		'Returns the full pair table sorted by |Pearson| descending plus top-3 positive / top-3 negative ' +
		'shortlists. Pearson + Spearman together let the caller distinguish linear from monotonic-curved ' +
		'relationships. Sample-based; up to 15 columns / 105 unordered pairs per call.',
	family: 'dependency',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			columns:      { type: 'array', items: { type: 'string' }, description: 'Explicit column pick; skips numeric-type auto-discovery.' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50, description: 'Default 50.' },
		},
		required: ['connectionId', 'target'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:           { type: 'string' },
			sampleSize:       { type: 'number' },
			evaluatedColumns: { type: 'array', items: { type: 'string' } },
			truncatedColumns: { type: 'boolean' },
			pairs: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						columnA:        { type: 'string' },
						columnB:        { type: 'string' },
						overlapN:       { type: 'number' },
						pearson:        { type: ['number', 'null'] },
						spearman:       { type: ['number', 'null'] },
						classification: { type: 'string' },
					},
					required: ['columnA', 'columnB', 'overlapN', 'pearson', 'spearman', 'classification'],
					additionalProperties: false,
				},
			},
			topPositive: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						columnA:        { type: 'string' },
						columnB:        { type: 'string' },
						overlapN:       { type: 'number' },
						pearson:        { type: ['number', 'null'] },
						spearman:       { type: ['number', 'null'] },
						classification: { type: 'string' },
					},
					required: ['columnA', 'columnB', 'overlapN', 'pearson', 'spearman', 'classification'],
					additionalProperties: false,
				},
			},
			topNegative: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						columnA:        { type: 'string' },
						columnB:        { type: 'string' },
						overlapN:       { type: 'number' },
						pearson:        { type: ['number', 'null'] },
						spearman:       { type: ['number', 'null'] },
						classification: { type: 'string' },
					},
					required: ['columnA', 'columnB', 'overlapN', 'pearson', 'spearman', 'classification'],
					additionalProperties: false,
				},
			},
			interpretation: { type: 'string' },
		},
		required: ['target', 'sampleSize', 'evaluatedColumns', 'truncatedColumns',
		           'pairs', 'topPositive', 'topNegative', 'interpretation'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_describe', 'db_sql_sample'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_describe', 'db_sql_sample'],
			reason: 'describe gives the numeric column list; sample gives the rows we correlate over',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<CorrelationOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampSample(input.sampleSize);

		const colsOrErr = await resolveNumericColumns(input, deps, callBase);
		if (typeof colsOrErr === 'string') {
			return { value: empty(input.target), confidence: 'low', notes: [colsOrErr], toolCalls: [] };
		}
		const allCols = colsOrErr;
		const truncatedColumns = allCols.length > MAX_COLUMNS;
		const evaluatedColumns = allCols.slice(0, MAX_COLUMNS);

		if (evaluatedColumns.length < 2) {
			return {
				value: {
					...empty(input.target),
					evaluatedColumns,
					interpretation: `need >= 2 numeric columns to compute pairwise correlations; found ${evaluatedColumns.length}`,
				},
				confidence: 'medium',
				toolCalls: [],
			};
		}

		const sampleTool = await deps.runTool({
			id: `${callBase}-sample`,
			name: 'db_sql_sample',
			input: { connectionId: input.connectionId, target: input.target, limit: sampleSize },
		});

		if (sampleTool.isError) {
			return {
				value: empty(input.target),
				confidence: 'low',
				notes: [`db_sql_sample error: ${sampleTool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		if (!isSampleResult(sampleTool.data)) {
			return {
				value: empty(input.target),
				confidence: 'low',
				notes: ['db_sql_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}
		const rows = sampleTool.data.rows;

		// Compute every unordered pair.
		const pairs: PairResult[] = [];
		for (let i = 0; i < evaluatedColumns.length; i++) {
			for (let j = i + 1; j < evaluatedColumns.length; j++) {
				pairs.push(computePair(evaluatedColumns[i]!, evaluatedColumns[j]!, rows));
			}
		}

		// Sort by absolute Pearson descending. Nulls go last.
		const sortedPairs = [...pairs].sort((a, b) => {
			const aR = a.pearson === null ? -1 : Math.abs(a.pearson);
			const bR = b.pearson === null ? -1 : Math.abs(b.pearson);
			return bR - aR;
		});

		const positivePairs = sortedPairs
			.filter(p => p.pearson !== null && p.pearson > 0)
			.slice(0, TOP_K_REPORTED);
		const negativePairs = sortedPairs
			.filter(p => p.pearson !== null && p.pearson < 0)
			.slice(0, TOP_K_REPORTED);

		const interpretation = describe(sortedPairs, evaluatedColumns.length);

		return {
			value: {
				target: sampleTool.data.target,
				sampleSize: rows.length,
				evaluatedColumns,
				truncatedColumns,
				pairs: sortedPairs,
				topPositive: positivePairs,
				topNegative: negativePairs,
				interpretation,
			},
			confidence: 'high',
			toolCalls: [],
		};
	},
};

function computePair(
	colA: string,
	colB: string,
	rows: readonly Readonly<Record<string, unknown>>[],
): PairResult {
	// Collect (a, b) pairs where both values are numeric + non-null.
	const xs: number[] = [];
	const ys: number[] = [];
	for (const row of rows) {
		const aRaw = row[colA];
		const bRaw = row[colB];
		const a = toNumber(aRaw);
		const b = toNumber(bRaw);
		if (a === null || b === null) continue;
		xs.push(a);
		ys.push(b);
	}
	const n = xs.length;
	if (n < MIN_PAIR_OVERLAP) {
		return {
			columnA: colA, columnB: colB, overlapN: n,
			pearson: null, spearman: null,
			classification: 'inconclusive',
		};
	}
	const pearson  = pearsonR(xs, ys);
	const spearman = spearmanR(xs, ys);
	const classification = classify(pearson);
	return { columnA: colA, columnB: colB, overlapN: n, pearson, spearman, classification };
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
		sxx += dx * dx;
		syy += dy * dy;
		sxy += dx * dy;
	}
	if (sxx === 0 || syy === 0) return null;  // constant column
	return sxy / Math.sqrt(sxx * syy);
}

function spearmanR(xs: number[], ys: number[]): number | null {
	// Spearman = Pearson on rank-transformed values. Uses fractional
	// (average) ranks for ties so the result remains consistent with
	// the standard definition.
	const xRanks = ranks(xs);
	const yRanks = ranks(ys);
	return pearsonR(xRanks, yRanks);
}

function ranks(values: number[]): number[] {
	const n = values.length;
	// Build (value, originalIndex) pairs, sort by value, assign ranks
	// with average-rank tie handling (Brown 1988 method).
	const idx = values.map((v, i) => ({ v, i }));
	idx.sort((a, b) => a.v - b.v);
	const out = new Array<number>(n);
	let i = 0;
	while (i < n) {
		let j = i;
		while (j + 1 < n && idx[j + 1]!.v === idx[i]!.v) j++;
		const avgRank = (i + j) / 2 + 1;  // 1-based average rank
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

function describe(pairs: readonly PairResult[], colCount: number): string {
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

async function resolveNumericColumns(
	input: CorrelationInput,
	deps: SkillDeps,
	callBase: string,
): Promise<readonly string[] | string> {
	if (input.columns !== undefined && input.columns.length > 0) return input.columns;

	const describe = await deps.runTool({
		id: `${callBase}-desc`,
		name: 'db_sql_describe',
		input: { connectionId: input.connectionId, target: input.target },
	});
	if (describe.isError) {
		return `db_sql_describe error: ${describe.content.slice(0, 200)}`;
	}
	const data = describe.data;
	if (typeof data !== 'object' || data === null || !Array.isArray((data as { columns?: unknown }).columns)) {
		return 'db_sql_describe returned a result without the expected structured data shape';
	}
	const cols = (data as { columns: { name: string; type?: string }[] }).columns;
	const numeric = cols
		.filter(c => typeof c.name === 'string' && c.name.length > 0)
		.filter(c => isNumericType(c.type ?? ''))
		.map(c => c.name);
	if (numeric.length === 0) return `target '${input.target}' has no numeric columns`;
	return numeric;
}

function isNumericType(declaredType: string): boolean {
	const lower = declaredType.toLowerCase();
	return NUMERIC_TYPE_TOKENS.some(tok => lower.includes(tok));
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

function clampSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return SAMPLE_DEFAULT;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

function empty(target: string): CorrelationOutput {
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

// Mark the SkillToolResult import as used (it isn't directly here but
// the type is part of the public skill surface via SkillDeps).
void (null as unknown as SkillToolResult);

export function registerDataCorrelationNumericPairwiseRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
