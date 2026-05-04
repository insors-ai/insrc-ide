/**
 * data.correlation.categorical-pairwise.rdbms -- Phase 5c.2 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper over the shared categorical-
 * correlation algo. The `.file` sibling shares the algo module.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import {
	type CorrelationCatOutput,
	CORR_CAT_MAX_COLUMNS,
	CORRELATION_CAT_OUTPUT_SCHEMA,
	buildCorrelationCatOutput,
	clampCorrCatSample,
	clampMaxDistinct,
	emptyCorrelationCatOutput,
	filterByCardinality,
	pickCategoricalColumns,
} from './data.correlation.categorical-pairwise.algo.js';
import {
	isCorrelationSampleResult,
	isDescribeResult,
} from './data.correlation.numeric-pairwise.algo.js';

interface CorrelationCatInput {
	readonly connectionId: string;
	readonly target: string;
	readonly columns?: readonly string[];
	readonly sampleSize?: number;
	readonly maxDistinctPerColumn?: number;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<CorrelationCatInput, CorrelationCatOutput> = {
	id: 'data.correlation.categorical-pairwise.rdbms',
	name: 'Correlation: categorical pairwise (RDBMS)',
	description: 'Pairwise Cramér\'s V across categorical / low-cardinality columns over a 50-row sample. Cap 15 columns / 105 unordered pairs. Drops high-cardinality columns (>25 distinct values).',
	family: 'dependency',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId:         { type: 'string' },
			target:               { type: 'string' },
			columns:              { type: 'array', items: { type: 'string' } },
			sampleSize:           { type: 'integer', minimum: 1, maximum: 50 },
			maxDistinctPerColumn: { type: 'integer', minimum: 2, maximum: 50 },
		},
		required: ['connectionId', 'target'],
		additionalProperties: false,
	},
	outputs: CORRELATION_CAT_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_describe', 'db_sql_sample'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_describe', 'db_sql_sample'], reason: 'describe gives the categorical column list; sample gives the rows we tabulate' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<CorrelationCatOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampCorrCatSample(input.sampleSize);
		const maxDistinct = clampMaxDistinct(input.maxDistinctPerColumn);

		const colsOrErr = await resolveColumns(input, deps, callBase);
		if (typeof colsOrErr === 'string') {
			return { value: emptyCorrelationCatOutput(input.target), confidence: 'low', notes: [colsOrErr], toolCalls: [] };
		}

		const sampleTool = await deps.runTool({
			id: `${callBase}-sample`,
			name: 'db_sql_sample',
			input: { connectionId: input.connectionId, target: input.target, limit: sampleSize },
		});
		if (sampleTool.isError) {
			return { value: emptyCorrelationCatOutput(input.target), confidence: 'low', notes: [`db_sql_sample error: ${sampleTool.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isCorrelationSampleResult(sampleTool.data)) {
			return {
				value: emptyCorrelationCatOutput(input.target),
				confidence: 'low',
				notes: ['db_sql_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}
		const rows = sampleTool.data.rows;

		const { evaluatedColumns: filtered, droppedHighCardinality } = filterByCardinality(colsOrErr, rows, maxDistinct);
		const truncatedColumns = filtered.length > CORR_CAT_MAX_COLUMNS;
		const evaluatedColumns = filtered.slice(0, CORR_CAT_MAX_COLUMNS);
		if (evaluatedColumns.length < 2) {
			return {
				value: {
					...emptyCorrelationCatOutput(input.target),
					sampleSize: rows.length,
					evaluatedColumns,
					droppedHighCardinality,
					interpretation: `need >= 2 categorical columns (post-cardinality filter) to compute V; found ${evaluatedColumns.length}. Dropped ${droppedHighCardinality.length} high-cardinality column(s).`,
				},
				confidence: 'medium',
				toolCalls: [],
			};
		}

		return {
			value: buildCorrelationCatOutput(sampleTool.data.target, evaluatedColumns, droppedHighCardinality, truncatedColumns, rows),
			confidence: 'high',
			toolCalls: [],
		};
	},
};

async function resolveColumns(input: CorrelationCatInput, deps: SkillDeps, callBase: string): Promise<readonly string[] | string> {
	if (input.columns !== undefined && input.columns.length > 0) return input.columns;
	const describe = await deps.runTool({ id: `${callBase}-desc`, name: 'db_sql_describe', input: { connectionId: input.connectionId, target: input.target } });
	if (describe.isError) return `db_sql_describe error: ${describe.content.slice(0, 200)}`;
	if (!isDescribeResult(describe.data)) return 'db_sql_describe returned a result without the expected structured data shape';
	const categorical = pickCategoricalColumns(describe.data.columns);
	if (categorical.length === 0) return `target '${input.target}' has no categorical columns`;
	return categorical;
}

export function registerDataCorrelationCategoricalPairwiseRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
