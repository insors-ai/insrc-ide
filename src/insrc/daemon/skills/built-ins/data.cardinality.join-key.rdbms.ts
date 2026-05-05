/**
 * data.cardinality.join-key.rdbms -- Phase 5c.5 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic dependency skill: classifies the relationship between
 * two RDBMS columns (typically a foreign-key edge) as 1:1 / 1:N /
 * N:1 / N:M, plus an exact orphan count for the FK side.
 *
 * Both targets must live on the same connection. Three round-trips
 * in parallel:
 *   - aggregate(left): count(*) / count_non_null / distinct_count
 *   - aggregate(right): same
 *   - anti-join: exact orphan count (left values not in right) +
 *     up to 5 example orphans
 *
 * Cardinality classification:
 *   - leftDistinct == leftTotal (-> isUnique=true) vs not
 *   - rightDistinct == rightTotal (-> isUnique=true) vs not
 *   - the four combinations classify into 1:1 / 1:N / N:1 / N:M.
 *
 * Orphan detection is now exact: server-side `db_sql_anti_join` runs
 * `SELECT COUNT(*) FROM (SELECT DISTINCT left.col) WHERE NOT EXISTS
 * (SELECT 1 FROM right WHERE right.col = left.col)` -- no value-set
 * cap, no truncation.
 *
 * **Limitations:**
 * - Cross-connection joins are out of scope. The "left" and "right"
 *   targets must live on the same connection (a federated query
 *   layer would be a separate skill).
 *
 * Use cases: ER diagram generation (downstream `synth.er-diagram`
 * consumes this), drift detection (FK orphans signal data issues),
 * and answering "is this really a one-to-many relationship?".
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult, SkillToolResult } from '../types.js';

const ORPHAN_EXAMPLES = 5;

interface JoinKeyInput {
	readonly connectionId: string;
	readonly leftTarget: string;
	readonly leftColumn: string;
	readonly rightTarget: string;
	readonly rightColumn: string;
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
		'Classify the relationship between two RDBMS columns (1:1 / 1:N / N:1 / N:M) and count exact orphans. ' +
		'Both columns must be on the same connection. Three parallel tool calls: aggregate on each side ' +
		'(count + count_non_null + distinct_count) plus a server-side NOT EXISTS anti-join for the orphan ' +
		'count. No value-set cap; orphan count is the precise full-table answer.',
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
	toolDeps: ['db_sql_aggregate', 'db_sql_anti_join'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate', 'db_sql_anti_join'],
			reason: 'aggregate gives per-side totals + distinct counts; anti-join gives the exact orphan count',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<JoinKeyOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

		const aggArgs = (target: string, column: string) => ({
			connectionId: input.connectionId,
			target,
			aggregations: [
				{ column: '*',     function: 'count' },
				{ column,          function: 'count_non_null' },
				{ column,          function: 'distinct_count' },
			],
		});

		const [leftAgg, rightAgg, antiJoin] = await Promise.all([
			deps.runTool({ id: `${callBase}-laa`, name: 'db_sql_aggregate', input: aggArgs(input.leftTarget, input.leftColumn) }),
			deps.runTool({ id: `${callBase}-raa`, name: 'db_sql_aggregate', input: aggArgs(input.rightTarget, input.rightColumn) }),
			deps.runTool({
				id: `${callBase}-aj`,
				name: 'db_sql_anti_join',
				input: {
					connectionId: input.connectionId,
					leftTarget: input.leftTarget,
					leftColumn: input.leftColumn,
					rightTarget: input.rightTarget,
					rightColumn: input.rightColumn,
					exampleLimit: ORPHAN_EXAMPLES,
				},
			}),
		]);

		const errors = collectToolErrors([
			['db_sql_aggregate (left)',  leftAgg],
			['db_sql_aggregate (right)', rightAgg],
			['db_sql_anti_join',         antiJoin],
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
		const rightAggData = rightAgg.data;
		const antiJoinData = antiJoin.data;
		if (!isAggregateResult(leftAggData) || !isAggregateResult(rightAggData)
		    || !isAntiJoinResult(antiJoinData)) {
			return {
				value: emptyOut(input),
				confidence: 'low',
				notes: ['cardinality.join-key: one or more tool results were missing the structured data shape'],
				toolCalls: [],
			};
		}

		const left  = sideStats(input.leftTarget,  input.leftColumn,  leftAggData);
		const right = sideStats(input.rightTarget, input.rightColumn, rightAggData);

		const cardinality = classify(left.isUnique, right.isUnique);
		const leftFanOut  = (left.nonNullCount  !== null && left.distinctCount  !== null && left.distinctCount  > 0)
			? left.nonNullCount  / left.distinctCount  : null;
		const rightFanOut = (right.nonNullCount !== null && right.distinctCount !== null && right.distinctCount > 0)
			? right.nonNullCount / right.distinctCount : null;

		// Orphan detection: server-side anti-join. `examined` is now the
		// distinct-left-count (denominator the rate operates over);
		// `valueSetTruncated` is always false (the SQL has no cap).
		const examined = left.distinctCount ?? 0;
		const orphanCount = antiJoinData.orphanCount;
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
					examples: [...antiJoinData.examples],
					valueSetTruncated: false,
				},
			},
			confidence: left.totalRows !== null && right.totalRows !== null ? 'high' : 'medium',
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
): SideStats {
	const totalRows    = numericFromAgg(agg.values['*__count']);
	const nonNullCount = numericFromAgg(agg.values[`${column}__count_non_null`]);
	const distinctCount = numericFromAgg(agg.values[`${column}__distinct_count`]);
	const isUnique = (totalRows !== null && totalRows > 0 && distinctCount === totalRows) ? true
		: (totalRows !== null && totalRows > 0 && distinctCount !== null && distinctCount < totalRows) ? false
		: null;
	return { target, column, totalRows, nonNullCount, distinctCount, isUnique };
}

function numericFromAgg(v: number | string | null | undefined): number | null {
	if (v === null || v === undefined) return null;
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
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
	readonly values: Readonly<Record<string, number | string | null>>;
}

interface AntiJoinResultRaw {
	readonly leftTarget: string;
	readonly leftColumn: string;
	readonly rightTarget: string;
	readonly rightColumn: string;
	readonly orphanCount: number;
	readonly examples: readonly unknown[];
}

function isAggregateResult(v: unknown): v is AggregateResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && typeof o['values'] === 'object' && o['values'] !== null;
}

function isAntiJoinResult(v: unknown): v is AntiJoinResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['leftTarget'] === 'string'
		&& typeof o['rightTarget'] === 'string'
		&& typeof o['orphanCount'] === 'number'
		&& Array.isArray(o['examples']);
}

export function registerDataCardinalityJoinKeyRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
