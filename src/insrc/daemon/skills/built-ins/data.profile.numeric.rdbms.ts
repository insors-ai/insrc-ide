/**
 * data.profile.numeric.rdbms -- Phase 5a.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: server-side numeric profile of one RDBMS column.
 * Composes `db_sql_aggregate` (count / count_non_null / sum / avg /
 * stddev / variance / min / max / percentile + distinct_count) into
 * a single typed shape Family-5 callers can hand to a synthesise
 * step. Six tool-aggregate keys + one round-trip; **no statistical
 * computation in the LLM**.
 *
 * The skill body trusts the caller that the column is numeric; if
 * the engine refuses a function (e.g. avg over a string column) the
 * tool layer surfaces the error and confidence clamps to `low`.
 *
 * File-side equivalent (`data.profile.numeric.file`) is a follow-up
 * once a Family-5 file-flavoured workload demands it -- the
 * underlying `db_file_aggregate` already exposes the same surface.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

interface ProfileNumericInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
}

interface ProfileNumericOutput {
	readonly target: string;
	readonly column: string;
	readonly count: number | null;
	readonly nonNullCount: number | null;
	readonly nullCount: number | null;
	readonly distinctCount: number | null;
	readonly min: number | null;
	readonly max: number | null;
	readonly avg: number | null;
	readonly stddev: number | null;
	readonly variance: number | null;
	readonly p50: number | null;
	readonly p95: number | null;
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
	outputs: {
		type: 'object',
		properties: {
			target:        { type: 'string' },
			column:        { type: 'string' },
			count:         { type: ['number', 'null'] },
			nonNullCount:  { type: ['number', 'null'] },
			nullCount:     { type: ['number', 'null'] },
			distinctCount: { type: ['number', 'null'] },
			min:           { type: ['number', 'null'] },
			max:           { type: ['number', 'null'] },
			avg:           { type: ['number', 'null'] },
			stddev:        { type: ['number', 'null'] },
			variance:      { type: ['number', 'null'] },
			p50:           { type: ['number', 'null'] },
			p95:           { type: ['number', 'null'] },
		},
		required: [
			'target', 'column', 'count', 'nonNullCount', 'nullCount', 'distinctCount',
			'min', 'max', 'avg', 'stddev', 'variance', 'p50', 'p95',
		],
		additionalProperties: false,
	},
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
			reason: 'RDBMS-only; file connections will route through a future profile.numeric.file skill',
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
				aggregations: [
					{ column: input.column, function: 'count' },
					{ column: input.column, function: 'count_non_null' },
					{ column: input.column, function: 'distinct_count' },
					{ column: input.column, function: 'min' },
					{ column: input.column, function: 'max' },
					{ column: input.column, function: 'avg' },
					{ column: input.column, function: 'stddev' },
					{ column: input.column, function: 'variance' },
					{ column: input.column, function: 'percentile', args: { p: 0.5 } },
					{ column: input.column, function: 'percentile', args: { p: 0.95 } },
				],
			},
		});

		if (tool.isError) {
			return {
				value: emptyProfile(input.target, input.column),
				confidence: 'low',
				notes: [`db_sql_aggregate error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}

		const data = tool.data;
		if (!isAggregateResult(data)) {
			return {
				value: emptyProfile(input.target, input.column),
				confidence: 'low',
				notes: ['db_sql_aggregate returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const v = data.values;
		const col = input.column;
		const count = v[`${col}__count`] ?? null;
		const nonNullCount = v[`${col}__count_non_null`] ?? null;
		const nullCount = (count !== null && nonNullCount !== null) ? count - nonNullCount : null;

		const profile: ProfileNumericOutput = {
			target: data.target,
			column: input.column,
			count,
			nonNullCount,
			nullCount,
			distinctCount: v[`${col}__distinct_count`] ?? null,
			min:           v[`${col}__min`]            ?? null,
			max:           v[`${col}__max`]            ?? null,
			avg:           v[`${col}__avg`]            ?? null,
			stddev:        v[`${col}__stddev`]         ?? null,
			variance:      v[`${col}__variance`]      ?? null,
			p50:           v[`${col}__percentile_0_5`]  ?? null,
			p95:           v[`${col}__percentile_0_95`] ?? null,
		};

		// `medium` when the column is empty / all-null (no observations
		// to report); `high` otherwise. The registry's calibration may
		// further clamp from precondition failures.
		const confidence = (profile.nonNullCount ?? 0) > 0 ? 'high' : 'medium';
		return { value: profile, confidence, toolCalls: [] };
	},
};

function emptyProfile(target: string, column: string): ProfileNumericOutput {
	return {
		target, column,
		count: null, nonNullCount: null, nullCount: null, distinctCount: null,
		min: null, max: null, avg: null, stddev: null, variance: null,
		p50: null, p95: null,
	};
}

interface AggregateResultRaw {
	readonly target: string;
	readonly values: Readonly<Record<string, number | null>>;
}

function isAggregateResult(v: unknown): v is AggregateResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['values'] === 'object'
		&& o['values'] !== null;
}

export function registerDataProfileNumericRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
