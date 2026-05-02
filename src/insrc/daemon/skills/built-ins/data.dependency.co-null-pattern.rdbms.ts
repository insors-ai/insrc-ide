/**
 * data.dependency.co-null-pattern.rdbms -- Phase 5c.4 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic dependency skill: pairwise null co-occurrence over the
 * sampled rows of a target table. For each pair of columns
 * (A, B) we compute four buckets:
 *
 *   bothNull       -- rows where A IS NULL AND B IS NULL
 *   aNullOnly      -- rows where A IS NULL AND B IS NOT NULL
 *   bNullOnly      -- rows where A IS NOT NULL AND B IS NULL
 *   neitherNull    -- rows where A IS NOT NULL AND B IS NOT NULL
 *
 * Plus two derived metrics:
 *
 *   jointNullRate       -- bothNull / sampleSize
 *   jaccardSimilarity   -- bothNull / (bothNull + aNullOnly + bNullOnly)
 *                          ratio of "rows where both are null" to "rows
 *                          where at least one is null". 1.0 means columns
 *                          are perfectly co-null; 0.0 means their null
 *                          sets are disjoint.
 *
 * **Why sample-based.** A precise full-table answer needs SQL of
 * the shape `COUNT(CASE WHEN A IS NULL AND B IS NULL THEN 1 END)`,
 * which the current `db_sql_aggregate` doesn't expose. Sampling 50
 * rows is the v1 compromise -- the result documents this via
 * `sampleSize` and `samplingMethod`. Caller is expected to read
 * the metric as a *signal*, not a guarantee, until conditional
 * counts ship.
 *
 * Use cases:
 *   - Finding optional column groups (e.g. shipping_address1,
 *     shipping_address2, shipping_zip all fill together).
 *   - Detecting polymorphic relationships (only one of N
 *     foreign-key columns is non-null per row).
 *   - Spotting data-quality cliffs (everything past column X is
 *     null, suggesting a partial migration).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

const COL_CAP = 15;       // pairs grow O(n^2); 15 cols = 105 pairs
const PAIR_OUTPUT_CAP = 50;

interface CoNullInput {
	readonly connectionId: string;
	readonly target: string;
	readonly columns?: readonly string[];
	readonly sampleSize?: number;
}

interface CoNullPair {
	readonly columnA: string;
	readonly columnB: string;
	readonly bothNull: number;
	readonly aNullOnly: number;
	readonly bNullOnly: number;
	readonly neitherNull: number;
	readonly jointNullRate: number;
	readonly jaccardSimilarity: number | null;  // null when neither column has any null in sample
}

interface CoNullOutput {
	readonly target: string;
	readonly sampleSize: number;
	readonly columns: readonly string[];
	readonly pairs: readonly CoNullPair[];
	readonly truncated: boolean;
}

const PAIR_SCHEMA = {
	type: 'object',
	properties: {
		columnA:           { type: 'string' },
		columnB:           { type: 'string' },
		bothNull:          { type: 'number' },
		aNullOnly:         { type: 'number' },
		bNullOnly:         { type: 'number' },
		neitherNull:       { type: 'number' },
		jointNullRate:     { type: 'number' },
		jaccardSimilarity: { type: ['number', 'null'] },
	},
	required: ['columnA', 'columnB', 'bothNull', 'aNullOnly', 'bNullOnly',
	           'neitherNull', 'jointNullRate', 'jaccardSimilarity'],
	additionalProperties: false,
} as const;

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<CoNullInput, CoNullOutput> = {
	id: 'data.dependency.co-null-pattern.rdbms',
	name: 'Dependency: pairwise null co-occurrence (RDBMS)',
	description:
		'Pairwise null co-occurrence analysis over a 50-row sample. For each column pair, returns the four ' +
		'co-null bucket counts plus jointNullRate and jaccardSimilarity (1.0 = always null together; ' +
		'0.0 = disjoint null sets). Sample-based -- precise full-table counts need a conditional-count ' +
		'aggregate not yet shipped. Cap: 15 columns / 105 pairs per call; pass explicit `columns` to slice.',
	family: 'dependency',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			columns:      { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 15 },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId', 'target'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:     { type: 'string' },
			sampleSize: { type: 'number' },
			columns:    { type: 'array', items: { type: 'string' } },
			pairs:      { type: 'array', items: PAIR_SCHEMA },
			truncated:  { type: 'boolean' },
		},
		required: ['target', 'sampleSize', 'columns', 'pairs', 'truncated'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_describe', 'db_sql_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_describe', 'db_sql_sample'],
			reason: 'describe gives the column list; sample gives the rows we partition by null pattern',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<CoNullOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampSample(input.sampleSize);
		const notes: string[] = [];

		const cols = await resolveColumns(input, deps, callBase);
		if (typeof cols === 'string') {
			return { value: empty(input.target), confidence: 'low', notes: [cols], toolCalls: [] };
		}
		if (cols.length < 2) {
			return {
				value: { target: input.target, sampleSize: 0, columns: cols, pairs: [], truncated: false },
				confidence: 'medium',
				notes: ['co-null-pattern needs at least 2 columns; nothing to compare'],
				toolCalls: [],
			};
		}

		const truncated = cols.length > COL_CAP;
		const usedCols = truncated ? cols.slice(0, COL_CAP) : cols;
		if (truncated) {
			notes.push(
				`co-null-pattern truncated: ${cols.length} columns -> profiling first ${COL_CAP}. ` +
				`Pass explicit \`columns\` to profile a different slice.`,
			);
		}

		const sampleResult = await deps.runTool({
			id: `${callBase}-sample`,
			name: 'db_sql_sample',
			input: { connectionId: input.connectionId, target: input.target, limit: sampleSize },
		});
		if (sampleResult.isError) {
			return {
				value: empty(input.target),
				confidence: 'low',
				notes: [...notes, `db_sql_sample error: ${sampleResult.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		const sampleData = sampleResult.data;
		if (!isSampleResult(sampleData)) {
			return {
				value: empty(input.target),
				confidence: 'low',
				notes: [...notes, 'db_sql_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		// Filter columns to those present in the sample.
		const presentCols = usedCols.filter(c => sampleData.columns.includes(c));
		if (presentCols.length < 2) {
			return {
				value: { target: sampleData.target, sampleSize: sampleData.rows.length, columns: presentCols, pairs: [], truncated },
				confidence: 'medium',
				notes: [...notes, `co-null-pattern: < 2 of the requested columns present in sample (have: ${sampleData.columns.join(', ')})`],
				toolCalls: [],
			};
		}

		// Build a per-column null-bitmap over the sample for fast pair scoring.
		const nullBitmap = new Map<string, boolean[]>();
		for (const c of presentCols) {
			const bits: boolean[] = [];
			for (const row of sampleData.rows) {
				const v = row[c];
				bits.push(v === null || v === undefined);
			}
			nullBitmap.set(c, bits);
		}
		const nRows = sampleData.rows.length;

		const pairs: CoNullPair[] = [];
		for (let i = 0; i < presentCols.length; i++) {
			for (let j = i + 1; j < presentCols.length; j++) {
				const a = presentCols[i]!;
				const b = presentCols[j]!;
				const aBits = nullBitmap.get(a)!;
				const bBits = nullBitmap.get(b)!;
				let bothNull = 0, aNullOnly = 0, bNullOnly = 0, neitherNull = 0;
				for (let k = 0; k < nRows; k++) {
					const aN = aBits[k]!;
					const bN = bBits[k]!;
					if (aN && bN) bothNull++;
					else if (aN) aNullOnly++;
					else if (bN) bNullOnly++;
					else neitherNull++;
				}
				const union = bothNull + aNullOnly + bNullOnly;
				const jaccardSimilarity = union > 0 ? bothNull / union : null;
				pairs.push({
					columnA: a,
					columnB: b,
					bothNull, aNullOnly, bNullOnly, neitherNull,
					jointNullRate: nRows > 0 ? bothNull / nRows : 0,
					jaccardSimilarity,
				});
			}
		}

		// Sort by jaccardSimilarity desc, then bothNull desc, then by
		// column names for stable output. Pairs with null jaccard
		// (no nulls in either column) sink to the bottom -- they're
		// the least informative.
		pairs.sort((a, b) => {
			const aJ = a.jaccardSimilarity ?? -1;
			const bJ = b.jaccardSimilarity ?? -1;
			if (aJ !== bJ) return bJ - aJ;
			if (a.bothNull !== b.bothNull) return b.bothNull - a.bothNull;
			const ab = `${a.columnA}|${a.columnB}`;
			const bb = `${b.columnA}|${b.columnB}`;
			return ab.localeCompare(bb);
		});
		const cappedPairs = pairs.length > PAIR_OUTPUT_CAP ? pairs.slice(0, PAIR_OUTPUT_CAP) : pairs;
		if (pairs.length > PAIR_OUTPUT_CAP) {
			notes.push(`co-null-pattern: ${pairs.length} pairs computed; output capped at ${PAIR_OUTPUT_CAP} top-jaccard rows`);
		}

		// Confidence calibration. `high` when at least one pair had
		// any null observation in the sample (we have signal).
		// `medium` when no nulls were sampled (the table may be dense
		// for these columns) -- the answer is a real "no co-null
		// pattern detected" but conclusions about rare nulls are
		// limited by sample size.
		const anyNull = pairs.some(p => p.bothNull > 0 || p.aNullOnly > 0 || p.bNullOnly > 0);
		return {
			value: {
				target: sampleData.target,
				sampleSize: nRows,
				columns: presentCols,
				pairs: cappedPairs,
				truncated,
			},
			confidence: anyNull ? 'high' : 'medium',
			...(notes.length > 0 ? { notes } : {}),
			toolCalls: [],
		};
	},
};

function clampSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 50;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

async function resolveColumns(
	input: CoNullInput,
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
	if (typeof data !== 'object' || data === null || !Array.isArray((data as { columns: unknown }).columns)) {
		return 'db_sql_describe returned a result without the expected structured data shape';
	}
	const cols = (data as { columns: { name: string }[] }).columns
		.map(c => c.name)
		.filter(n => typeof n === 'string' && n.length > 0);
	if (cols.length === 0) return `target '${input.target}' has no columns`;
	return cols;
}

function empty(target: string): CoNullOutput {
	return { target, sampleSize: 0, columns: [], pairs: [], truncated: false };
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

export function registerDataDependencyCoNullPatternRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
