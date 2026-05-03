/**
 * data.cardinality.join-key.rdbms -- Phase 5c.5 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic dependency skill: classifies the relationship between
 * two RDBMS columns (typically a foreign-key edge) as 1:1 / 1:N /
 * N:1 / N:M, plus an orphan-count estimate for the FK side.
 *
 * Both targets must live on the same connection. The skill makes
 * four parallel tool calls (aggregate + distinct on each side) and
 * derives:
 *
 *   - leftDistinct vs leftTotal -> "is left side unique?"
 *   - rightDistinct vs rightTotal -> "is right side unique?"
 *   - the four combinations classify into 1:1 / 1:N / N:1 / N:M.
 *
 * Orphan detection. We pull up to 1000 distinct values from each
 * side via `db_sql_distinct`, build a Set from the right's values,
 * then check each left value against it. Values present on the
 * left but absent from the right's distinct set are flagged as
 * orphans (FK references that don't resolve).
 *
 * **Limitations:**
 * - If either column has > 1000 distinct values, we miss some.
 *   The output's `valueSetTruncated` field surfaces this case;
 *   the orphan count is then a *lower bound* rather than an exact
 *   figure.
 * - Cross-connection joins are out of scope (would need a federated
 *   query layer).
 *
 * Use cases: ER diagram generation (downstream `synth.er-diagram`
 * consumes this), drift detection (FK orphans signal data issues),
 * and answering "is this really a one-to-many relationship?".
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult, SkillToolResult } from '../types.js';

const DEFAULT_TOP_N = 1000;
const ORPHAN_EXAMPLES = 5;

interface JoinKeyInput {
	readonly connectionId: string;
	readonly leftTarget: string;
	readonly leftColumn: string;
	readonly rightTarget: string;
	readonly rightColumn: string;
	readonly topN?: number;
}

interface SideStats {
	readonly target: string;
	readonly column: string;
	readonly totalRows: number | null;
	readonly nonNullCount: number | null;
	readonly distinctCount: number | null;
	readonly isUnique: boolean | null;
}

interface OrphanEstimate {
	readonly examined: number;        // distinct left values we could compare
	readonly orphanCount: number;     // distinct left values absent from right's distinct set
	readonly orphanRate: number | null;  // orphanCount / examined
	readonly examples: readonly unknown[];  // up to 5 orphan values
	readonly valueSetTruncated: boolean;  // true when topN cap bit either side
}

type Cardinality = '1:1' | '1:N' | 'N:1' | 'N:M' | 'unknown';

interface JoinKeyOutput {
	readonly left: SideStats;
	readonly right: SideStats;
	readonly cardinality: Cardinality;
	readonly leftFanOut: number | null;   // leftTotal / leftDistinct (avg references per distinct value)
	readonly rightFanOut: number | null;
	readonly orphans: OrphanEstimate;
}

const SIDE_SCHEMA = {
	type: 'object',
	properties: {
		target:        { type: 'string' },
		column:        { type: 'string' },
		totalRows:     { type: ['number', 'null'] },
		nonNullCount:  { type: ['number', 'null'] },
		distinctCount: { type: ['number', 'null'] },
		isUnique:      { type: ['boolean', 'null'] },
	},
	required: ['target', 'column', 'totalRows', 'nonNullCount', 'distinctCount', 'isUnique'],
	additionalProperties: false,
} as const;

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<JoinKeyInput, JoinKeyOutput> = {
	id: 'data.cardinality.join-key.rdbms',
	name: 'Cardinality: join-key relationship (RDBMS)',
	description:
		'Classify the relationship between two RDBMS columns (1:1 / 1:N / N:1 / N:M) and estimate orphans. ' +
		'Both columns must be on the same connection. Uses 4 parallel tool calls (aggregate + distinct on ' +
		'each side); orphan detection compares up to 1000 distinct values per side. Limitations: cross- ' +
		'connection joins out of scope; columns with > 1000 distinct values produce lower-bound orphan counts.',
	family: 'dependency',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			leftTarget:   { type: 'string', description: 'FK side (typically the referencing table).' },
			leftColumn:   { type: 'string' },
			rightTarget:  { type: 'string', description: 'PK side (typically the referenced table).' },
			rightColumn:  { type: 'string' },
			topN:         { type: 'integer', minimum: 1, maximum: 1000, description: 'Default 1000.' },
		},
		required: ['connectionId', 'leftTarget', 'leftColumn', 'rightTarget', 'rightColumn'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			left:         SIDE_SCHEMA,
			right:        SIDE_SCHEMA,
			cardinality:  { type: 'string', enum: ['1:1', '1:N', 'N:1', 'N:M', 'unknown'] },
			leftFanOut:   { type: ['number', 'null'] },
			rightFanOut:  { type: ['number', 'null'] },
			orphans: {
				type: 'object',
				properties: {
					examined:          { type: 'number' },
					orphanCount:       { type: 'number' },
					orphanRate:        { type: ['number', 'null'] },
					examples:          { type: 'array' },
					valueSetTruncated: { type: 'boolean' },
				},
				required: ['examined', 'orphanCount', 'orphanRate', 'examples', 'valueSetTruncated'],
				additionalProperties: false,
			},
		},
		required: ['left', 'right', 'cardinality', 'leftFanOut', 'rightFanOut', 'orphans'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_aggregate', 'db_sql_distinct'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate', 'db_sql_distinct'],
			reason: 'aggregate gives totals; distinct gives the value sets we compare for orphans',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<JoinKeyOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const topN = clampTopN(input.topN);

		const aggArgs = (target: string, column: string) => ({
			connectionId: input.connectionId,
			target,
			aggregations: [
				{ column: '*',     function: 'count' },
				{ column,          function: 'count_non_null' },
				{ column,          function: 'distinct_count' },
			],
		});
		const distArgs = (target: string, column: string) => ({
			connectionId: input.connectionId,
			target,
			column,
			topN,
		});

		const [leftAgg, leftDist, rightAgg, rightDist] = await Promise.all([
			deps.runTool({ id: `${callBase}-laa`, name: 'db_sql_aggregate', input: aggArgs(input.leftTarget, input.leftColumn) }),
			deps.runTool({ id: `${callBase}-ldd`, name: 'db_sql_distinct',  input: distArgs(input.leftTarget, input.leftColumn) }),
			deps.runTool({ id: `${callBase}-raa`, name: 'db_sql_aggregate', input: aggArgs(input.rightTarget, input.rightColumn) }),
			deps.runTool({ id: `${callBase}-rdd`, name: 'db_sql_distinct',  input: distArgs(input.rightTarget, input.rightColumn) }),
		]);

		const errors = collectToolErrors([
			['db_sql_aggregate (left)',  leftAgg],
			['db_sql_distinct (left)',   leftDist],
			['db_sql_aggregate (right)', rightAgg],
			['db_sql_distinct (right)',  rightDist],
		]);
		if (errors.length > 0) {
			return {
				value: emptyOut(input),
				confidence: 'low',
				notes: errors,
				toolCalls: [],
			};
		}

		const leftAggData = leftAgg.data;
		const leftDistData = leftDist.data;
		const rightAggData = rightAgg.data;
		const rightDistData = rightDist.data;
		if (!isAggregateResult(leftAggData) || !isAggregateResult(rightAggData)
		    || !isDistinctResult(leftDistData) || !isDistinctResult(rightDistData)) {
			return {
				value: emptyOut(input),
				confidence: 'low',
				notes: ['cardinality.join-key: one or more tool results were missing the structured data shape'],
				toolCalls: [],
			};
		}

		const left  = sideStats(input.leftTarget,  input.leftColumn,  leftAggData, leftDistData);
		const right = sideStats(input.rightTarget, input.rightColumn, rightAggData, rightDistData);

		const cardinality = classify(left.isUnique, right.isUnique);
		const leftFanOut  = (left.nonNullCount  !== null && left.distinctCount  !== null && left.distinctCount  > 0)
			? left.nonNullCount  / left.distinctCount  : null;
		const rightFanOut = (right.nonNullCount !== null && right.distinctCount !== null && right.distinctCount > 0)
			? right.nonNullCount / right.distinctCount : null;

		// Orphan detection: left values not in right's distinct set.
		// Both sides may be truncated (topN < distinctCount); flag it.
		const leftTrunc  = left.distinctCount  !== null && leftDistData.topValues.length  < left.distinctCount;
		const rightTrunc = right.distinctCount !== null && rightDistData.topValues.length < right.distinctCount;
		const valueSetTruncated = leftTrunc || rightTrunc;

		const rightSet = new Set(rightDistData.topValues.map(v => canonical(v.value)));
		const examined = leftDistData.topValues.length;
		const orphanExamples: unknown[] = [];
		let orphanCount = 0;
		for (const tv of leftDistData.topValues) {
			if (!rightSet.has(canonical(tv.value))) {
				orphanCount++;
				if (orphanExamples.length < ORPHAN_EXAMPLES) orphanExamples.push(tv.value);
			}
		}
		const orphanRate = examined > 0 ? orphanCount / examined : null;

		return {
			value: {
				left,
				right,
				cardinality,
				leftFanOut,
				rightFanOut,
				orphans: {
					examined,
					orphanCount,
					orphanRate,
					examples: orphanExamples,
					valueSetTruncated,
				},
			},
			// `high` when both sides returned counts and we did at
			// least one orphan comparison. `medium` when totals came
			// back but orphan comparison was empty (sample of one side
			// was zero). `low` already handled above.
			confidence: left.totalRows !== null && right.totalRows !== null && examined > 0 ? 'high' : 'medium',
			...(valueSetTruncated ? {
				notes: [
					`distinct value set truncated at topN=${topN}; orphan count is a lower bound. ` +
					`Pass a larger topN if either column has many distinct values.`,
				],
			} : {}),
			toolCalls: [],
		};
	},
};

function classify(leftUnique: boolean | null, rightUnique: boolean | null): Cardinality {
	if (leftUnique === null || rightUnique === null) return 'unknown';
	if (leftUnique && rightUnique)  return '1:1';
	if (leftUnique && !rightUnique) return '1:N';
	if (!leftUnique && rightUnique) return 'N:1';
	return 'N:M';
}

function sideStats(
	target: string,
	column: string,
	agg: AggregateResultRaw,
	dist: DistinctResultRaw,
): SideStats {
	const totalRows    = agg.values['*__count']                  ?? null;
	const nonNullCount = agg.values[`${column}__count_non_null`] ?? null;
	const distinctCount = dist.distinctCount;
	const isUnique = (totalRows !== null && totalRows > 0 && distinctCount === totalRows) ? true
		: (totalRows !== null && totalRows > 0 && distinctCount !== null && distinctCount < totalRows) ? false
		: null;
	return { target, column, totalRows, nonNullCount, distinctCount, isUnique };
}

function clampTopN(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_TOP_N;
	return Math.min(Math.max(1, Math.floor(n)), DEFAULT_TOP_N);
}

function canonical(v: unknown): string {
	if (v === null || v === undefined) return ' NULL ';
	if (typeof v === 'string') return `s:${v}`;
	if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return `p:${String(v)}`;
	try { return `o:${JSON.stringify(v)}`; }
	catch { return `o:${String(v)}`; }
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

function emptyOut(input: JoinKeyInput): JoinKeyOutput {
	return {
		left:  { target: input.leftTarget,  column: input.leftColumn,  totalRows: null, nonNullCount: null, distinctCount: null, isUnique: null },
		right: { target: input.rightTarget, column: input.rightColumn, totalRows: null, nonNullCount: null, distinctCount: null, isUnique: null },
		cardinality: 'unknown',
		leftFanOut: null,
		rightFanOut: null,
		orphans: { examined: 0, orphanCount: 0, orphanRate: null, examples: [], valueSetTruncated: false },
	};
}

interface AggregateResultRaw {
	readonly target: string;
	readonly values: Readonly<Record<string, number | null>>;
}

interface DistinctResultRaw {
	readonly target: string;
	readonly column: string;
	readonly distinctCount: number;
	readonly topValues: readonly { value: unknown; count: number }[];
}

function isAggregateResult(v: unknown): v is AggregateResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && typeof o['values'] === 'object' && o['values'] !== null;
}

function isDistinctResult(v: unknown): v is DistinctResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['column'] === 'string'
		&& typeof o['distinctCount'] === 'number'
		&& Array.isArray(o['topValues']);
}

export function registerDataCardinalityJoinKeyRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
