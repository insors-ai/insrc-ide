/**
 * data.distribution.heavy-tail-check.rdbms -- Phase 5b.6 of
 * plans/analyzers/data-analyzer-skills.md.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';
import {
	type HeavyTailOutput,
	HEAVY_TAIL_OUTPUT_SCHEMA,
	HEAVY_TAIL_SAMPLE_SIZE,
	buildHeavyTailCheck,
	clampHeavyTailThreshold,
	emptyHeavyTailCheck,
	heavyTailAggregationsFor,
} from './data.distribution.heavy-tail-check.algo.js';
import {
	collectToolErrors,
	isAggregateResult,
	isSampleResult,
} from './data.distribution.outliers-iqr.algo.js';

interface HeavyTailInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly threshold?: number;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<HeavyTailInput, HeavyTailOutput> = {
	id: 'data.distribution.heavy-tail-check.rdbms',
	name: 'Distribution: heavy-tail check (RDBMS)',
	description: 'Binary verdict on tail heaviness from sample kurtosis. Default threshold 1.0; sample-based at n=50.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			threshold:    { type: 'number', minimum: 0.1, maximum: 10 },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: HEAVY_TAIL_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_aggregate', 'db_sql_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_aggregate', 'db_sql_sample'], reason: 'aggregate gives mean/stddev; sample gives values for kurtosis' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<HeavyTailOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const threshold = clampHeavyTailThreshold(input.threshold);

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({
				id: `${callBase}-agg`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: heavyTailAggregationsFor(input.column),
				},
			}),
			deps.runTool({
				id: `${callBase}-sample`,
				name: 'db_sql_sample',
				input: { connectionId: input.connectionId, target: input.target, limit: HEAVY_TAIL_SAMPLE_SIZE },
			}),
		]);

		const errors = collectToolErrors([['db_sql_aggregate', aggTool], ['db_sql_sample', sampleTool]]);
		if (errors.length > 0) {
			return { value: emptyHeavyTailCheck(input.target, input.column, threshold), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isSampleResult(sampleTool.data)) {
			return {
				value: emptyHeavyTailCheck(input.target, input.column, threshold),
				confidence: 'low',
				notes: ['heavy-tail-check: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const out = buildHeavyTailCheck(
			aggTool.data.target,
			input.column,
			threshold,
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

export function registerDataDistributionHeavyTailCheckRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
