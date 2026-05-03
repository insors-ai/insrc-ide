/**
 * data.source.file.describe -- Phase 1.3 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * One skill covering all 12 file kinds the consolidated DuckDB-backed
 * driver supports: csv / tsv / jsonl / ndjson / json / parquet / arrow
 * / feather (native readers) plus avro / bson / fixed-width / xlsx
 * (staged through Parquet converters). Native vs converted dispatch
 * is invisible at the skill layer -- the underlying tool handles it.
 *
 * The `target` parameter is honored for xlsx (sheet name); other
 * kinds ignore it.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

interface FileDescribeInput {
	readonly connectionId: string;
	readonly target?: string;
}

interface ColumnDescriptionOut {
	readonly name: string;
	readonly type: string;
	readonly nullable?: boolean;
}

interface SchemaDescriptionOut {
	readonly target: string;
	readonly columns: readonly ColumnDescriptionOut[];
	readonly source: 'introspect' | 'prisma' | 'header' | 'inferred';
}

const COLUMN_SCHEMA = {
	type: 'object',
	properties: {
		name:     { type: 'string' },
		type:     { type: 'string' },
		nullable: { type: 'boolean' },
	},
	required: ['name', 'type'],
	additionalProperties: false,
} as const;

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<FileDescribeInput, SchemaDescriptionOut> = {
	id: 'data.source.file.describe',
	name: 'File: describe schema',
	description:
		'Describe the schema of a file connection (csv / tsv / jsonl / ndjson / json / parquet / arrow / feather / ' +
		'avro / bson / fixed-width / xlsx). Returns columns + types + nullability via the consolidated DuckDB-backed ' +
		'driver. For xlsx, `target` selects a specific worksheet.',
	family: 'source-introspection',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string', description: 'File connection registered in the data-driver pool.' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name. Other kinds ignore it.' },
		},
		required: ['connectionId'],
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
	toolDeps: ['db_file_describe'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_file_describe'],
			reason: 'sole tool implementing file schema introspection',
		},
		{
			kind: 'connection-family',
			families: FILE_FAMILY_TAGS,
			reason: 'file describe is family-scoped; rdbms / kv connections route through their own describe skills',
		},
	],

	async execute(input, deps): Promise<SkillResult<SchemaDescriptionOut>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const toolInput: Record<string, unknown> = { connectionId: input.connectionId };
		if (input.target !== undefined && input.target.length > 0) {
			toolInput['target'] = input.target;
		}
		const tool = await deps.runTool({ id: callId, name: 'db_file_describe', input: toolInput });

		if (tool.isError) {
			return {
				value: emptySchema(input.target ?? input.connectionId),
				confidence: 'low',
				notes: [`db_file_describe error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}

		const data = tool.data;
		if (!isSchemaDescription(data)) {
			return {
				value: emptySchema(input.target ?? input.connectionId),
				confidence: 'low',
				notes: ['db_file_describe returned a result without the expected structured data shape'],
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
	return { target, columns: [], source: 'inferred' };
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

export function registerDataSourceFileDescribeSkill(): void {
	registerSkill(skill as unknown as Skill);
}
