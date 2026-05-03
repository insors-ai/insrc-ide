/**
 * data.source.rdbms.sample-rows -- Phase 2.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin typed wrapper over `db_sql_sample`. Returns up
 * to 50 rows from an RDBMS table / view with optional structured
 * WHERE filtering. Raw SQL is never accepted -- the WHERE is built
 * from `{ column, op, value }` records that compile through the
 * driver's `compileWhere` helper.
 *
 * Phase 2.1 also calls out a `sample-distinct` companion skill;
 * that's deferred until the underlying `db_sql_distinct` tool lands
 * (Phase 0.3).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

interface WhereClauseIn {
	readonly column: string;
	readonly op: '=' | '!=' | 'in' | 'is null';
	readonly value?: unknown;
}

interface RdbmsSampleRowsInput {
	readonly connectionId: string;
	readonly target: string;
	readonly limit?: number;
	readonly where?: readonly WhereClauseIn[];
}

interface RdbmsSampleRowsOutput {
	readonly target: string;
	readonly columns: readonly string[];
	readonly rows: readonly Readonly<Record<string, unknown>>[];
	readonly truncated: boolean;
	readonly samplingMethod: string;
}

const WHERE_SCHEMA = {
	type: 'array',
	items: {
		type: 'object',
		properties: {
			column: { type: 'string' },
			op:     { type: 'string', enum: ['=', '!=', 'in', 'is null'] },
			value:  {},
		},
		required: ['column', 'op'],
		additionalProperties: false,
	},
} as const;

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<RdbmsSampleRowsInput, RdbmsSampleRowsOutput> = {
	id: 'data.source.rdbms.sample-rows',
	name: 'RDBMS: sample rows',
	description:
		'Sample up to 50 rows from an RDBMS table / view with optional structured WHERE. ' +
		'Raw SQL is never accepted; WHERE clauses are { column, op, value } objects validated against describe().',
	family: 'source-sampling',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string', description: 'Table or view name; `schema.table` accepted.' },
			limit:        { type: 'integer', minimum: 1, maximum: 50 },
			where:        WHERE_SCHEMA,
		},
		required: ['connectionId', 'target'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:         { type: 'string' },
			columns:        { type: 'array', items: { type: 'string' } },
			rows:           { type: 'array' },
			truncated:      { type: 'boolean' },
			samplingMethod: { type: 'string' },
		},
		required: ['target', 'columns', 'rows', 'truncated', 'samplingMethod'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_sample'],
			reason: 'sole tool implementing RDBMS row-sampling',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'sample-rows is RDBMS-only; file / kv connections route through their own sampling skills',
		},
	],

	async execute(input, deps): Promise<SkillResult<RdbmsSampleRowsOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const limit = clampLimit(input.limit);
		const toolInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			target:       input.target,
			limit,
		};
		if (input.where !== undefined && input.where.length > 0) toolInput['where'] = input.where;

		const tool = await deps.runTool({ id: callId, name: 'db_sql_sample', input: toolInput });

		if (tool.isError) {
			return {
				value: emptyResult(input.target),
				confidence: 'low',
				notes: [`db_sql_sample error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}

		const data = tool.data;
		if (!isSampleResult(data)) {
			return {
				value: emptyResult(input.target),
				confidence: 'low',
				notes: ['db_sql_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		return {
			value: {
				target:         data.target,
				columns:        data.columns,
				rows:           data.rows,
				truncated:      data.truncated,
				samplingMethod: data.metadata?.samplingMethod ?? 'first',
			},
			confidence: data.rows.length > 0 ? 'high' : 'medium',
			...(data.truncated ? { truncated: true } : {}),
			toolCalls: [],
		};
	},
};

function clampLimit(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 50;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

function emptyResult(target: string): RdbmsSampleRowsOutput {
	return { target, columns: [], rows: [], truncated: false, samplingMethod: 'first' };
}

interface SampleResultRaw {
	readonly target: string;
	readonly columns: readonly string[];
	readonly rows: readonly Readonly<Record<string, unknown>>[];
	readonly truncated: boolean;
	readonly metadata?: { readonly samplingMethod?: string };
}

function isSampleResult(v: unknown): v is SampleResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& Array.isArray(o['columns'])
		&& Array.isArray(o['rows'])
		&& typeof o['truncated'] === 'boolean';
}

export function registerDataSourceRdbmsSampleRowsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
