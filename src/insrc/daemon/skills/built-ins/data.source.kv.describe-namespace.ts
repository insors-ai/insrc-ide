/**
 * data.source.kv.describe-namespace -- Phase 1.2 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin typed wrapper over `db_kv_describe_namespace`.
 * Returns shape + sample keys for one KV namespace. For Mongo /
 * Cassandra / DynamoDB the underlying tool returns the engine's
 * native schema info; for Redis / etcd / NATS it samples values
 * under the namespace prefix and infers a JSON shape. Memcached
 * returns `supported: false`.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

interface KvDescribeNamespaceInput {
	readonly connectionId: string;
	readonly namespace: string;
	readonly sampleSize?: number;
}

interface KvNamespaceField {
	readonly path: string;
	readonly types: readonly string[];
	readonly nullable: boolean;
	readonly frequency: number;
}

interface KvDescribeNamespaceOutput {
	readonly name: string;
	readonly kind?: 'collection' | 'table' | 'bucket' | 'prefix';
	readonly approxCount: number | null;
	readonly sampleKeys: readonly string[];
	readonly fields: readonly KvNamespaceField[];
	readonly supported: boolean;
}

const KV_FIELD_SCHEMA = {
	type: 'object',
	properties: {
		path:      { type: 'string' },
		types:     { type: 'array', items: { type: 'string' } },
		nullable:  { type: 'boolean' },
		frequency: { type: 'number' },
	},
	required: ['path', 'types', 'nullable', 'frequency'],
	additionalProperties: false,
} as const;

const KV_FAMILY_TAGS = [
	'kv',
	'redis', 'valkey', 'keydb',
	'mongodb', 'cassandra',
	'nats', 'dynamodb', 'etcd', 'memcached',
] as const;

const skill: Skill<KvDescribeNamespaceInput, KvDescribeNamespaceOutput> = {
	id: 'data.source.kv.describe-namespace',
	name: 'KV: describe namespace',
	description:
		'Shape + sample keys for one KV namespace. Mongo / Cassandra / DynamoDB return engine-native schema; ' +
		'Redis / etcd / NATS sample values and infer a JSON shape. Memcached returns `supported: false`. ' +
		'Pairs with data.source.kv.list-namespaces.',
	family: 'source-introspection',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			namespace:    { type: 'string' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 200 },
		},
		required: ['connectionId', 'namespace'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			name:        { type: 'string' },
			kind:        { type: 'string', enum: ['collection', 'table', 'bucket', 'prefix'] },
			approxCount: { type: ['number', 'null'] },
			sampleKeys:  { type: 'array', items: { type: 'string' } },
			fields:      { type: 'array', items: KV_FIELD_SCHEMA },
			supported:   { type: 'boolean' },
		},
		required: ['name', 'approxCount', 'sampleKeys', 'fields', 'supported'],
		additionalProperties: false,
	},
	toolDeps: ['db_kv_describe_namespace'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_kv_describe_namespace'],
			reason: 'sole tool that describes a KV namespace',
		},
		{
			kind: 'connection-family',
			families: KV_FAMILY_TAGS,
			reason: 'describe-namespace is KV-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<KvDescribeNamespaceOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const toolInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			namespace:    input.namespace,
		};
		if (input.sampleSize !== undefined) toolInput['sampleSize'] = input.sampleSize;

		const tool = await deps.runTool({ id: callId, name: 'db_kv_describe_namespace', input: toolInput });

		if (tool.isError) {
			return {
				value: emptyValue(input.namespace),
				confidence: 'low',
				notes: [`db_kv_describe_namespace error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}

		const data = tool.data;
		if (!isKvNamespaceDescription(data)) {
			return {
				value: emptyValue(input.namespace),
				confidence: 'low',
				notes: ['db_kv_describe_namespace returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		if (!data.supported) {
			return {
				value: data,
				confidence: 'low',
				notes: ['driver does not expose namespace shape (e.g. memcached)'],
				toolCalls: [],
			};
		}

		// Confidence ladder: high when we have either schema fields or sample keys; medium when neither
		// (empty namespace, supported driver); low handled above for unsupported / errors.
		const haveEvidence = data.fields.length > 0 || data.sampleKeys.length > 0;
		return {
			value: data,
			confidence: haveEvidence ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

function emptyValue(namespace: string): KvDescribeNamespaceOutput {
	return { name: namespace, approxCount: null, sampleKeys: [], fields: [], supported: false };
}

function isKvNamespaceDescription(v: unknown): v is KvDescribeNamespaceOutput {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['name'] === 'string'
		&& Array.isArray(o['sampleKeys'])
		&& Array.isArray(o['fields'])
		&& typeof o['supported'] === 'boolean'
		&& (o['approxCount'] === null || typeof o['approxCount'] === 'number');
}

export function registerDataSourceKvDescribeNamespaceSkill(): void {
	registerSkill(skill as unknown as Skill);
}
