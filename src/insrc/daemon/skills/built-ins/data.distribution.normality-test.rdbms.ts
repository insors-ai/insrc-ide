/**
 * data.distribution.normality-test.rdbms -- Phase 5b.5 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper over the JB normality algo.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';
import {
	type NormalityTestOutput,
	NORMALITY_TEST_OUTPUT_SCHEMA,
	NORMALITY_TEST_SAMPLE_SIZE,
	buildNormalityTest,
	clampAlpha,
	emptyNormalityTest,
	normalityTestAggregationsFor,
} from './data.distribution.normality-test.algo.js';
import {
	collectToolErrors,
	isAggregateResult,
	isSampleResult,
} from './data.distribution.outliers-iqr.algo.js';

interface NormalityTestInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly sampleSize?: number;
	readonly alpha?: number;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<NormalityTestInput, NormalityTestOutput> = {
	id: 'data.distribution.normality-test.rdbms',
	name: 'Distribution: Jarque-Bera normality test (RDBMS)',
	description: 'Jarque-Bera normality test on a numeric column. JB statistic + p-value + verdict (normal / non-normal / inconclusive). Sample-based moments at n=50.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			sampleSize:   { type: 'integer', minimum: 50, maximum: 50 },
			alpha:        { type: 'number',  minimum: 0.001, maximum: 0.5 },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: NORMALITY_TEST_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_aggregate', 'db_sql_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_aggregate', 'db_sql_sample'], reason: 'aggregate gives mean/stddev; sample gives values for skewness + kurtosis' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<NormalityTestOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const alpha = clampAlpha(input.alpha);

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({
				id: `${callBase}-agg`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: normalityTestAggregationsFor(input.column),
				},
			}),
			deps.runTool({
				id: `${callBase}-sample`,
				name: 'db_sql_sample',
				input: { connectionId: input.connectionId, target: input.target, limit: NORMALITY_TEST_SAMPLE_SIZE },
			}),
		]);

		const errors = collectToolErrors([['db_sql_aggregate', aggTool], ['db_sql_sample', sampleTool]]);
		if (errors.length > 0) {
			return { value: emptyNormalityTest(input.target, input.column, alpha), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isSampleResult(sampleTool.data)) {
			return {
				value: emptyNormalityTest(input.target, input.column, alpha),
				confidence: 'low',
				notes: ['normality-test: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const out = buildNormalityTest(
			aggTool.data.target,
			input.column,
			alpha,
			aggTool.data.values,
			{ columns: sampleTool.data.columns, rows: sampleTool.data.rows },
		);
		return {
			value: out,
			confidence: out.verdict === 'inconclusive' ? 'medium' : 'high',
			toolCalls: [],
		};
	},
};

export function registerDataDistributionNormalityTestRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
