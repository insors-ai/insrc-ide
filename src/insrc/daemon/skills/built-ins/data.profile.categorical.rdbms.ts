/**
 * data.profile.categorical.rdbms -- Phase 5a.2 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper that asks `db_sql_aggregate` for
 * count + non-null count and `db_sql_distinct` for the top-N + total
 * distinct cardinality, then merges via the shared algo. The `.file`
 * sibling shares the same algo module.
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

interface ProfileCategoricalInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly topN?: number;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<ProfileCategoricalInput, ProfileCategoricalOutput> = {
	id: 'data.profile.categorical.rdbms',
	name: 'Profile: categorical column (RDBMS)',
	description:
		'Server-side categorical profile of one RDBMS column: total count + null rate + distinct cardinality + ' +
		'top-N values (count + frequency). Default topN=20, max 100.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			topN:         { type: 'integer', minimum: 1, maximum: 100 },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: CATEGORICAL_PROFILE_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_aggregate', 'db_sql_distinct'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate', 'db_sql_distinct'],
			reason: 'aggregate gives count / non-null; distinct gives top-N + cardinality. Both are required',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only; file connections route through `data.profile.categorical.file`',
		},
	],

	async execute(input, deps): Promise<SkillResult<ProfileCategoricalOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const topN = input.topN ?? CATEGORICAL_DEFAULT_TOP_N;

		const [aggTool, distTool] = await Promise.all([
			deps.runTool({
				id: `${callBase}-agg`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: categoricalAggregationsFor(input.column),
				},
			}),
			deps.runTool({
				id: `${callBase}-dist`,
				name: 'db_sql_distinct',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					column: input.column,
					topN,
				},
			}),
		]);

		const errors = collectToolErrors([['db_sql_aggregate', aggTool], ['db_sql_distinct', distTool]]);
		if (errors.length > 0) {
			return { value: emptyCategoricalProfile(input.target, input.column), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isDistinctResult(distTool.data)) {
			return {
				value: emptyCategoricalProfile(input.target, input.column),
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

export function registerDataProfileCategoricalRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
