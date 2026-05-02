/**
 * data.profile.categorical.rdbms -- Phase 5a.2 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Composite skill: profiles a categorical (string / enum / low-
 * cardinality) RDBMS column. Combines `db_sql_aggregate`
 * (count + non-null count) with `db_sql_distinct` (cardinality +
 * top-N). Returns frequency distribution + null rate so callers
 * can spot heavy skew, hidden-cardinality blow-ups, and top-K
 * categories without computing them in the LLM.
 *
 * Top-N defaults to 20; raise via input.topN (max 100 here -- the
 * underlying tool clamps higher to 1000 but a categorical profile
 * past 100 is usually noise).
 *
 * Confidence: `high` when at least one non-null value, `medium`
 * when zero, `low` if any tool errors. The registry's calibration
 * may clamp further.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult, SkillToolResult } from '../types.js';

interface ProfileCategoricalInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly topN?: number;
}

interface ValueFrequency {
	readonly value: unknown;
	readonly count: number;
	readonly frequency: number;  // count / nonNullCount; 0 when no observations
}

interface ProfileCategoricalOutput {
	readonly target: string;
	readonly column: string;
	readonly count: number | null;
	readonly nonNullCount: number | null;
	readonly nullCount: number | null;
	readonly distinctCount: number | null;
	readonly topValues: readonly ValueFrequency[];
}

const TOP_VALUES_SCHEMA = {
	type: 'array',
	items: {
		type: 'object',
		properties: {
			value:     {},
			count:     { type: 'number' },
			frequency: { type: 'number' },
		},
		required: ['value', 'count', 'frequency'],
		additionalProperties: false,
	},
} as const;

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
		'top-N values (count + frequency). Backs Family-5 categorical-profile callers with deterministic ' +
		'top-N ordering (count desc, value asc). Default topN=20, max 100.',
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
	outputs: {
		type: 'object',
		properties: {
			target:        { type: 'string' },
			column:        { type: 'string' },
			count:         { type: ['number', 'null'] },
			nonNullCount:  { type: ['number', 'null'] },
			nullCount:     { type: ['number', 'null'] },
			distinctCount: { type: ['number', 'null'] },
			topValues:     TOP_VALUES_SCHEMA,
		},
		required: ['target', 'column', 'count', 'nonNullCount', 'nullCount', 'distinctCount', 'topValues'],
		additionalProperties: false,
	},
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
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<ProfileCategoricalOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const topN = input.topN ?? 20;

		const [aggTool, distTool] = await Promise.all([
			deps.runTool({
				id: `${callBase}-agg`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: [
						{ column: input.column, function: 'count' },
						{ column: input.column, function: 'count_non_null' },
					],
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
			return {
				value: emptyProfile(input.target, input.column),
				confidence: 'low',
				notes: errors,
				toolCalls: [],
			};
		}

		const aggData = aggTool.data;
		const distData = distTool.data;
		if (!isAggregateResult(aggData) || !isDistinctResult(distData)) {
			return {
				value: emptyProfile(input.target, input.column),
				confidence: 'low',
				notes: ['categorical profile: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const col = input.column;
		const count = aggData.values[`${col}__count`] ?? null;
		const nonNullCount = aggData.values[`${col}__count_non_null`] ?? null;
		const nullCount = (count !== null && nonNullCount !== null) ? count - nonNullCount : null;

		const denom = nonNullCount !== null && nonNullCount > 0 ? nonNullCount : 0;
		const topValues: ValueFrequency[] = distData.topValues.map(v => ({
			value:     v.value,
			count:     v.count,
			frequency: denom > 0 ? v.count / denom : 0,
		}));

		const profile: ProfileCategoricalOutput = {
			target: aggData.target,
			column: input.column,
			count,
			nonNullCount,
			nullCount,
			distinctCount: distData.distinctCount,
			topValues,
		};

		const confidence = (nonNullCount ?? 0) > 0 ? 'high' : 'medium';
		return { value: profile, confidence, toolCalls: [] };
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

function emptyProfile(target: string, column: string): ProfileCategoricalOutput {
	return {
		target, column,
		count: null, nonNullCount: null, nullCount: null, distinctCount: null,
		topValues: [],
	};
}

interface AggregateResultRaw {
	readonly target: string;
	readonly values: Readonly<Record<string, number | null>>;
}

interface DistinctResultRaw {
	readonly target: string;
	readonly column: string;
	readonly distinctCount: number;
	readonly topValues: readonly { value: unknown; count: number }[];
}

function isAggregateResult(v: unknown): v is AggregateResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && typeof o['values'] === 'object' && o['values'] !== null;
}

function isDistinctResult(v: unknown): v is DistinctResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['column'] === 'string'
		&& typeof o['distinctCount'] === 'number'
		&& Array.isArray(o['topValues']);
}

export function registerDataProfileCategoricalRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
