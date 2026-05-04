/**
 * data.correlation.numeric-pairwise.rdbms -- Phase 5c.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper over the shared correlation algo.
 * The `.file` sibling shares the algo module.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import {
	type CorrelationOutput,
	CORRELATION_MAX_COLUMNS,
	CORRELATION_OUTPUT_SCHEMA,
	buildCorrelationOutput,
	clampCorrelationSample,
	emptyCorrelationOutput,
	isCorrelationSampleResult,
	isDescribeResult,
	pickNumericColumns,
} from './data.correlation.numeric-pairwise.algo.js';

interface CorrelationInput {
	readonly connectionId: string;
	readonly target: string;
	readonly columns?: readonly string[];
	readonly sampleSize?: number;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<CorrelationInput, CorrelationOutput> = {
	id: 'data.correlation.numeric-pairwise.rdbms',
	name: 'Correlation: numeric pairwise (RDBMS)',
	description: 'Pairwise Pearson + Spearman correlation across numeric columns over a 50-row sample. Cap 15 columns / 105 unordered pairs.',
	family: 'dependency',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			columns:      { type: 'array', items: { type: 'string' } },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId', 'target'],
		additionalProperties: false,
	},
	outputs: CORRELATION_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_describe', 'db_sql_sample'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_describe', 'db_sql_sample'], reason: 'describe gives the numeric column list; sample gives the rows we correlate over' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<CorrelationOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampCorrelationSample(input.sampleSize);

		const colsOrErr = await resolveColumns(input, deps, callBase);
		if (typeof colsOrErr === 'string') {
			return { value: emptyCorrelationOutput(input.target), confidence: 'low', notes: [colsOrErr], toolCalls: [] };
		}
		const allCols = colsOrErr;
		const truncatedColumns = allCols.length > CORRELATION_MAX_COLUMNS;
		const evaluatedColumns = allCols.slice(0, CORRELATION_MAX_COLUMNS);
		if (evaluatedColumns.length < 2) {
			return {
				value: { ...emptyCorrelationOutput(input.target), evaluatedColumns, interpretation: `need >= 2 numeric columns to compute pairwise correlations; found ${evaluatedColumns.length}` },
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
			return { value: emptyCorrelationOutput(input.target), confidence: 'low', notes: [`db_sql_sample error: ${sampleTool.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isCorrelationSampleResult(sampleTool.data)) {
			return {
				value: emptyCorrelationOutput(input.target),
				confidence: 'low',
				notes: ['db_sql_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}
		return {
			value: buildCorrelationOutput(sampleTool.data.target, evaluatedColumns, truncatedColumns, sampleTool.data.rows),
			confidence: 'high',
			toolCalls: [],
		};
	},
};

async function resolveColumns(input: CorrelationInput, deps: SkillDeps, callBase: string): Promise<readonly string[] | string> {
	if (input.columns !== undefined && input.columns.length > 0) return input.columns;
	const describe = await deps.runTool({
		id: `${callBase}-desc`,
		name: 'db_sql_describe',
		input: { connectionId: input.connectionId, target: input.target },
	});
	if (describe.isError) return `db_sql_describe error: ${describe.content.slice(0, 200)}`;
	if (!isDescribeResult(describe.data)) {
		return 'db_sql_describe returned a result without the expected structured data shape';
	}
	const numeric = pickNumericColumns(describe.data.columns);
	if (numeric.length === 0) return `target '${input.target}' has no numeric columns`;
	return numeric;
}

export function registerDataCorrelationNumericPairwiseRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
