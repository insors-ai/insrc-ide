/**
 * data.source.rdbms.list-indexes -- Phase 1.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin typed wrapper over `db_sql_list_indexes`. Returns
 * the indexes on a single table (name + columns + unique flag + PK flag)
 * as a structured IndexListing.
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
		// Substrate: cache hit short-circuits the tool call.
		const cached = readCachedListing(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.indexes.length > 0 ? 'high' : 'medium',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

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
		const value: IndexListingOut = tool.data;
		pinListing(input, value, deps);
		return {
			value,
			confidence: value.indexes.length > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

function isIndexListing(v: unknown): v is IndexListingOut {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && Array.isArray(o['indexes']);
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// Index metadata changes only on DDL; 7d TTL matches the
// describe-table TTL. Reindex triggers force a refresh.

const OWNER_ID: OwnerId = 'skill:data.source.rdbms.list-indexes';
const NAMESPACE = 'index-listings';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: ListIndexesInput): string {
	return `${input.connectionId}::${input.target}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-listing',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as ListIndexesInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'IndexListingOut',
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

function readCachedListing(input: ListIndexesInput, deps: SkillDeps): IndexListingOut | undefined {
	const slot = deps.context?.slots.get('cached-listing');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<IndexListingOut>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinListing(input: ListIndexesInput, value: IndexListingOut, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_list_indexes' },
		payload: value,
		claims:  [`list-indexes:${cacheKey(input)}`],
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

export function registerDataSourceRdbmsListIndexesSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
