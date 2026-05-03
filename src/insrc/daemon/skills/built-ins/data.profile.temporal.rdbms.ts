/**
 * data.profile.temporal.rdbms -- Phase 5a.3 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: profiles a temporal RDBMS column (date / time /
 * timestamp / datetime). Returns count + non-null + null counts +
 * distinct cardinality.
 *
 * **Known partial.** The plan calls for "range, gap detection,
 * period inference"; this v1 ships only count + cardinality. The
 * gap is the existing `db_sql_aggregate` tool's `values` shape:
 * `Record<string, number | null>` -- it cannot return Date /
 * timestamp values from `min` / `max`. A type-aware aggregation
 * surface (`db_sql_temporal_range` tool, or a typed extension to
 * `db_sql_aggregate`) is the natural follow-up; gap / period
 * detection layer on top of that. Documented in the skill's notes.
 *
 * The cardinality + null rate this skill DOES return is enough for
 * the most common analyzer questions ("is this column dense?",
 * "are there many distinct timestamps?"); the profile.auto
 * dispatcher routes here for any temporal column rather than
 * silently treating dates as numeric.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

interface ProfileTemporalInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
}

interface ProfileTemporalOutput {
	readonly target: string;
	readonly column: string;
	readonly count: number | null;
	readonly nonNullCount: number | null;
	readonly nullCount: number | null;
	readonly distinctCount: number | null;
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
		'gap / period inference are follow-ups gated on a type-aware aggregation tool (the current ' +
		'`db_sql_aggregate` returns numerics only).',
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
	outputs: {
		type: 'object',
		properties: {
			target:        { type: 'string' },
			column:        { type: 'string' },
			count:         { type: ['number', 'null'] },
			nonNullCount:  { type: ['number', 'null'] },
			nullCount:     { type: ['number', 'null'] },
			distinctCount: { type: ['number', 'null'] },
		},
		required: ['target', 'column', 'count', 'nonNullCount', 'nullCount', 'distinctCount'],
		additionalProperties: false,
	},
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
			reason: 'RDBMS-only',
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
				aggregations: [
					{ column: input.column, function: 'count' },
					{ column: input.column, function: 'count_non_null' },
					{ column: input.column, function: 'distinct_count' },
				],
			},
		});

		if (tool.isError) {
			return {
				value: empty(input.target, input.column),
				confidence: 'low',
				notes: [`db_sql_aggregate error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		const data = tool.data;
		if (!isAggregateResult(data)) {
			return {
				value: empty(input.target, input.column),
				confidence: 'low',
				notes: ['db_sql_aggregate returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const col = input.column;
		const count = data.values[`${col}__count`] ?? null;
		const nonNullCount = data.values[`${col}__count_non_null`] ?? null;
		const nullCount = (count !== null && nonNullCount !== null) ? count - nonNullCount : null;

		return {
			value: {
				target: data.target,
				column: input.column,
				count,
				nonNullCount,
				nullCount,
				distinctCount: data.values[`${col}__distinct_count`] ?? null,
			},
			confidence: (nonNullCount ?? 0) > 0 ? 'high' : 'medium',
			notes: ['min/max range + gap/period inference deferred -- needs a type-aware aggregation surface'],
			toolCalls: [],
		};
	},
};

function empty(target: string, column: string): ProfileTemporalOutput {
	return { target, column, count: null, nonNullCount: null, nullCount: null, distinctCount: null };
}

interface AggregateResultRaw {
	readonly target: string;
	readonly values: Readonly<Record<string, number | null>>;
}

function isAggregateResult(v: unknown): v is AggregateResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && typeof o['values'] === 'object' && o['values'] !== null;
}

export function registerDataProfileTemporalRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
