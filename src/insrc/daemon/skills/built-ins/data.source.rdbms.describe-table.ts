/**
 * data.source.rdbms.describe-table -- Phase 1.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin typed wrapper over `db_sql_describe`. Returns
 * the table / view's columns + types + nullability + PK / FK info as
 * a `SchemaDescription`. The underlying tool already enforces the
 * RDBMS family check at the driver layer; the skill's
 * `connection-family` precondition exists for early planner
 * feasibility (so a plan against a file connection drops this skill
 * before any tool dispatch).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

interface RdbmsDescribeTableInput {
	readonly connectionId: string;
	readonly target: string;
}

interface ForeignKeyRef {
	readonly table: string;
	readonly column: string;
}

interface ColumnDescriptionOut {
	readonly name: string;
	readonly type: string;
	readonly nullable?: boolean;
	readonly primaryKey?: boolean;
	readonly foreignKey?: ForeignKeyRef;
}

interface SchemaDescriptionOut {
	readonly target: string;
	readonly columns: readonly ColumnDescriptionOut[];
	readonly source: 'introspect' | 'prisma' | 'header' | 'inferred';
}

const COLUMN_SCHEMA = {
	type: 'object',
	properties: {
		name:       { type: 'string' },
		type:       { type: 'string' },
		nullable:   { type: 'boolean' },
		primaryKey: { type: 'boolean' },
		foreignKey: {
			type: 'object',
			properties: {
				table:  { type: 'string' },
				column: { type: 'string' },
			},
			required: ['table', 'column'],
			additionalProperties: false,
		},
	},
	required: ['name', 'type'],
	additionalProperties: false,
} as const;

// Driver kinds that register under family: 'rdbms' in
// daemon/db/drivers/. Any kind in this list is a valid target for
// this skill; running against a file / kv connection trips the
// family-precondition.
const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<RdbmsDescribeTableInput, SchemaDescriptionOut> = {
	id: 'data.source.rdbms.describe-table',
	name: 'RDBMS: describe table',
	description:
		'Describe the schema of a single RDBMS table or view: columns, types, nullability, primary + foreign keys. ' +
		'Wraps the db_sql_describe tool; the calling agent gets a typed SchemaDescription it can hand to a synthesise step.',
	family: 'source-introspection',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string', description: 'Connection registered in the data-driver pool.' },
			target:       { type: 'string', description: 'Table or view name; `schema.table` accepted.' },
		},
		required: ['connectionId', 'target'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:  { type: 'string' },
			columns: { type: 'array', items: COLUMN_SCHEMA },
			source:  { type: 'string', enum: ['introspect', 'prisma', 'header', 'inferred'] },
		},
		required: ['target', 'columns', 'source'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_describe'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_describe'],
			reason: 'sole tool implementing RDBMS catalog introspection',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'describe-table is RDBMS-only; file / kv connections route through their own describe skills',
		},
	],

	async execute(input, deps): Promise<SkillResult<SchemaDescriptionOut>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const tool = await deps.runTool({
			id: callId,
			name: 'db_sql_describe',
			input: { connectionId: input.connectionId, target: input.target },
		});

		if (tool.isError) {
			return {
				value: emptySchema(input.target),
				confidence: 'low',
				notes: [`db_sql_describe error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}

		const data = tool.data;
		if (!isSchemaDescription(data)) {
			return {
				value: emptySchema(input.target),
				confidence: 'low',
				notes: ['db_sql_describe returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		return {
			value: {
				target:  data.target,
				columns: data.columns,
				source:  data.source,
			},
			confidence: data.columns.length > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

function emptySchema(target: string): SchemaDescriptionOut {
	return { target, columns: [], source: 'introspect' };
}

function isSchemaDescription(v: unknown): v is SchemaDescriptionOut {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	if (typeof o['target'] !== 'string') return false;
	if (!Array.isArray(o['columns'])) return false;
	const src = o['source'];
	if (src !== 'introspect' && src !== 'prisma' && src !== 'header' && src !== 'inferred') return false;
	return true;
}

export function registerDataSourceRdbmsDescribeTableSkill(): void {
	registerSkill(skill as unknown as Skill);
}
