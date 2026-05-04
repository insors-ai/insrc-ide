/**
 * data.correlation.categorical-pairwise.file -- Phase 5c.2 of
 * plans/analyzers/data-analyzer-skills.md (file-side variant).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import {
	type CorrelationCatOutput,
	CORR_CAT_MAX_COLUMNS,
	CORRELATION_CAT_OUTPUT_SCHEMA,
	buildCorrelationCatOutput,
	clampCorrCatSample,
	clampMaxDistinct,
	emptyCorrelationCatOutput,
	filterByCardinality,
	pickCategoricalColumns,
} from './data.correlation.categorical-pairwise.algo.js';
import {
	isCorrelationSampleResult,
	isDescribeResult,
} from './data.correlation.numeric-pairwise.algo.js';

interface CorrelationCatFileInput {
	readonly connectionId: string;
	readonly columns?: readonly string[];
	readonly target?: string;
	readonly sampleSize?: number;
	readonly maxDistinctPerColumn?: number;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<CorrelationCatFileInput, CorrelationCatOutput> = {
	id: 'data.correlation.categorical-pairwise.file',
	name: 'Correlation: categorical pairwise (file)',
	description: 'Pairwise Cramér\'s V across categorical columns from a file connection. Same shape as the RDBMS variant.',
	family: 'dependency',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId:         { type: 'string' },
			columns:              { type: 'array', items: { type: 'string' } },
			target:               { type: 'string', description: 'Optional. xlsx: sheet name.' },
			sampleSize:           { type: 'integer', minimum: 1, maximum: 50 },
			maxDistinctPerColumn: { type: 'integer', minimum: 2, maximum: 50 },
		},
		required: ['connectionId'],
		additionalProperties: false,
	},
	outputs: CORRELATION_CAT_OUTPUT_SCHEMA,
	toolDeps: ['db_file_describe', 'db_file_sample'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_describe', 'db_file_sample'], reason: 'describe gives the categorical column list; sample gives the rows we tabulate' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<CorrelationCatOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampCorrCatSample(input.sampleSize);
		const maxDistinct = clampMaxDistinct(input.maxDistinctPerColumn);
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		const colsOrErr = await resolveColumns(input, deps, callBase, sheet);
		if (typeof colsOrErr === 'string') {
			return { value: emptyCorrelationCatOutput(input.target ?? ''), confidence: 'low', notes: [colsOrErr], toolCalls: [] };
		}

		const sampleInput: Record<string, unknown> = { connectionId: input.connectionId, limit: sampleSize };
		if (sheet !== undefined) sampleInput['target'] = sheet;
		const sampleTool = await deps.runTool({ id: `${callBase}-sample`, name: 'db_file_sample', input: sampleInput });
		if (sampleTool.isError) {
			return { value: emptyCorrelationCatOutput(input.target ?? ''), confidence: 'low', notes: [`db_file_sample error: ${sampleTool.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isCorrelationSampleResult(sampleTool.data)) {
			return {
				value: emptyCorrelationCatOutput(input.target ?? ''),
				confidence: 'low',
				notes: ['db_file_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}
		const rows = sampleTool.data.rows;

		const { evaluatedColumns: filtered, droppedHighCardinality } = filterByCardinality(colsOrErr, rows, maxDistinct);
		const truncatedColumns = filtered.length > CORR_CAT_MAX_COLUMNS;
		const evaluatedColumns = filtered.slice(0, CORR_CAT_MAX_COLUMNS);
		if (evaluatedColumns.length < 2) {
			return {
				value: {
					...emptyCorrelationCatOutput(input.target ?? ''),
					sampleSize: rows.length,
					evaluatedColumns,
					droppedHighCardinality,
					interpretation: `need >= 2 categorical columns (post-cardinality filter) to compute V; found ${evaluatedColumns.length}. Dropped ${droppedHighCardinality.length} high-cardinality column(s).`,
				},
				confidence: 'medium',
				toolCalls: [],
			};
		}

		return {
			value: buildCorrelationCatOutput(sampleTool.data.target, evaluatedColumns, droppedHighCardinality, truncatedColumns, rows),
			confidence: 'high',
			toolCalls: [],
		};
	},
};

async function resolveColumns(input: CorrelationCatFileInput, deps: SkillDeps, callBase: string, sheet: string | undefined): Promise<readonly string[] | string> {
	if (input.columns !== undefined && input.columns.length > 0) return input.columns;
	const describeInput: Record<string, unknown> = { connectionId: input.connectionId };
	if (sheet !== undefined) describeInput['target'] = sheet;
	const describe = await deps.runTool({ id: `${callBase}-desc`, name: 'db_file_describe', input: describeInput });
	if (describe.isError) return `db_file_describe error: ${describe.content.slice(0, 200)}`;
	if (!isDescribeResult(describe.data)) return 'db_file_describe returned a result without the expected structured data shape';
	const categorical = pickCategoricalColumns(describe.data.columns);
	if (categorical.length === 0) return `connection '${input.connectionId}' has no categorical columns`;
	return categorical;
}

export function registerDataCorrelationCategoricalPairwiseFileSkill(): void {
	registerSkill(skill as unknown as Skill);
}
