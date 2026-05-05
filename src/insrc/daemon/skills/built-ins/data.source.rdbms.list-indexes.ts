/**
 * data.source.rdbms.list-indexes -- Phase 1.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin typed wrapper over `db_sql_list_indexes`. Returns
 * the indexes on a single table (name + columns + unique flag + PK flag)
 * as a structured IndexListing.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

interface ListIndexesInput {
	readonly connectionId: string;
	readonly target: string;
}

interface IndexEntry {
	readonly name: string;
	readonly columns: readonly string[];
	readonly unique: boolean;
	readonly primaryKey: boolean;
}

interface IndexListingOut {
	readonly target: string;
	readonly indexes: readonly IndexEntry[];
}

const INDEX_SCHEMA = {
	type: 'object',
	properties: {
		name:       { type: 'string' },
		columns:    { type: 'array', items: { type: 'string' } },
		unique:     { type: 'boolean' },
		primaryKey: { type: 'boolean' },
	},
	required: ['name', 'columns', 'unique', 'primaryKey'],
	additionalProperties: false,
} as const;

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<ListIndexesInput, IndexListingOut> = {
	id: 'data.source.rdbms.list-indexes',
	name: 'RDBMS: list indexes',
	description:
		'List indexes on one RDBMS table -- name, columns (in key order), unique flag, primary-key flag. ' +
		'Useful for verifying that filter / join columns are indexed before recommending query rewrites.',
	family: 'source-introspection',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
		},
		required: ['connectionId', 'target'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:  { type: 'string' },
			indexes: { type: 'array', items: INDEX_SCHEMA },
		},
		required: ['target', 'indexes'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_list_indexes'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_list_indexes'], reason: 'sole tool that enumerates RDBMS indexes' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<IndexListingOut>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const tool = await deps.runTool({
			id: callId,
			name: 'db_sql_list_indexes',
			input: { connectionId: input.connectionId, target: input.target },
		});
		if (tool.isError) {
			return { value: { target: input.target, indexes: [] }, confidence: 'low', notes: [`db_sql_list_indexes error: ${tool.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isIndexListing(tool.data)) {
			return { value: { target: input.target, indexes: [] }, confidence: 'low', notes: ['db_sql_list_indexes returned a result without the expected structured data shape'], toolCalls: [] };
		}
		return {
			value: tool.data,
			confidence: tool.data.indexes.length > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

function isIndexListing(v: unknown): v is IndexListingOut {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && Array.isArray(o['indexes']);
}

export function registerDataSourceRdbmsListIndexesSkill(): void {
	registerSkill(skill as unknown as Skill);
}
