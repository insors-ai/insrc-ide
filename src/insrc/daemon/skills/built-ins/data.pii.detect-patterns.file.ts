/**
 * data.pii.detect-patterns.file -- Phase 5e.1 (file-side variant).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';
import {
	type PiiDetectPatternsOutput,
	PII_OUTPUT_SCHEMA,
	buildPiiDetections,
	clampPiiSample,
	emptyPii,
} from './data.pii.detect-patterns.algo.js';
import { isCorrelationSampleResult as isSampleResult } from './data.correlation.numeric-pairwise.algo.js';

interface PiiDetectPatternsFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly target?: string;
	readonly sampleSize?: number;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<PiiDetectPatternsFileInput, PiiDetectPatternsOutput> = {
	id: 'data.pii.detect-patterns.file',
	name: 'PII: detect patterns (file)',
	description:
		'Sample values from one file-connection column and apply a built-in set of PII regex patterns: email / ssn-us / ' +
		'phone-us / credit-card / jwt / ipv4 / iban / aws-access-key / github-token / uuid. Returns per-pattern ' +
		'hit count + rate + examples.',
	family: 'sensitivity',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			column:       { type: 'string' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50, description: 'Default 50 (the tool cap).' },
		},
		required: ['connectionId', 'column'],
		additionalProperties: false,
	},
	outputs: PII_OUTPUT_SCHEMA,
	toolDeps: ['db_file_sample'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_sample'], reason: 'sole tool that supplies the value sample we regex over' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<PiiDetectPatternsOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampPiiSample(input.sampleSize);
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		const sampleInput: Record<string, unknown> = { connectionId: input.connectionId, limit: sampleSize };
		if (sheet !== undefined) sampleInput['target'] = sheet;
		const tool = await deps.runTool({ id: callId, name: 'db_file_sample', input: sampleInput });
		if (tool.isError) {
			return { value: emptyPii(input.target ?? '', input.column, sampleSize), confidence: 'low', notes: [`db_file_sample error: ${tool.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isSampleResult(tool.data)) {
			return {
				value: emptyPii(input.target ?? '', input.column, sampleSize),
				confidence: 'low',
				notes: ['db_file_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const built = buildPiiDetections(tool.data.target, input.column, { columns: tool.data.columns, rows: tool.data.rows });
		if (built.missingColumn) {
			return {
				value: built.output,
				confidence: 'low',
				notes: [`column '${input.column}' not present in sample (available: ${tool.data.columns.join(', ')})`],
				toolCalls: [],
			};
		}
		const hasMatches = built.output.detections.length > 0;
		return {
			value: built.output,
			confidence: hasMatches ? 'high' : (built.output.sampleSize > 0 ? 'medium' : 'low'),
			toolCalls: [],
		};
	},
};

export function registerDataPiiDetectPatternsFileSkill(): void {
	registerSkill(skill as unknown as Skill);
}
