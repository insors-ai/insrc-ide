/**
 * data.quality.consistency.file -- Phase 5d.5 (file-side variant).
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

interface ConsistencyFileInput {
	readonly connectionId: string;
	readonly rules: readonly ConsistencyRule[];
	readonly target?: string;
	readonly sampleSize?: number;
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
		},
		required: ['connectionId', 'rules'],
		additionalProperties: false,
	},
	outputs: CONSISTENCY_OUTPUT_SCHEMA,
	toolDeps: ['db_file_sample'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_sample'], reason: 'sole tool that supplies the rows we evaluate rules over' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<ConsistencyOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampConsistencySample(input.sampleSize);
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

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

export function registerDataQualityConsistencyFileSkill(): void {
	registerSkill(skill as unknown as Skill);
}
