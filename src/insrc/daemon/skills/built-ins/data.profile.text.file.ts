/**
 * data.profile.text.file -- Phase 5a.4 of
 * plans/analyzers/data-analyzer-skills.md (file-side variant).
 *
 * Mirrors `data.profile.text.rdbms`; same algo module. Calls
 * `db_file_aggregate` + `db_file_sample`. `target` optional (xlsx
 * sheet selector under tool-side `path`).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult, SkillToolResult } from '../types.js';
import {
	type ProfileTextOutput,
	TEXT_PROFILE_OUTPUT_SCHEMA,
	buildTextProfile,
	clampTextSample,
	emptyTextProfile,
	isAggregateResult,
	isSampleResult,
	textAggregationsFor,
} from './data.profile.text.algo.js';

interface ProfileTextFileInput {
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

const skill: Skill<ProfileTextFileInput, ProfileTextOutput> = {
	id: 'data.profile.text.file',
	name: 'Profile: text column (file)',
	description:
		'Server-side cardinality + null rate plus sample-based length statistics for one text column on a ' +
		'file connection. Sample size capped at 50; default 50. xlsx sheet selection via the optional ' +
		'`target` field.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			column:       { type: 'string' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId', 'column'],
		additionalProperties: false,
	},
	outputs: TEXT_PROFILE_OUTPUT_SCHEMA,
	toolDeps: ['db_file_aggregate', 'db_file_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_file_aggregate', 'db_file_sample'],
			reason: 'aggregate gives counts; sample gives values for length stats',
		},
		{
			kind: 'connection-family',
			families: FILE_FAMILY_TAGS,
			reason: 'file-only; RDBMS connections route through `data.profile.text.rdbms`',
		},
	],

	async execute(input, deps): Promise<SkillResult<ProfileTextOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampTextSample(input.sampleSize);
		const sheetPath = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		const aggInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			aggregations: textAggregationsFor(input.column),
		};
		if (sheetPath !== undefined) aggInput['path'] = sheetPath;

		// db_file_sample uses `target` (not `path`) as the sheet selector
		// -- another tool-surface inconsistency tracked in the
		// "Open cleanup work" section. We translate accordingly.
		const sampleInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			limit: sampleSize,
		};
		if (sheetPath !== undefined) sampleInput['target'] = sheetPath;

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({ id: `${callBase}-agg`,    name: 'db_file_aggregate', input: aggInput }),
			deps.runTool({ id: `${callBase}-sample`, name: 'db_file_sample',    input: sampleInput }),
		]);

		const errors = collectToolErrors([['db_file_aggregate', aggTool], ['db_file_sample', sampleTool]]);
		if (errors.length > 0) {
			return { value: emptyTextProfile(input.target ?? '', input.column), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isSampleResult(sampleTool.data)) {
			return {
				value: emptyTextProfile(input.target ?? '', input.column),
				confidence: 'low',
				notes: ['text profile: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const profile = buildTextProfile(
			aggTool.data.target,
			input.column,
			aggTool.data.values,
			{ columns: sampleTool.data.columns, rows: sampleTool.data.rows },
		);
		return {
			value: profile,
			confidence: (profile.nonNullCount ?? 0) > 0 && profile.sampleSize > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

function collectToolErrors(
	pairs: readonly (readonly [string, SkillToolResult])[],
): string[] {
	const out: string[] = [];
	for (const [name, res] of pairs) {
		if (res.isError) out.push(`${name} error: ${res.content.slice(0, 200)}`);
	}
	return out;
}

export function registerDataProfileTextFileSkill(): void {
	registerSkill(skill as unknown as Skill);
}
