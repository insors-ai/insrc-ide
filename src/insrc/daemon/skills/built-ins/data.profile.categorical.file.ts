/**
 * data.profile.categorical.file -- Phase 5a.2 of
 * plans/analyzers/data-analyzer-skills.md (file-side variant).
 *
 * Mirrors `data.profile.categorical.rdbms`; same algo module. Calls
 * `db_file_aggregate` + `db_file_distinct`. `target` optional (xlsx
 * sheet selector under tool-side `path`).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult, SkillToolResult } from '../types.js';
import {
	type ProfileCategoricalOutput,
	CATEGORICAL_DEFAULT_TOP_N,
	CATEGORICAL_PROFILE_OUTPUT_SCHEMA,
	buildCategoricalProfile,
	categoricalAggregationsFor,
	emptyCategoricalProfile,
	isAggregateResult,
	isDistinctResult,
} from './data.profile.categorical.algo.js';

interface ProfileCategoricalFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly target?: string;
	readonly topN?: number;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<ProfileCategoricalFileInput, ProfileCategoricalOutput> = {
	id: 'data.profile.categorical.file',
	name: 'Profile: categorical column (file)',
	description:
		'Server-side categorical profile of one file-connection column: count + null rate + distinct ' +
		'cardinality + top-N values (count + frequency). Default topN=20, max 100. xlsx sheet selection ' +
		'via the optional `target` field.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			column:       { type: 'string' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			topN:         { type: 'integer', minimum: 1, maximum: 100 },
		},
		required: ['connectionId', 'column'],
		additionalProperties: false,
	},
	outputs: CATEGORICAL_PROFILE_OUTPUT_SCHEMA,
	toolDeps: ['db_file_aggregate', 'db_file_distinct'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_file_aggregate', 'db_file_distinct'],
			reason: 'aggregate + distinct via the DuckDB-backed file driver',
		},
		{
			kind: 'connection-family',
			families: FILE_FAMILY_TAGS,
			reason: 'file-only; RDBMS connections route through `data.profile.categorical.rdbms`',
		},
	],

	async execute(input, deps): Promise<SkillResult<ProfileCategoricalOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const topN = input.topN ?? CATEGORICAL_DEFAULT_TOP_N;
		const sheetPath = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		const aggInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			aggregations: categoricalAggregationsFor(input.column),
		};
		if (sheetPath !== undefined) aggInput['path'] = sheetPath;

		const distInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			column: input.column,
			topN,
		};
		if (sheetPath !== undefined) distInput['path'] = sheetPath;

		const [aggTool, distTool] = await Promise.all([
			deps.runTool({ id: `${callBase}-agg`,  name: 'db_file_aggregate', input: aggInput }),
			deps.runTool({ id: `${callBase}-dist`, name: 'db_file_distinct',  input: distInput }),
		]);

		const errors = collectToolErrors([['db_file_aggregate', aggTool], ['db_file_distinct', distTool]]);
		if (errors.length > 0) {
			return { value: emptyCategoricalProfile(input.target ?? '', input.column), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isDistinctResult(distTool.data)) {
			return {
				value: emptyCategoricalProfile(input.target ?? '', input.column),
				confidence: 'low',
				notes: ['categorical profile: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const profile = buildCategoricalProfile(
			aggTool.data.target,
			input.column,
			aggTool.data.values,
			distTool.data.distinctCount,
			distTool.data.topValues,
		);
		return {
			value: profile,
			confidence: (profile.nonNullCount ?? 0) > 0 ? 'high' : 'medium',
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

export function registerDataProfileCategoricalFileSkill(): void {
	registerSkill(skill as unknown as Skill);
}
