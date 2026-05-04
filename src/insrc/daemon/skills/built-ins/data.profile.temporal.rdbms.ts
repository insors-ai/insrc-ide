/**
 * data.profile.temporal.rdbms -- Phase 5a.3 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper around `db_sql_aggregate`.
 * Math + output shape live in `data.profile.temporal.algo`; the
 * `.file` sibling at `data.profile.temporal.file` shares the same
 * algo module so both wrappers stay in lock-step.
 *
 * Min/max range + gap detection + period inference remain deferred
 * (see algo file's header) -- gated on a type-aware aggregation
 * tool.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';
import {
	type ProfileTemporalOutput,
	TEMPORAL_DEFERRED_NOTE,
	TEMPORAL_PROFILE_OUTPUT_SCHEMA,
	buildTemporalProfile,
	emptyTemporalProfile,
	isAggregateResult,
	temporalAggregationsFor,
} from './data.profile.temporal.algo.js';

interface ProfileTemporalInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<ProfileTemporalInput, ProfileTemporalOutput> = {
	id: 'data.profile.temporal.rdbms',
	name: 'Profile: temporal column (RDBMS)',
	description:
		'Server-side temporal-column profile: count + null rate + distinct cardinality. Min / max range and ' +
		'gap / period inference are follow-ups gated on a type-aware aggregation tool.',
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
	outputs: TEMPORAL_PROFILE_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_aggregate'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate'],
			reason: 'count + non-null + distinct count via the standard aggregate path',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only; file connections route through `data.profile.temporal.file`',
		},
	],

	async execute(input, deps): Promise<SkillResult<ProfileTemporalOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const tool = await deps.runTool({
			id: callId,
			name: 'db_sql_aggregate',
			input: {
				connectionId: input.connectionId,
				target: input.target,
				aggregations: temporalAggregationsFor(input.column),
			},
		});

		if (tool.isError) {
			return {
				value: emptyTemporalProfile(input.target, input.column),
				confidence: 'low',
				notes: [`db_sql_aggregate error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		if (!isAggregateResult(tool.data)) {
			return {
				value: emptyTemporalProfile(input.target, input.column),
				confidence: 'low',
				notes: ['db_sql_aggregate returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const profile = buildTemporalProfile(tool.data.target, input.column, tool.data.values);
		return {
			value: profile,
			confidence: (profile.nonNullCount ?? 0) > 0 ? 'high' : 'medium',
			notes: [TEMPORAL_DEFERRED_NOTE],
			toolCalls: [],
		};
	},
};

export function registerDataProfileTemporalRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
