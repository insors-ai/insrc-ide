/**
 * data.quality.consistency.file -- Phase 5d.5 (file-side variant).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import {
	type ConsistencyOutput,
	type ConsistencyRule,
	type ConsistencySource,
	CONSISTENCY_OUTPUT_SCHEMA,
	CONSISTENCY_RULE_SCHEMA,
	buildConsistency,
	buildConsistencyFromCounts,
	clampConsistencySample,
	consistencyRuleAggregations,
	emptyConsistency,
} from './data.quality.consistency.algo.js';
import { isCorrelationSampleResult as isSampleResult } from './data.correlation.numeric-pairwise.algo.js';
import { isAggregateResult } from './data.quality.completeness.algo.js';

interface ConsistencyFileInput {
	readonly connectionId: string;
	readonly rules: readonly ConsistencyRule[];
	readonly target?: string;
	readonly sampleSize?: number;
	readonly mode?: ConsistencySource;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<ConsistencyFileInput, ConsistencyOutput> = {
	id: 'data.quality.consistency.file',
	name: 'Quality: cross-column consistency (file)',
	description: 'Evaluates caller-supplied cross-column consistency rules over a 50-row sample of a file connection. Same operator set as the RDBMS variant.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			rules:        { type: 'array', items: CONSISTENCY_RULE_SCHEMA, minItems: 1, maxItems: 20 },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
			mode:         { type: 'string', enum: ['sample', 'full-table'], description: 'Default sample. full-table issues count_where aggregates per rule.' },
		},
		required: ['connectionId', 'rules'],
		additionalProperties: false,
	},
	outputs: CONSISTENCY_OUTPUT_SCHEMA,
	toolDeps: ['db_file_sample', 'db_file_aggregate'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_sample', 'db_file_aggregate'], reason: 'sample (mode=sample) or aggregate (mode=full-table) supplies the per-rule counts' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<ConsistencyOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampConsistencySample(input.sampleSize);
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		if (input.mode === 'full-table') {
			const fullResult = await runFullTable(input, deps, callId, sheet);
			if (typeof fullResult === 'string') {
				return { value: emptyConsistency(input.target ?? '', input.rules), confidence: 'low', notes: [fullResult], toolCalls: [] };
			}
			return {
				value: fullResult,
				confidence: fullResult.verdict === 'inconclusive' ? 'medium' : 'high',
				toolCalls: [],
			};
		}

		const sampleInput: Record<string, unknown> = { connectionId: input.connectionId, limit: sampleSize };
		if (sheet !== undefined) sampleInput['target'] = sheet;
		const tool = await deps.runTool({ id: callId, name: 'db_file_sample', input: sampleInput });
		if (tool.isError) {
			return { value: emptyConsistency(input.target ?? '', input.rules), confidence: 'low', notes: [`db_file_sample error: ${tool.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isSampleResult(tool.data)) {
			return {
				value: emptyConsistency(input.target ?? '', input.rules),
				confidence: 'low',
				notes: ['db_file_sample returned a result without the expected structured data shape'],
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

async function runFullTable(
	input: ConsistencyFileInput,
	deps: SkillDeps,
	callId: string,
	sheet: string | undefined,
): Promise<ConsistencyOutput | string> {
	const totalInput: Record<string, unknown> = {
		connectionId: input.connectionId,
		aggregations: [{ column: '*', function: 'count' }],
	};
	if (sheet !== undefined) totalInput['path'] = sheet;
	const totalRes = await deps.runTool({ id: `${callId}-total`, name: 'db_file_aggregate', input: totalInput });
	if (totalRes.isError) return `db_file_aggregate(count) error: ${totalRes.content.slice(0, 200)}`;
	if (!isAggregateResult(totalRes.data)) return 'db_file_aggregate count returned a result without the expected structured data shape';
	const totalRows = Number(totalRes.data.values['*__count'] ?? 0);

	const perRuleCounts: number[][] = [];
	for (let i = 0; i < input.rules.length; i++) {
		const rule = input.rules[i]!;
		const aggregations = consistencyRuleAggregations(rule);
		const aggInput: Record<string, unknown> = { connectionId: input.connectionId, aggregations };
		if (sheet !== undefined) aggInput['path'] = sheet;
		const aggRes = await deps.runTool({ id: `${callId}-rule-${i}`, name: 'db_file_aggregate', input: aggInput });
		if (aggRes.isError) return `db_file_aggregate(rule '${rule.name}') error: ${aggRes.content.slice(0, 200)}`;
		if (!isAggregateResult(aggRes.data)) return `db_file_aggregate rule '${rule.name}' returned a result without the expected structured data shape`;
		const counts: number[] = [];
		for (const spec of aggregations) {
			const sigParts = spec.args!.predicate!.map(c => `${c.column}_${c.op.replace(/[^a-z0-9]/gi, '')}`);
			const key = `${spec.column}__count_where_${sigParts.join('__')}`;
			counts.push(Number(aggRes.data.values[key] ?? 0));
		}
		perRuleCounts.push(counts);
	}

	return buildConsistencyFromCounts(input.target ?? '', input.rules, totalRows, perRuleCounts);
}

export function registerDataQualityConsistencyFileSkill(): void {
	registerSkill(skill as unknown as Skill);
}
