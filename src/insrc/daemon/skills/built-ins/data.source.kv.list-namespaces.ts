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
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import type {
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

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
		// Substrate: cache hit short-circuits the tool call.
		const cached = readCachedListing(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.namespaces.length > 0 ? 'high' : 'medium',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

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

		if (data.namespaces.length > 0) {
			pinListing(input, data, deps);
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

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// Top-level KV namespace lists change slowly (DDL-ish for mongo /
// cassandra; key-space changes for redis / etcd); 7d TTL matches the
// other describe / introspect skills.

const OWNER_ID: OwnerId = 'skill:data.source.kv.list-namespaces';
const NAMESPACE = 'kv-namespace-listings';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: KvListNamespacesInput): string {
	return `${input.connectionId}::${input.limit ?? ''}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-listing',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as KvListNamespacesInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'KvListNamespacesOutput',
		autoDistill: 'always-on-success',
		indexing:    { kind: 'never' },
		ttl:         '7d',
	},
];

const substrateExtension: SubstrateSkillExtension = {
	ownerId:            OWNER_ID,
	schemaVersion:      1,
	interestedTriggers: INTERESTED_TRIGGERS,
	contextSlots:       CONTEXT_SLOTS,
	memorySchema:       MEMORY_SCHEMA,
	assertionInterests: [],
};

function readCachedListing(input: KvListNamespacesInput, deps: SkillDeps): KvListNamespacesOutput | undefined {
	const slot = deps.context?.slots.get('cached-listing');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<KvListNamespacesOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinListing(input: KvListNamespacesInput, value: KvListNamespacesOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_kv_list_namespaces' },
		payload: value,
		claims:  [`kv-list-namespaces:${cacheKey(input)}`],
		confidence: 0.95,
	});
	deps.workingState.pin(ref, {
		owner:     OWNER_ID,
		namespace: NAMESPACE,
		key:       cacheKey(input),
		kind:      'fact',
		ttlMs:     TTL_MS,
	});
}

const skillWithSubstrate = { ...skill, ...substrateExtension };

export function registerDataSourceKvListNamespacesSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
