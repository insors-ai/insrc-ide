/**
 * data.source.kv.get-value -- Phase 2.2 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin typed wrapper over `db_kv_get`. Reads one key
 * from a KV connection.
 *
 * Key shape varies by store: string for redis / valkey / keydb /
 * nats; object for mongodb (`{db, collection, _id}`), cassandra
 * (`{keyspace, table, ...pkCols}`), and other composite-key stores.
 * The skill passes `key` through unchanged.
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

interface KvGetValueInput {
	readonly connectionId: string;
	readonly key: string | Readonly<Record<string, unknown>>;
}

type KvKey = string | Readonly<Record<string, unknown>>;
type KvValueType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'binary' | 'null';

interface KvGetValueOutput {
	readonly key: KvKey;
	readonly value: unknown;
	readonly type: KvValueType;
}

const KV_FAMILY_TAGS = [
	'kv',
	'redis', 'valkey', 'keydb',
	'mongodb', 'cassandra',
	'nats', 'dynamodb', 'etcd', 'memcached',
] as const;

const skill: Skill<KvGetValueInput, KvGetValueOutput> = {
	id: 'data.source.kv.get-value',
	name: 'KV: get value',
	description:
		'Read a single key from a KV connection. String key for flat stores (redis / valkey / keydb / nats); ' +
		'object key for composite stores (mongo: {db, collection, _id}; cassandra: {keyspace, table, ...pkCols}).',
	family: 'source-sampling',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			key: {
				anyOf: [
					{ type: 'string' },
					{ type: 'object' },
				],
			},
		},
		required: ['connectionId', 'key'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			key:   { anyOf: [{ type: 'string' }, { type: 'object' }] },
			value: {},
			type:  { type: 'string', enum: ['string', 'number', 'boolean', 'object', 'array', 'binary', 'null'] },
		},
		required: ['key', 'value', 'type'],
		additionalProperties: false,
	},
	toolDeps: ['db_kv_get'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_kv_get'],
			reason: 'sole tool implementing single-key read',
		},
		{
			kind: 'connection-family',
			families: KV_FAMILY_TAGS,
			reason: 'get-value is KV-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<KvGetValueOutput>> {
		// Substrate: cache hit short-circuits the tool call.
		const cached = readCachedValue(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.type === 'null' ? 'medium' : 'high',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const tool = await deps.runTool({
			id: callId,
			name: 'db_kv_get',
			input: { connectionId: input.connectionId, key: input.key },
		});

		if (tool.isError) {
			return {
				value: emptyValue(input.key),
				confidence: 'low',
				notes: [`db_kv_get error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}

		const data = tool.data;
		if (!isKvValue(data)) {
			return {
				value: emptyValue(input.key),
				confidence: 'low',
				notes: ['db_kv_get returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const value: KvGetValueOutput = { key: data.key, value: data.value, type: data.type };
		if (data.type !== 'null') {
			pinValue(input, value, deps);
		}
		return {
			value,
			confidence: data.type === 'null' ? 'medium' : 'high',
			toolCalls: [],
		};
	},
};

function emptyValue(key: KvKey): KvGetValueOutput {
	return { key, value: null, type: 'null' };
}

interface KvValueRaw {
	readonly key: KvKey;
	readonly value: unknown;
	readonly type: KvValueType;
}

function isKvValue(v: unknown): v is KvValueRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	const t = o['type'];
	return (typeof o['key'] === 'string' || typeof o['key'] === 'object')
		&& 'value' in o
		&& (t === 'string' || t === 'number' || t === 'boolean'
		    || t === 'object' || t === 'array' || t === 'binary' || t === 'null');
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// KV values reflect live data; 1h TTL keeps the cache short. Null /
// missing keys deliberately skip the cache so a later write becomes
// visible without waiting for TTL expiry.

const OWNER_ID: OwnerId = 'skill:data.source.kv.get-value';
const NAMESPACE = 'kv-values';
const TTL_MS = 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: KvGetValueInput): string {
	const keyRepr = typeof input.key === 'string' ? input.key : JSON.stringify(input.key);
	return `${input.connectionId}::${keyRepr}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-value',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as KvGetValueInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'KvGetValueOutput',
		autoDistill: 'always-on-success',
		indexing:    { kind: 'never' },
		ttl:         '1h',
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

function readCachedValue(input: KvGetValueInput, deps: SkillDeps): KvGetValueOutput | undefined {
	const slot = deps.context?.slots.get('cached-value');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<KvGetValueOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinValue(input: KvGetValueInput, value: KvGetValueOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_kv_get' },
		payload: value,
		claims:  [`kv-get:${cacheKey(input)}`],
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

export function registerDataSourceKvGetValueSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
