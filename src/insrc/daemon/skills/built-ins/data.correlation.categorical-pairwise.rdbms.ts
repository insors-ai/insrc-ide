/**
 * data.correlation.categorical-pairwise.rdbms -- Phase 5c.2 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic dependency skill: computes pairwise Cramér's V over
 * categorical / low-cardinality columns. Cramér's V is the
 * categorical-variable analogue of Pearson's r -- range [0, 1],
 * 0 = independent, 1 = perfectly associated. Unlike Pearson it has
 * no sign (categorical association is undirected).
 *
 * Computed from the χ² statistic of the pair's contingency table:
 *   χ² = Σ (O_ij - E_ij)² / E_ij    where E_ij = (row_i * col_j) / n
 *   V  = sqrt(χ² / (n × min(rows-1, cols-1)))
 *
 * Pairs with `correlation.numeric-pairwise.rdbms` (5c.1) for the
 * analogous numeric flow. Together they cover the cross-column
 * association story; 5c.3 (functional dependency) and 5c.4 (co-null
 * pattern) catch the remaining cross-column relationships.
 *
 * Auto-discovery
 *   By declared SQL type: text / varchar / char / nvarchar /
 *   character / enum / bool / boolean. PLUS a cardinality filter --
 *   columns with > MAX_DISTINCT_PER_COL distinct values in the
 *   sample are dropped, since high-cardinality columns (user_id,
 *   uuid, email) trivially saturate Cramér's V toward 1 and aren't
 *   meaningful categories.
 *
 * v1 limits
 *   - Sample-based at n=50; precise full-table contingency tables
 *     would need a server-side `db_sql_groupby_two` tool not yet
 *     available. Sample is fine for exploratory "which categorical
 *     pairs are worth investigating".
 *   - Up to 15 columns / 105 unordered pairs per call.
 *   - Cardinality cap defaults to 25 distinct values per column
 *     (most "real" categories fit; ID-like columns get filtered).
 *   - No bias correction (Bergsma 2013); accuracy is fine for n=50
 *     and small tables.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

const SAMPLE_DEFAULT       = 50;
const MAX_COLUMNS          = 15;
const MIN_PAIR_OVERLAP     = 5;
const TOP_K_REPORTED       = 5;
const STRONG_THRESHOLD     = 0.7;
const MODERATE_THRESHOLD   = 0.4;
const WEAK_THRESHOLD       = 0.2;
const MAX_DISTINCT_PER_COL = 25;   // skip high-cardinality columns

const CATEGORICAL_TYPE_TOKENS = [
	'text', 'varchar', 'nvarchar', 'character', 'char',
	'string', 'enum', 'bool', 'boolean',
] as const;

interface CorrelationCatInput {
	readonly connectionId: string;
	readonly target: string;
	readonly columns?: readonly string[];
	readonly sampleSize?: number;
	readonly maxDistinctPerColumn?: number;   // override default of 25
}

type Classification = 'strong' | 'moderate' | 'weak' | 'none' | 'inconclusive';

interface PairResult {
	readonly columnA: string;
	readonly columnB: string;
	readonly overlapN: number;
	readonly cramerV: number | null;
	readonly chiSquared: number | null;
	readonly distinctA: number;
	readonly distinctB: number;
	readonly classification: Classification;
}

interface CorrelationCatOutput {
	readonly target: string;
	readonly sampleSize: number;
	readonly evaluatedColumns: readonly string[];
	readonly droppedHighCardinality: readonly string[];
	readonly truncatedColumns: boolean;
	readonly pairs: readonly PairResult[];
	readonly topAssociated: readonly PairResult[];
	readonly interpretation: string;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

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
	required: ['columnA', 'columnB', 'overlapN', 'cramerV', 'chiSquared',
	           'distinctA', 'distinctB', 'classification'],
	additionalProperties: false,
} as const;

const skill: Skill<CorrelationCatInput, CorrelationCatOutput> = {
	id: 'data.correlation.categorical-pairwise.rdbms',
	name: 'Correlation: categorical pairwise (RDBMS)',
	description:
		'Pairwise Cramér\'s V across categorical / low-cardinality columns over a 50-row sample. ' +
		'Auto-discovers categorical columns by type (text / varchar / char / enum / bool) AND drops ' +
		'high-cardinality columns (>25 distinct values, configurable) so ID-like columns don\'t ' +
		'saturate V trivially. Returns the full pair table sorted by V descending plus a top-5 ' +
		'shortlist. Sample-based; up to 15 columns / 105 unordered pairs per call.',
	family: 'dependency',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId:         { type: 'string' },
			target:               { type: 'string' },
			columns:              { type: 'array', items: { type: 'string' }, description: 'Explicit column pick; skips type + cardinality auto-discovery.' },
			sampleSize:           { type: 'integer', minimum: 1, maximum: 50 },
			maxDistinctPerColumn: { type: 'integer', minimum: 2, maximum: 50, description: 'Cardinality cap; default 25.' },
		},
		required: ['connectionId', 'target'],
		additionalProperties: false,
	},
	outputs: {
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
	},
	toolDeps: ['db_sql_describe', 'db_sql_sample'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_describe', 'db_sql_sample'],
			reason: 'describe gives the categorical column list; sample gives the rows we tabulate',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<CorrelationCatOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampSample(input.sampleSize);
		const maxDistinct = clampDistinct(input.maxDistinctPerColumn);

		const colsOrErr = await resolveCategoricalColumns(input, deps, callBase);
		if (typeof colsOrErr === 'string') {
			return { value: empty(input.target), confidence: 'low', notes: [colsOrErr], toolCalls: [] };
		}
		const candidateCols = colsOrErr;

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

		// Per-column cardinality filter: drop anything with > maxDistinct
		// distinct non-null values in the sample (ID-like columns).
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
		const evaluatedColumnsRaw: string[] = [];
		for (const col of candidateCols) {
			const distinct = distinctByCol.get(col)!.size;
			if (distinct > maxDistinct) droppedHighCardinality.push(col);
			else                        evaluatedColumnsRaw.push(col);
		}
		const truncatedColumns = evaluatedColumnsRaw.length > MAX_COLUMNS;
		const evaluatedColumns = evaluatedColumnsRaw.slice(0, MAX_COLUMNS);

		if (evaluatedColumns.length < 2) {
			return {
				value: {
					...empty(input.target),
					sampleSize: rows.length,
					evaluatedColumns,
					droppedHighCardinality,
					interpretation: `need >= 2 categorical columns (post-cardinality filter) to compute V; found ${evaluatedColumns.length}. Dropped ${droppedHighCardinality.length} high-cardinality column(s).`,
				},
				confidence: 'medium',
				toolCalls: [],
			};
		}

		const pairs: PairResult[] = [];
		for (let i = 0; i < evaluatedColumns.length; i++) {
			for (let j = i + 1; j < evaluatedColumns.length; j++) {
				pairs.push(computePair(evaluatedColumns[i]!, evaluatedColumns[j]!, rows));
			}
		}

		// Sort by V desc; nulls last.
		const sortedPairs = [...pairs].sort((a, b) => {
			const aV = a.cramerV ?? -1;
			const bV = b.cramerV ?? -1;
			return bV - aV;
		});
		const topAssociated = sortedPairs
			.filter(p => p.cramerV !== null && p.cramerV >= WEAK_THRESHOLD)
			.slice(0, TOP_K_REPORTED);
		const interpretation = describe(sortedPairs, evaluatedColumns.length, droppedHighCardinality.length);

		return {
			value: {
				target: sampleTool.data.target,
				sampleSize: rows.length,
				evaluatedColumns,
				droppedHighCardinality,
				truncatedColumns,
				pairs: sortedPairs,
				topAssociated,
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
	// Build the contingency table.
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

	if (n < MIN_PAIR_OVERLAP || distinctA < 2 || distinctB < 2) {
		return {
			columnA: colA, columnB: colB,
			overlapN: n,
			cramerV: null, chiSquared: null,
			distinctA, distinctB,
			classification: 'inconclusive',
		};
	}

	// Pearson chi-squared statistic.
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

	const classification = classify(cramerV);
	return {
		columnA: colA, columnB: colB,
		overlapN: n,
		cramerV, chiSquared,
		distinctA, distinctB,
		classification,
	};
}

function classify(v: number | null): Classification {
	if (v === null) return 'inconclusive';
	if (v >= STRONG_THRESHOLD)   return 'strong';
	if (v >= MODERATE_THRESHOLD) return 'moderate';
	if (v >= WEAK_THRESHOLD)     return 'weak';
	return 'none';
}

function describe(
	pairs: readonly PairResult[],
	colCount: number,
	dropped: number,
): string {
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

async function resolveCategoricalColumns(
	input: CorrelationCatInput,
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
	const categorical = cols
		.filter(c => typeof c.name === 'string' && c.name.length > 0)
		.filter(c => isCategoricalType(c.type ?? ''))
		.map(c => c.name);
	if (categorical.length === 0) return `target '${input.target}' has no categorical columns`;
	return categorical;
}

function isCategoricalType(declaredType: string): boolean {
	const lower = declaredType.toLowerCase();
	return CATEGORICAL_TYPE_TOKENS.some(tok => lower.includes(tok));
}

function stringifyCategory(raw: unknown): string {
	if (typeof raw === 'string')  return raw;
	if (typeof raw === 'boolean') return raw ? 'true' : 'false';
	if (typeof raw === 'number')  return String(raw);
	if (typeof raw === 'bigint')  return raw.toString();
	return JSON.stringify(raw);
}

function clampSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return SAMPLE_DEFAULT;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

function clampDistinct(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return MAX_DISTINCT_PER_COL;
	return Math.min(Math.max(2, Math.floor(n)), 50);
}

function empty(target: string): CorrelationCatOutput {
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

export function registerDataCorrelationCategoricalPairwiseRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
