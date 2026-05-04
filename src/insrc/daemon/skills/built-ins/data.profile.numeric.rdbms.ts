/**
 * data.profile.numeric.rdbms -- Phase 5a.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: server-side numeric profile of one RDBMS column. Thin
 * wrapper that builds the aggregations spec via
 * `numericAggregationsFor`, calls `db_sql_aggregate`, and translates
 * the flat values record into a typed `ProfileNumericOutput` via
 * `buildNumericProfile`. The `.file` sibling at
 * `data.profile.numeric.file` shares the same algo module; both
 * wrappers stay in lock-step on the math by construction.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';
import {
	type ProfileNumericOutput,
	NUMERIC_PROFILE_OUTPUT_SCHEMA,
	buildNumericProfile,
	emptyNumericProfile,
	isAggregateResult,
	numericAggregationsFor,
} from './data.profile.numeric.algo.js';

interface ProfileNumericInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<ProfileNumericInput, ProfileNumericOutput> = {
	id: 'data.profile.numeric.rdbms',
	name: 'Profile: numeric column (RDBMS)',
	description:
		'Server-side numeric profile of one RDBMS column: count + null rate + distinct cardinality + ' +
		'min / max / avg / stddev / variance + p50 / p95 percentiles. Single tool round-trip; the LLM ' +
		'never computes stats from row samples.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: NUMERIC_PROFILE_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_aggregate'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate'],
			reason: 'numeric profile pushes every aggregation server-side',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only; file connections route through `data.profile.numeric.file`',
		},
	],

	async execute(input, deps): Promise<SkillResult<ProfileNumericOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const tool = await deps.runTool({
			id: callId,
			name: 'db_sql_aggregate',
			input: {
				connectionId: input.connectionId,
				target: input.target,
				aggregations: numericAggregationsFor(input.column),
			},
		});

		if (tool.isError) {
			return {
				value: emptyNumericProfile(input.target, input.column),
				confidence: 'low',
				notes: [`db_sql_aggregate error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		if (!isAggregateResult(tool.data)) {
			return {
				value: emptyNumericProfile(input.target, input.column),
				confidence: 'low',
				notes: ['db_sql_aggregate returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const profile = buildNumericProfile(tool.data.target, input.column, tool.data.values);
		const confidence = (profile.nonNullCount ?? 0) > 0 ? 'high' : 'medium';
		return { value: profile, confidence, toolCalls: [] };
	},
};

export function registerDataProfileNumericRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
