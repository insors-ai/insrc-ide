/**
 * data.source.file.sample-shape -- Phase 2.3 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin typed wrapper over `db_file_sample_shape`. Best
 * fit for json / jsonl / ndjson connections (DuckDB has no native
 * nested-shape inference; the underlying driver pulls a sample then
 * runs `inferShape` from `shape-common.ts`). Returns a per-path field
 * inventory with type observations + nullability + frequency.
 *
 * Confidence: `high` when the sample produced ≥1 field observation,
 * `medium` when zero (the file may be empty or every record was
 * scalar), `low` on tool error or shape mismatch.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

interface FileSampleShapeInput {
	readonly connectionId: string;
	readonly pattern?: string;
	readonly prefix?: string;
	readonly limit?: number;
}

interface FieldShape {
	readonly path: string;
	readonly types: readonly string[];
	readonly nullable: boolean;
	readonly frequency: number;
}

interface FileSampleShapeOutput {
	readonly sampleSize: number;
	readonly fields: readonly FieldShape[];
}

const FIELD_SCHEMA = {
	type: 'object',
	properties: {
		path:      { type: 'string' },
		types:     { type: 'array', items: { type: 'string' } },
		nullable:  { type: 'boolean' },
		frequency: { type: 'number' },
	},
	required: ['path', 'types', 'nullable', 'frequency'],
	additionalProperties: false,
} as const;

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<FileSampleShapeInput, FileSampleShapeOutput> = {
	id: 'data.source.file.sample-shape',
	name: 'File: sample shape',
	description:
		'Sample up to 50 records from a file connection and infer per-field types + nullability + frequency. ' +
		'Most useful for json / jsonl / ndjson where columns are nested. Other kinds work but a flat describe ' +
		'is usually cheaper.',
	family: 'source-sampling',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			pattern:      { type: 'string' },
			prefix:       { type: 'string' },
			limit:        { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			sampleSize: { type: 'number' },
			fields:     { type: 'array', items: FIELD_SCHEMA },
		},
		required: ['sampleSize', 'fields'],
		additionalProperties: false,
	},
	toolDeps: ['db_file_sample_shape'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_file_sample_shape'],
			reason: 'sole tool implementing file shape inference',
		},
		{
			kind: 'connection-family',
			families: FILE_FAMILY_TAGS,
			reason: 'shape inference is family-scoped',
		},
	],

	async execute(input, deps): Promise<SkillResult<FileSampleShapeOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const limit = clampLimit(input.limit);
		const toolInput: Record<string, unknown> = { connectionId: input.connectionId, limit };
		if (input.pattern !== undefined) toolInput['pattern'] = input.pattern;
		if (input.prefix  !== undefined) toolInput['prefix']  = input.prefix;

		const tool = await deps.runTool({ id: callId, name: 'db_file_sample_shape', input: toolInput });

		if (tool.isError) {
			return {
				value: emptyShape(),
				confidence: 'low',
				notes: [`db_file_sample_shape error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}

		const data = tool.data;
		if (!isShapeReport(data)) {
			return {
				value: emptyShape(),
				confidence: 'low',
				notes: ['db_file_sample_shape returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		return {
			value: { sampleSize: data.sampleSize, fields: data.fields },
			confidence: data.fields.length > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

function clampLimit(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 50;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

function emptyShape(): FileSampleShapeOutput {
	return { sampleSize: 0, fields: [] };
}

function isShapeReport(v: unknown): v is FileSampleShapeOutput {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['sampleSize'] === 'number' && Array.isArray(o['fields']);
}

export function registerDataSourceFileSampleShapeSkill(): void {
	registerSkill(skill as unknown as Skill);
}
