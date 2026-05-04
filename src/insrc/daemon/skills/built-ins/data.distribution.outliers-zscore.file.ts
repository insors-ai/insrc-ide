/**
 * data.distribution.outliers-zscore.file -- Phase 5b.3 of
 * plans/analyzers/data-analyzer-skills.md (file-side variant).
 *
 * Mirrors `data.distribution.outliers-zscore.rdbms`; same algo
 * module. Calls `db_file_aggregate` + `db_file_sample`.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';
import {
	type OutliersSource,
	type OutliersZScoreOutput,
	OUTLIERS_ZSCORE_OUTPUT_SCHEMA,
	buildOutliersZScore,
	buildOutliersZScoreFromOutlierTool,
	clampZScoreThreshold,
	emptyOutliersZScore,
	outliersZScoreAggregationsFor,
} from './data.distribution.outliers-zscore.algo.js';
import {
	clampSampleSize,
	collectToolErrors,
	isAggregateResult,
	isSampleResult,
} from './data.distribution.outliers-iqr.algo.js';

interface OutliersZScoreFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly target?: string;
	readonly threshold?: number;
	readonly sampleSize?: number;
	readonly mode?: OutliersSource;
}

interface OutlierToolResultRaw {
	readonly target: string;
	readonly column: string;
	readonly threshold: number;
	readonly nonNullCount: number;
	readonly lowerBound: number | null;
	readonly upperBound: number | null;
	readonly belowCount: number;
	readonly aboveCount: number;
	readonly center: number | null;
	readonly spread: number | null;
	readonly examples: readonly { value: number; side: 'below' | 'above' }[];
}

function isOutlierToolResult(v: unknown): v is OutlierToolResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['column'] === 'string'
		&& Array.isArray(o['examples']);
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<OutliersZScoreFileInput, OutliersZScoreOutput> = {
	id: 'data.distribution.outliers-zscore.file',
	name: 'Distribution: Z-score outliers (file)',
	description:
		'Z-score outlier detection on a numeric column from a file connection. Same shape + math as the ' +
		'RDBMS variant. Default threshold 3.0.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			column:       { type: 'string' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			threshold:    { type: 'number', minimum: 0.5, maximum: 10 },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
			mode:         { type: 'string', enum: ['sample', 'full-table'], description: 'Default sample. full-table delegates to db_file_outliers.' },
		},
		required: ['connectionId', 'column'],
		additionalProperties: false,
	},
	outputs: OUTLIERS_ZSCORE_OUTPUT_SCHEMA,
	toolDeps: ['db_file_aggregate', 'db_file_sample', 'db_file_outliers'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_aggregate', 'db_file_sample', 'db_file_outliers'], reason: 'sample mode: aggregate + sample. full-table mode: db_file_outliers' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<OutliersZScoreOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const threshold = clampZScoreThreshold(input.threshold);
		const sampleSize = clampSampleSize(input.sampleSize);
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		if (input.mode === 'full-table') {
			const toolInput: Record<string, unknown> = {
				connectionId: input.connectionId,
				column: input.column,
				method: 'zscore',
				threshold,
			};
			if (sheet !== undefined) toolInput['target'] = sheet;
			const tool = await deps.runTool({ id: `${callBase}-outliers`, name: 'db_file_outliers', input: toolInput });
			if (tool.isError) {
				return { value: emptyOutliersZScore(input.target ?? '', input.column, threshold), confidence: 'low', notes: [`db_file_outliers error: ${tool.content.slice(0, 200)}`], toolCalls: [] };
			}
			if (!isOutlierToolResult(tool.data)) {
				return {
					value: emptyOutliersZScore(input.target ?? '', input.column, threshold),
					confidence: 'low',
					notes: ['db_file_outliers returned a result without the expected structured data shape'],
					toolCalls: [],
				};
			}
			const out = buildOutliersZScoreFromOutlierTool(tool.data);
			return {
				value: out,
				confidence: out.lowerBound !== null && out.upperBound !== null ? 'high' : 'medium',
				toolCalls: [],
			};
		}

		const aggInput: Record<string, unknown> = { connectionId: input.connectionId, aggregations: outliersZScoreAggregationsFor(input.column) };
		if (sheet !== undefined) aggInput['path'] = sheet;
		const sampleInput: Record<string, unknown> = { connectionId: input.connectionId, limit: sampleSize };
		if (sheet !== undefined) sampleInput['target'] = sheet;

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({ id: `${callBase}-agg`,    name: 'db_file_aggregate', input: aggInput }),
			deps.runTool({ id: `${callBase}-sample`, name: 'db_file_sample',    input: sampleInput }),
		]);

		const errors = collectToolErrors([['db_file_aggregate', aggTool], ['db_file_sample', sampleTool]]);
		if (errors.length > 0) {
			return { value: emptyOutliersZScore(input.target ?? '', input.column, threshold), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isSampleResult(sampleTool.data)) {
			return {
				value: emptyOutliersZScore(input.target ?? '', input.column, threshold),
				confidence: 'low',
				notes: ['outliers-zscore: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const out = buildOutliersZScore(
			aggTool.data.target,
			input.column,
			threshold,
			aggTool.data.values,
			{ columns: sampleTool.data.columns, rows: sampleTool.data.rows },
		);
		return {
			value: out,
			confidence: out.lowerBound !== null && out.upperBound !== null && out.sampleSize > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

export function registerDataDistributionOutliersZScoreFileSkill(): void {
	registerSkill(skill as unknown as Skill);
}
