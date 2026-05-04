/**
 * data.quality.consistency.rdbms -- Phase 5d.5 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic quality skill: cross-column consistency rule checks.
 * Sample-based; precise full-table consistency would need per-rule
 * SQL of the form `SELECT COUNT(*) WHERE NOT (rule)`, which the
 * current `db_sql_aggregate` doesn't expose.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';
import {
	type ConsistencyOutput,
	type ConsistencyRule,
	CONSISTENCY_OUTPUT_SCHEMA,
	CONSISTENCY_RULE_SCHEMA,
	buildConsistency,
	clampConsistencySample,
	emptyConsistency,
} from './data.quality.consistency.algo.js';
import { isCorrelationSampleResult as isSampleResult } from './data.correlation.numeric-pairwise.algo.js';

interface ConsistencyRdbmsInput {
	readonly connectionId: string;
	readonly target: string;
	readonly rules: readonly ConsistencyRule[];
	readonly sampleSize?: number;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<ConsistencyRdbmsInput, ConsistencyOutput> = {
	id: 'data.quality.consistency.rdbms',
	name: 'Quality: cross-column consistency (RDBMS)',
	description:
		'Evaluates caller-supplied cross-column rules over a 50-row sample. Operators: comparison ' +
		'(< <= = != >= >) with null-aware inapplicable handling, plus and-not-null (both must be filled) ' +
		'and xor-null (exactly one must be null). Returns per-rule satisfied/violated/inapplicable counts + ' +
		'satisfaction rate + up to 3 violation examples. Verdict: consistent / mostly-consistent / mixed / ' +
		'broken / inconclusive. Sample-based; precise per-rule full-table counts need a count-where ' +
		'aggregate not yet shipped.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			rules:        { type: 'array', items: CONSISTENCY_RULE_SCHEMA, minItems: 1, maxItems: 20 },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId', 'target', 'rules'],
		additionalProperties: false,
	},
	outputs: CONSISTENCY_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_sample'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_sample'], reason: 'sole tool that supplies the rows we evaluate rules over' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<ConsistencyOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampConsistencySample(input.sampleSize);

		const tool = await deps.runTool({
			id: callId,
			name: 'db_sql_sample',
			input: { connectionId: input.connectionId, target: input.target, limit: sampleSize },
		});
		if (tool.isError) {
			return { value: emptyConsistency(input.target, input.rules), confidence: 'low', notes: [`db_sql_sample error: ${tool.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isSampleResult(tool.data)) {
			return {
				value: emptyConsistency(input.target, input.rules),
				confidence: 'low',
				notes: ['db_sql_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const built = buildConsistency(tool.data.target, input.rules, { columns: tool.data.columns, rows: tool.data.rows });
		if (built.missingColumns.length > 0) {
			return {
				value: built.output,
				confidence: 'low',
				notes: [`columns missing from sample: ${built.missingColumns.join(', ')}; available: ${tool.data.columns.join(', ')}`],
				toolCalls: [],
			};
		}
		return {
			value: built.output,
			confidence: built.output.verdict === 'inconclusive' ? 'medium' : 'high',
			toolCalls: [],
		};
	},
};

export function registerDataQualityConsistencyRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
