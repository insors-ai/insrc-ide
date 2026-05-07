/**
 * data.quality.validity.file -- Phase 5d.3 (file-side variant).
 *
 * Default `mode: 'sample'` (50-row JS-side regex check). Opt-in
 * `mode: 'full-table'` runs three aggregates (count + count_non_null
 * + count_where(regex)) for an exact match-rate over the entire
 * non-null population. Phase 5d.3 Gap 1.
 *
 * `db_file_aggregate` uses `path` for the xlsx sheet selector;
 * `db_file_sample` uses `target`. Tool-surface naming inconsistency
 * tracked in plan "Open cleanup work" §1.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';
import {
	type QualityValidityOutput,
	type ValiditySource,
	VALIDITY_OUTPUT_SCHEMA,
	buildValidity,
	buildValidityFromAggregate,
	clampValiditySample,
	emptyValidity,
	isAggregateResult,
	validityAggregationsFor,
} from './data.quality.validity.algo.js';
import { isCorrelationSampleResult as isSampleResult } from './data.correlation.numeric-pairwise.algo.js';

interface QualityValidityFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly pattern: string;
	readonly target?: string;
	readonly sampleSize?: number;
	readonly mode?: ValiditySource;
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
	description:
		'Caller-supplied regex validity check on a file-connection column. Default `mode: sample` evaluates ' +
		'the regex in JS over a 50-row sample. Opt-in `mode: full-table` issues server-side count + ' +
		'count_non_null + count_where(regex) aggregates via DuckDB for an exact match-rate.',
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
			mode: {
				type: 'string',
				enum: ['sample', 'full-table'],
				description: 'Default sample. full-table issues server-side regex match counts.',
			},
		},
		required: ['connectionId', 'column', 'pattern'],
		additionalProperties: false,
	},
	outputs: VALIDITY_OUTPUT_SCHEMA,
	toolDeps: ['db_file_sample', 'db_file_aggregate'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_file_sample', 'db_file_aggregate'],
			reason: 'sample mode: db_file_sample. full-table mode: db_file_aggregate (count_where + regex)',
		},
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<QualityValidityOutput>> {
		let re: RegExp;
		try {
			re = new RegExp(input.pattern);
		} catch (err) {
			return {
				value: emptyValidity(input.target ?? '', input.column, input.pattern),
				confidence: 'low',
				notes: [`pattern '${input.pattern}' is not a valid JS regex: ${(err as Error).message}`],
				toolCalls: [],
			};
		}

		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		if (input.mode === 'full-table') {
			const aggInput: Record<string, unknown> = {
				connectionId: input.connectionId,
				aggregations: validityAggregationsFor(input.column, input.pattern),
			};
			// `db_file_aggregate` uses `path` not `target` (tool-surface
			// inconsistency, tracked in plan "Open cleanup work" §1).
			if (sheet !== undefined) aggInput['path'] = sheet;

			const tool = await deps.runTool({ id: `${callBase}-agg`, name: 'db_file_aggregate', input: aggInput });
			if (tool.isError) {
				return {
					value: { ...emptyValidity(input.target ?? '', input.column, input.pattern), source: 'full-table' },
					confidence: 'low',
					notes: [`db_file_aggregate error (full-table mode): ${tool.content.slice(0, 200)}`],
					toolCalls: [],
				};
			}
			if (!isAggregateResult(tool.data)) {
				return {
					value: { ...emptyValidity(input.target ?? '', input.column, input.pattern), source: 'full-table' },
					confidence: 'low',
					notes: ['db_file_aggregate returned a result without the expected structured data shape'],
					toolCalls: [],
				};
			}
			const out = buildValidityFromAggregate(tool.data.target, input.column, input.pattern, tool.data.values);
			return {
				value: out,
				confidence: out.matchRate !== null && (out.nonNullCount ?? 0) > 0 ? 'high' : 'medium',
				toolCalls: [],
			};
		}

		// sample mode (default + back-compat)
		const sampleSize = clampValiditySample(input.sampleSize);
		const sampleInput: Record<string, unknown> = { connectionId: input.connectionId, limit: sampleSize };
		if (sheet !== undefined) sampleInput['target'] = sheet;
		const tool = await deps.runTool({ id: `${callBase}-sample`, name: 'db_file_sample', input: sampleInput });
		if (tool.isError) {
			return {
				value: emptyValidity(input.target ?? '', input.column, input.pattern),
				confidence: 'low',
				notes: [`db_file_sample error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
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
