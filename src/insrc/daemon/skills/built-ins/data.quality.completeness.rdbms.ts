/**
 * data.quality.completeness.rdbms -- Phase 5d.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper over the completeness algo.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import {
	type QualityCompletenessOutput,
	COMPLETENESS_COL_CAP,
	COMPLETENESS_OUTPUT_SCHEMA,
	buildCompleteness,
	completenessAggregationsFor,
	emptyCompleteness,
	isAggregateResult,
} from './data.quality.completeness.algo.js';
import { isDescribeResult } from './data.correlation.numeric-pairwise.algo.js';

interface QualityCompletenessInput {
	readonly connectionId: string;
	readonly target: string;
	readonly columns?: readonly string[];
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<QualityCompletenessInput, QualityCompletenessOutput> = {
	id: 'data.quality.completeness.rdbms',
	name: 'Quality: completeness (RDBMS)',
	description: 'Per-column null rate plus overall table null rate. Up to 31 columns per call.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			columns:      { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 31 },
		},
		required: ['connectionId', 'target'],
		additionalProperties: false,
	},
	outputs: COMPLETENESS_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_describe', 'db_sql_aggregate'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_describe', 'db_sql_aggregate'], reason: 'describe gives column list; aggregate gives counts' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<QualityCompletenessOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const notes: string[] = [];

		const cols = await resolveColumns(input, deps, callBase);
		if (typeof cols === 'string') {
			return { value: emptyCompleteness(input.target), confidence: 'low', notes: [cols], toolCalls: [] };
		}
		const truncated = cols.length > COMPLETENESS_COL_CAP;
		const usedCols = truncated ? cols.slice(0, COMPLETENESS_COL_CAP) : cols;
		if (truncated) notes.push(`completeness truncated: ${cols.length} columns -> profiling first ${COMPLETENESS_COL_CAP}.`);

		const aggResult = await deps.runTool({
			id: `${callBase}-agg`,
			name: 'db_sql_aggregate',
			input: {
				connectionId: input.connectionId,
				target: input.target,
				aggregations: completenessAggregationsFor(usedCols),
			},
		});
		if (aggResult.isError) {
			return { value: emptyCompleteness(input.target), confidence: 'low', notes: [...notes, `db_sql_aggregate error: ${aggResult.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isAggregateResult(aggResult.data)) {
			return {
				value: emptyCompleteness(input.target),
				confidence: 'low',
				notes: [...notes, 'db_sql_aggregate returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const out = buildCompleteness(aggResult.data.target, usedCols, truncated, aggResult.data.values);
		return {
			value: out,
			confidence: out.totalRows !== null && out.totalRows > 0 ? 'high' : 'medium',
			...(notes.length > 0 ? { notes } : {}),
			toolCalls: [],
		};
	},
};

async function resolveColumns(input: QualityCompletenessInput, deps: SkillDeps, callBase: string): Promise<readonly string[] | string> {
	if (input.columns !== undefined && input.columns.length > 0) return input.columns;
	const describe = await deps.runTool({ id: `${callBase}-desc`, name: 'db_sql_describe', input: { connectionId: input.connectionId, target: input.target } });
	if (describe.isError) return `db_sql_describe error: ${describe.content.slice(0, 200)}`;
	if (!isDescribeResult(describe.data)) return 'db_sql_describe returned a result without the expected structured data shape';
	const cols = describe.data.columns.map(c => c.name).filter(n => typeof n === 'string' && n.length > 0);
	if (cols.length === 0) return `target '${input.target}' has no columns`;
	return cols;
}

export function registerDataQualityCompletenessRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
