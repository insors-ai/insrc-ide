/**
 * data.distribution.histogram.file -- Phase 5b.1 of
 * plans/analyzers/data-analyzer-skills.md (file-side variant).
 *
 * Mirrors `data.distribution.histogram.rdbms`; same algo module.
 * Routes through `db_file_histogram` (DuckDB-backed file driver
 * supports both equal-width arithmetic and NTILE natively).
 * xlsx sheet selection via the optional `target` field.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';
import {
	type HistogramMode,
	type HistogramOutput,
	HISTOGRAM_OUTPUT_SCHEMA,
	buildHistogramOutput,
	clampBuckets,
	emptyHistogram,
	isHistogramToolResult,
	normalizeMode,
} from './data.distribution.histogram.algo.js';

interface HistogramFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly target?: string;
	readonly buckets?: number;
	readonly mode?: HistogramMode;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<HistogramFileInput, HistogramOutput> = {
	id: 'data.distribution.histogram.file',
	name: 'Distribution: histogram (file)',
	description:
		'Server-side histogram on a numeric column from a file connection. Same shape + math as the RDBMS ' +
		'variant; routes through `db_file_histogram` (DuckDB backend). Default 20 buckets, capped at 200. ' +
		'xlsx sheet selection via the optional `target` field.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			column:       { type: 'string' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			buckets:      { type: 'integer', minimum: 2, maximum: 200 },
			mode:         { type: 'string', enum: ['equal-width', 'equal-frequency'] },
		},
		required: ['connectionId', 'column'],
		additionalProperties: false,
	},
	outputs: HISTOGRAM_OUTPUT_SCHEMA,
	toolDeps: ['db_file_histogram'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_file_histogram'],
			reason: 'sole tool that computes server-side histograms on file connections',
		},
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<HistogramOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const buckets = clampBuckets(input.buckets);
		const mode = normalizeMode(input.mode);
		// Used for the empty-fallback target slot when the tool is unreachable; the
		// real target comes from the tool's response.
		const targetSlot = input.target ?? '';

		const toolInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			column:       input.column,
			buckets,
			mode,
		};
		if (input.target !== undefined) toolInput['target'] = input.target;

		const tool = await deps.runTool({
			id: callId,
			name: 'db_file_histogram',
			input: toolInput,
		});

		if (tool.isError) {
			return {
				value: emptyHistogram(targetSlot, input.column, mode, buckets),
				confidence: 'low',
				notes: [`db_file_histogram error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		if (!isHistogramToolResult(tool.data)) {
			return {
				value: emptyHistogram(targetSlot, input.column, mode, buckets),
				confidence: 'low',
				notes: ['db_file_histogram returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const out = buildHistogramOutput(tool.data, buckets);
		return {
			value: out,
			confidence: out.verdict === 'has-data' ? 'high' : out.verdict === 'empty' ? 'medium' : 'low',
			toolCalls: [],
		};
	},
};

export function registerDataDistributionHistogramFileSkill(): void {
	registerSkill(skill as unknown as Skill);
}
