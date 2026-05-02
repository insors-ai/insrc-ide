/**
 * data.source.kv.scan-keys -- Phase 2.2 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin typed wrapper over `db_kv_scan`. Lists keys on
 * a KV connection (redis / valkey / keydb / mongodb / cassandra /
 * nats / dynamodb / etcd / memcached) by glob pattern or prefix.
 * Clamped at 500 keys per the underlying tool.
 *
 * The skill returns keys verbatim -- redis-style flat strings come
 * back as strings; mongo / cassandra composite keys come back as
 * objects. Callers branch on `kind` if they need a single shape.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

interface KvScanKeysInput {
	readonly connectionId: string;
	readonly pattern?: string;
	readonly prefix?: string;
	readonly limit?: number;
}

type KvKey = string | Readonly<Record<string, unknown>>;

interface KvScanKeysOutput {
	readonly keys: readonly KvKey[];
	readonly truncated: boolean;
}

const KV_FAMILY_TAGS = [
	'kv',
	'redis', 'valkey', 'keydb',
	'mongodb', 'cassandra',
	'nats', 'dynamodb', 'etcd', 'memcached',
] as const;

const skill: Skill<KvScanKeysInput, KvScanKeysOutput> = {
	id: 'data.source.kv.scan-keys',
	name: 'KV: scan keys',
	description:
		'List keys on a KV connection by glob pattern or prefix. Covers redis / valkey / keydb / mongodb / ' +
		'cassandra / nats / dynamodb / etcd / memcached. Clamped at 500 keys + 5s wall-clock.',
	family: 'source-sampling',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			pattern:      { type: 'string', description: 'Glob (redis) or subject-wildcard (nats).' },
			prefix:       { type: 'string', description: 'Key prefix; mutually exclusive with pattern in practice.' },
			limit:        { type: 'integer', minimum: 1, maximum: 500 },
		},
		required: ['connectionId'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			keys:      { type: 'array' },
			truncated: { type: 'boolean' },
		},
		required: ['keys', 'truncated'],
		additionalProperties: false,
	},
	toolDeps: ['db_kv_scan'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_kv_scan'],
			reason: 'sole tool implementing KV key enumeration',
		},
		{
			kind: 'connection-family',
			families: KV_FAMILY_TAGS,
			reason: 'scan-keys is KV-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<KvScanKeysOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const limit = clampLimit(input.limit);
		const toolInput: Record<string, unknown> = { connectionId: input.connectionId, limit };
		if (input.pattern !== undefined) toolInput['pattern'] = input.pattern;
		if (input.prefix  !== undefined) toolInput['prefix']  = input.prefix;

		const tool = await deps.runTool({ id: callId, name: 'db_kv_scan', input: toolInput });

		if (tool.isError) {
			return {
				value: { keys: [], truncated: false },
				confidence: 'low',
				notes: [`db_kv_scan error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}

		const data = tool.data;
		if (!isKeyList(data)) {
			return {
				value: { keys: [], truncated: false },
				confidence: 'low',
				notes: ['db_kv_scan returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		return {
			value: { keys: data.keys, truncated: data.truncated },
			confidence: data.keys.length > 0 ? 'high' : 'medium',
			...(data.truncated ? { truncated: true } : {}),
			toolCalls: [],
		};
	},
};

function clampLimit(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 200;
	return Math.min(Math.max(1, Math.floor(n)), 500);
}

interface KeyListRaw {
	readonly keys: readonly KvKey[];
	readonly truncated: boolean;
}

function isKeyList(v: unknown): v is KeyListRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return Array.isArray(o['keys']) && typeof o['truncated'] === 'boolean';
}

export function registerDataSourceKvScanKeysSkill(): void {
	registerSkill(skill as unknown as Skill);
}
