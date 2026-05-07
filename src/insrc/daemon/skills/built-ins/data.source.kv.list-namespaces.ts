/**
 * data.source.kv.list-namespaces -- Phase 1.2 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin typed wrapper over `db_kv_list_namespaces`.
 * Enumerates top-level namespaces on a KV connection -- Mongo
 * collections (`<db>.<coll>`), Cassandra tables
 * (`<keyspace>.<table>`), DynamoDB tables, NATS KV bucket, and
 * Redis / etcd scan-derived prefixes. Memcached returns
 * `supported: false` (no namespace concept).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

interface KvListNamespacesInput {
	readonly connectionId: string;
	readonly limit?: number;
}

interface KvNamespaceEntry {
	readonly name: string;
	readonly kind?: 'collection' | 'table' | 'bucket' | 'prefix';
	readonly approxCount?: number;
}

interface KvListNamespacesOutput {
	readonly namespaces: readonly KvNamespaceEntry[];
	readonly truncated: boolean;
	readonly supported: boolean;
}

const KV_NAMESPACE_ENTRY_SCHEMA = {
	type: 'object',
	properties: {
		name:        { type: 'string' },
		kind:        { type: 'string', enum: ['collection', 'table', 'bucket', 'prefix'] },
		approxCount: { type: 'number' },
	},
	required: ['name'],
	additionalProperties: false,
} as const;

const KV_FAMILY_TAGS = [
	'kv',
	'redis', 'valkey', 'keydb',
	'mongodb', 'cassandra',
	'nats', 'dynamodb', 'etcd', 'memcached',
] as const;

const skill: Skill<KvListNamespacesInput, KvListNamespacesOutput> = {
	id: 'data.source.kv.list-namespaces',
	name: 'KV: list namespaces',
	description:
		'Enumerate top-level namespaces on a KV connection: Mongo collections (`<db>.<coll>`), Cassandra ' +
		'tables (`<keyspace>.<table>`), DynamoDB tables, NATS KV bucket, Redis / etcd scan-derived prefixes. ' +
		'Memcached returns `supported: false`.',
	family: 'source-introspection',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			limit:        { type: 'integer', minimum: 1, maximum: 1000 },
		},
		required: ['connectionId'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			namespaces: { type: 'array', items: KV_NAMESPACE_ENTRY_SCHEMA },
			truncated:  { type: 'boolean' },
			supported:  { type: 'boolean' },
		},
		required: ['namespaces', 'truncated', 'supported'],
		additionalProperties: false,
	},
	toolDeps: ['db_kv_list_namespaces'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_kv_list_namespaces'],
			reason: 'sole tool that enumerates KV namespaces',
		},
		{
			kind: 'connection-family',
			families: KV_FAMILY_TAGS,
			reason: 'list-namespaces is KV-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<KvListNamespacesOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const toolInput: Record<string, unknown> = { connectionId: input.connectionId };
		if (input.limit !== undefined) toolInput['limit'] = input.limit;

		const tool = await deps.runTool({ id: callId, name: 'db_kv_list_namespaces', input: toolInput });

		if (tool.isError) {
			return {
				value: { namespaces: [], truncated: false, supported: false },
				confidence: 'low',
				notes: [`db_kv_list_namespaces error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}

		const data = tool.data;
		if (!isKvNamespaceList(data)) {
			return {
				value: { namespaces: [], truncated: false, supported: false },
				confidence: 'low',
				notes: ['db_kv_list_namespaces returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		if (!data.supported) {
			return {
				value: data,
				confidence: 'low',
				notes: ['driver does not expose namespaces (e.g. memcached)'],
				toolCalls: [],
			};
		}

		return {
			value: data,
			confidence: data.namespaces.length > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

function isKvNamespaceList(v: unknown): v is KvListNamespacesOutput {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return Array.isArray(o['namespaces'])
		&& typeof o['truncated'] === 'boolean'
		&& typeof o['supported'] === 'boolean';
}

export function registerDataSourceKvListNamespacesSkill(): void {
	registerSkill(skill as unknown as Skill);
}
