/**
 * data.quality.validity.file -- Phase 5d.3 (file-side variant).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';
import {
	type QualityValidityOutput,
	VALIDITY_OUTPUT_SCHEMA,
	buildValidity,
	clampValiditySample,
	emptyValidity,
} from './data.quality.validity.algo.js';
import { isCorrelationSampleResult as isSampleResult } from './data.correlation.numeric-pairwise.algo.js';

interface QualityValidityFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly pattern: string;
	readonly target?: string;
	readonly sampleSize?: number;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<QualityValidityFileInput, QualityValidityOutput> = {
	id: 'data.quality.validity.file',
	name: 'Quality: regex validity (file)',
	description: 'Caller-supplied regex validity check on a file-connection column over a 50-row sample.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			column:       { type: 'string' },
			pattern:      { type: 'string', minLength: 1 },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId', 'column', 'pattern'],
		additionalProperties: false,
	},
	outputs: VALIDITY_OUTPUT_SCHEMA,
	toolDeps: ['db_file_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_sample'], reason: 'sample supplies the values we regex over' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<QualityValidityOutput>> {
		let re: RegExp;
		try {
			re = new RegExp(input.pattern);
		} catch (err) {
			return { value: emptyValidity(input.target ?? '', input.column, input.pattern), confidence: 'low', notes: [`pattern '${input.pattern}' is not a valid JS regex: ${(err as Error).message}`], toolCalls: [] };
		}

		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampValiditySample(input.sampleSize);
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		const sampleInput: Record<string, unknown> = { connectionId: input.connectionId, limit: sampleSize };
		if (sheet !== undefined) sampleInput['target'] = sheet;
		const tool = await deps.runTool({ id: callId, name: 'db_file_sample', input: sampleInput });
		if (tool.isError) {
			return { value: emptyValidity(input.target ?? '', input.column, input.pattern), confidence: 'low', notes: [`db_file_sample error: ${tool.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isSampleResult(tool.data)) {
			return {
				value: emptyValidity(input.target ?? '', input.column, input.pattern),
				confidence: 'low',
				notes: ['db_file_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const built = buildValidity(tool.data.target, input.column, input.pattern, re, { columns: tool.data.columns, rows: tool.data.rows });
		if (built.missingColumn) {
			return {
				value: built.output,
				confidence: 'low',
				notes: [`column '${input.column}' not present in sample (available: ${tool.data.columns.join(', ')})`],
				toolCalls: [],
			};
		}
		return {
			value: built.output,
			confidence: built.output.sampleSize > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

export function registerDataQualityValidityFileSkill(): void {
	registerSkill(skill as unknown as Skill);
}
