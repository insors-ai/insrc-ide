/**
 * data.correlation.numeric-pairwise.file -- Phase 5c.1 of
 * plans/analyzers/data-analyzer-skills.md (file-side variant).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import {
	type CorrelationOutput,
	CORRELATION_MAX_COLUMNS,
	CORRELATION_OUTPUT_SCHEMA,
	buildCorrelationOutput,
	clampCorrelationSample,
	emptyCorrelationOutput,
	isCorrelationSampleResult,
	isDescribeResult,
	pickNumericColumns,
} from './data.correlation.numeric-pairwise.algo.js';

interface CorrelationFileInput {
	readonly connectionId: string;
	readonly columns?: readonly string[];
	readonly target?: string;
	readonly sampleSize?: number;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<CorrelationFileInput, CorrelationOutput> = {
	id: 'data.correlation.numeric-pairwise.file',
	name: 'Correlation: numeric pairwise (file)',
	description: 'Pairwise Pearson + Spearman correlation across numeric columns from a file connection. Same shape as the RDBMS variant.',
	family: 'dependency',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			columns:      { type: 'array', items: { type: 'string' } },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId'],
		additionalProperties: false,
	},
	outputs: CORRELATION_OUTPUT_SCHEMA,
	toolDeps: ['db_file_describe', 'db_file_sample'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_describe', 'db_file_sample'], reason: 'describe gives the numeric column list; sample gives the rows we correlate over' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<CorrelationOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampCorrelationSample(input.sampleSize);
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		const colsOrErr = await resolveColumns(input, deps, callBase, sheet);
		if (typeof colsOrErr === 'string') {
			return { value: emptyCorrelationOutput(input.target ?? ''), confidence: 'low', notes: [colsOrErr], toolCalls: [] };
		}
		const allCols = colsOrErr;
		const truncatedColumns = allCols.length > CORRELATION_MAX_COLUMNS;
		const evaluatedColumns = allCols.slice(0, CORRELATION_MAX_COLUMNS);
		if (evaluatedColumns.length < 2) {
			return {
				value: { ...emptyCorrelationOutput(input.target ?? ''), evaluatedColumns, interpretation: `need >= 2 numeric columns to compute pairwise correlations; found ${evaluatedColumns.length}` },
				confidence: 'medium',
				toolCalls: [],
			};
		}

		const sampleInput: Record<string, unknown> = { connectionId: input.connectionId, limit: sampleSize };
		if (sheet !== undefined) sampleInput['target'] = sheet;
		const sampleTool = await deps.runTool({
			id: `${callBase}-sample`,
			name: 'db_file_sample',
			input: sampleInput,
		});
		if (sampleTool.isError) {
			return { value: emptyCorrelationOutput(input.target ?? ''), confidence: 'low', notes: [`db_file_sample error: ${sampleTool.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isCorrelationSampleResult(sampleTool.data)) {
			return {
				value: emptyCorrelationOutput(input.target ?? ''),
				confidence: 'low',
				notes: ['db_file_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}
		return {
			value: buildCorrelationOutput(sampleTool.data.target, evaluatedColumns, truncatedColumns, sampleTool.data.rows),
			confidence: 'high',
			toolCalls: [],
		};
	},
};

async function resolveColumns(input: CorrelationFileInput, deps: SkillDeps, callBase: string, sheet: string | undefined): Promise<readonly string[] | string> {
	if (input.columns !== undefined && input.columns.length > 0) return input.columns;
	const describeInput: Record<string, unknown> = { connectionId: input.connectionId };
	if (sheet !== undefined) describeInput['target'] = sheet;
	const describe = await deps.runTool({ id: `${callBase}-desc`, name: 'db_file_describe', input: describeInput });
	if (describe.isError) return `db_file_describe error: ${describe.content.slice(0, 200)}`;
	if (!isDescribeResult(describe.data)) {
		return 'db_file_describe returned a result without the expected structured data shape';
	}
	const numeric = pickNumericColumns(describe.data.columns);
	if (numeric.length === 0) return `connection '${input.connectionId}' has no numeric columns`;
	return numeric;
}

export function registerDataCorrelationNumericPairwiseFileSkill(): void {
	registerSkill(skill as unknown as Skill);
}
