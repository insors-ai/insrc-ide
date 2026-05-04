/**
 * data.distribution.modes.file -- Phase 5b.7 of
 * plans/analyzers/data-analyzer-skills.md (file-side variant).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';
import {
	type ModesOutput,
	MODES_OUTPUT_SCHEMA,
	buildModes,
	clampModesBins,
	clampModesProminence,
	clampModesSample,
	emptyModes,
	modesAggregationsFor,
} from './data.distribution.modes.algo.js';
import {
	collectToolErrors,
	isAggregateResult,
	isSampleResult,
} from './data.distribution.outliers-iqr.algo.js';

interface ModesFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly target?: string;
	readonly sampleSize?: number;
	readonly bins?: number;
	readonly minProminence?: number;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<ModesFileInput, ModesOutput> = {
	id: 'data.distribution.modes.file',
	name: 'Distribution: modes (file)',
	description: 'Sample-based multimodal detection on a numeric column from a file connection. Same shape as the RDBMS variant.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId:  { type: 'string' },
			column:        { type: 'string' },
			target:        { type: 'string', description: 'Optional. xlsx: sheet name.' },
			sampleSize:    { type: 'integer', minimum: 1, maximum: 50 },
			bins:          { type: 'integer', minimum: 4, maximum: 50 },
			minProminence: { type: 'number', minimum: 0.1, maximum: 1 },
		},
		required: ['connectionId', 'column'],
		additionalProperties: false,
	},
	outputs: MODES_OUTPUT_SCHEMA,
	toolDeps: ['db_file_aggregate', 'db_file_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_aggregate', 'db_file_sample'], reason: 'aggregate gives min/max/mean for histogram framing; sample gives values to bin' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<ModesOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampModesSample(input.sampleSize);
		const binCount = clampModesBins(input.bins);
		const minProminence = clampModesProminence(input.minProminence);
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		const aggInput: Record<string, unknown> = { connectionId: input.connectionId, aggregations: modesAggregationsFor(input.column) };
		if (sheet !== undefined) aggInput['path'] = sheet;
		const sampleInput: Record<string, unknown> = { connectionId: input.connectionId, limit: sampleSize };
		if (sheet !== undefined) sampleInput['target'] = sheet;

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({ id: `${callBase}-agg`,    name: 'db_file_aggregate', input: aggInput }),
			deps.runTool({ id: `${callBase}-sample`, name: 'db_file_sample',    input: sampleInput }),
		]);

		const errors = collectToolErrors([['db_file_aggregate', aggTool], ['db_file_sample', sampleTool]]);
		if (errors.length > 0) {
			return { value: emptyModes(input.target ?? '', input.column), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isSampleResult(sampleTool.data)) {
			return {
				value: emptyModes(input.target ?? '', input.column),
				confidence: 'low',
				notes: ['modes: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const out = buildModes(
			aggTool.data.target,
			input.column,
			binCount,
			minProminence,
			aggTool.data.values,
			{ columns: sampleTool.data.columns, rows: sampleTool.data.rows },
		);
		return {
			value: out,
			confidence: out.modality === 'inconclusive' ? 'medium' : 'high',
			toolCalls: [],
		};
	},
};

export function registerDataDistributionModesFileSkill(): void {
	registerSkill(skill as unknown as Skill);
}
