/**
 * data.source.rdbms.sample-distinct -- Phase 2.1 of
 * plans/analyzers/data-analyzer-skills.md (the second half; the
 * `sample-rows` half shipped earlier).
 *
 * Atomic skill: thin typed wrapper over `db_sql_distinct`. Returns
 * the column's distinct cardinality plus its top-N most-frequent
 * values (deterministic ordering: count desc, value asc).
 *
 * Family-5 categorical-profile skills (5a.2, 5d.2) are the primary
 * consumers -- they need a value distribution that the LLM never
 * computes from a row sample.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

interface RdbmsSampleDistinctInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly topN?: number;
}

interface DistinctValuePair {
	readonly value: unknown;
	readonly count: number;
}

interface RdbmsSampleDistinctOutput {
	readonly target: string;
	readonly column: string;
	readonly distinctCount: number;
	readonly topValues: readonly DistinctValuePair[];
}

const TOP_VALUES_SCHEMA = {
	type: 'array',
	items: {
		type: 'object',
		properties: {
			value: {},
			count: { type: 'number' },
		},
		required: ['value', 'count'],
		additionalProperties: false,
	},
} as const;

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<RdbmsSampleDistinctInput, RdbmsSampleDistinctOutput> = {
	id: 'data.source.rdbms.sample-distinct',
	name: 'RDBMS: top-N distinct values',
	description:
		'Top-N most-frequent distinct values for one RDBMS column plus its overall distinct cardinality. ' +
		'Order: count desc, value asc (deterministic). Default topN=20, max 1000. Server-side aggregation ' +
		'-- the LLM never computes a top-N from row samples.',
	family: 'source-sampling',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			topN:         { type: 'integer', minimum: 1, maximum: 1000 },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:        { type: 'string' },
			column:        { type: 'string' },
			distinctCount: { type: 'number' },
			topValues:     TOP_VALUES_SCHEMA,
		},
		required: ['target', 'column', 'distinctCount', 'topValues'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_distinct'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_distinct'],
			reason: 'sole tool implementing RDBMS distinct sampling',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'sample-distinct is RDBMS-only; file connections use db_file_distinct via a future file skill',
		},
	],

	async execute(input, deps): Promise<SkillResult<RdbmsSampleDistinctOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const toolInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			target:       input.target,
			column:       input.column,
		};
		if (input.topN !== undefined) toolInput['topN'] = input.topN;

		const tool = await deps.runTool({ id: callId, name: 'db_sql_distinct', input: toolInput });

		if (tool.isError) {
			return {
				value: emptyResult(input.target, input.column),
				confidence: 'low',
				notes: [`db_sql_distinct error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}

		const data = tool.data;
		if (!isDistinctResult(data)) {
			return {
				value: emptyResult(input.target, input.column),
				confidence: 'low',
				notes: ['db_sql_distinct returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		return {
			value: {
				target:        data.target,
				column:        data.column,
				distinctCount: data.distinctCount,
				topValues:     data.topValues,
			},
			// `medium` when the column is empty (distinctCount=0) -- the
			// query ran clean, but downstream profilers should be careful
			// extrapolating from zero observations.
			confidence: data.distinctCount > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

function emptyResult(target: string, column: string): RdbmsSampleDistinctOutput {
	return { target, column, distinctCount: 0, topValues: [] };
}

interface DistinctResultRaw {
	readonly target: string;
	readonly column: string;
	readonly distinctCount: number;
	readonly topValues: readonly DistinctValuePair[];
}

function isDistinctResult(v: unknown): v is DistinctResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['column'] === 'string'
		&& typeof o['distinctCount'] === 'number'
		&& Array.isArray(o['topValues']);
}

export function registerDataSourceRdbmsSampleDistinctSkill(): void {
	registerSkill(skill as unknown as Skill);
}
