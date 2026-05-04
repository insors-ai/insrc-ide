/**
 * data.distribution.outliers-zscore.rdbms -- Phase 5b.3 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper over the shared zscore algo.
 * The `.file` sibling at `data.distribution.outliers-zscore.file`
 * shares the same algo module.
 *
 * Z-score outlier detection is parametric -- assumes roughly normal
 * data; for skewed columns prefer the IQR (5b.2) or MAD (5b.4)
 * variants.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';
import {
	type OutliersZScoreOutput,
	OUTLIERS_ZSCORE_OUTPUT_SCHEMA,
	buildOutliersZScore,
	clampZScoreThreshold,
	emptyOutliersZScore,
	outliersZScoreAggregationsFor,
} from './data.distribution.outliers-zscore.algo.js';
import {
	clampSampleSize,
	collectToolErrors,
	isAggregateResult,
	isSampleResult,
} from './data.distribution.outliers-iqr.algo.js';

interface OutliersZScoreInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly threshold?: number;
	readonly sampleSize?: number;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<OutliersZScoreInput, OutliersZScoreOutput> = {
	id: 'data.distribution.outliers-zscore.rdbms',
	name: 'Distribution: Z-score outliers (RDBMS)',
	description:
		'Z-score outlier detection on a numeric column. Bounds = mean ± threshold·stddev. Default threshold ' +
		'3.0. Parametric -- assumes roughly normal data; pair with profile.numeric.rdbms to check before ' +
		'using on skewed columns.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			threshold:    { type: 'number', minimum: 0.5, maximum: 10 },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: OUTLIERS_ZSCORE_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_aggregate', 'db_sql_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_aggregate', 'db_sql_sample'], reason: 'aggregate gives mean/stddev; sample gives examples' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<OutliersZScoreOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const threshold = clampZScoreThreshold(input.threshold);
		const sampleSize = clampSampleSize(input.sampleSize);

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({
				id: `${callBase}-agg`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: outliersZScoreAggregationsFor(input.column),
				},
			}),
			deps.runTool({
				id: `${callBase}-sample`,
				name: 'db_sql_sample',
				input: { connectionId: input.connectionId, target: input.target, limit: sampleSize },
			}),
		]);

		const errors = collectToolErrors([['db_sql_aggregate', aggTool], ['db_sql_sample', sampleTool]]);
		if (errors.length > 0) {
			return { value: emptyOutliersZScore(input.target, input.column, threshold), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isSampleResult(sampleTool.data)) {
			return {
				value: emptyOutliersZScore(input.target, input.column, threshold),
				confidence: 'low',
				notes: ['outliers-zscore: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const out = buildOutliersZScore(
			aggTool.data.target,
			input.column,
			threshold,
			aggTool.data.values,
			{ columns: sampleTool.data.columns, rows: sampleTool.data.rows },
		);
		return {
			value: out,
			confidence: out.lowerBound !== null && out.upperBound !== null && out.sampleSize > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

export function registerDataDistributionOutliersZScoreRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
