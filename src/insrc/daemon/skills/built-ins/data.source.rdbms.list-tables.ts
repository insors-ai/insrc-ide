/**
 * data.source.rdbms.list-tables -- Phase 1.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin typed wrapper over `db_sql_list_tables`. Returns
 * the connection's tables + views (excluding system schemas) as a
 * structured TableListing.
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

interface ListTablesInput {
	readonly connectionId: string;
	readonly schema?: string;
	readonly limit?: number;
}

interface TableEntry {
	readonly name: string;
	readonly schema?: string;
	readonly kind: 'table' | 'view' | 'unknown';
	readonly approxRowCount?: number;
}

interface TableListingOut {
	readonly target: string;
	readonly tables: readonly TableEntry[];
	readonly truncated: boolean;
}

const TABLE_ENTRY_SCHEMA = {
	type: 'object',
	properties: {
		name:           { type: 'string' },
		schema:         { type: 'string' },
		kind:           { type: 'string', enum: ['table', 'view', 'unknown'] },
		approxRowCount: { type: 'number' },
	},
	required: ['name', 'kind'],
	additionalProperties: false,
} as const;

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<ListTablesInput, TableListingOut> = {
	id: 'data.source.rdbms.list-tables',
	name: 'RDBMS: list tables',
	description:
		'Enumerate base tables + views on an RDBMS connection. System schemas are excluded automatically. ' +
		'Optional `schema` filter narrows to one schema / owner; default limit 500, capped at 5000.',
	family: 'source-introspection',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			schema:       { type: 'string' },
			limit:        { type: 'integer', minimum: 1, maximum: 5000 },
		},
		required: ['connectionId'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:    { type: 'string' },
			tables:    { type: 'array', items: TABLE_ENTRY_SCHEMA },
			truncated: { type: 'boolean' },
		},
		required: ['target', 'tables', 'truncated'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_list_tables'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_list_tables'], reason: 'sole tool that enumerates RDBMS tables' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<TableListingOut>> {
		// Substrate: cache hit short-circuits the tool call.
		const cached = readCachedListing(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.tables.length > 0 ? 'high' : 'medium',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const toolInput: Record<string, unknown> = { connectionId: input.connectionId };
		if (input.schema !== undefined) toolInput['schema'] = input.schema;
		if (input.limit  !== undefined) toolInput['limit']  = input.limit;
		const tool = await deps.runTool({ id: callId, name: 'db_sql_list_tables', input: toolInput });
		if (tool.isError) {
			return { value: { target: '', tables: [], truncated: false }, confidence: 'low', notes: [`db_sql_list_tables error: ${tool.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isTableListing(tool.data)) {
			return { value: { target: '', tables: [], truncated: false }, confidence: 'low', notes: ['db_sql_list_tables returned a result without the expected structured data shape'], toolCalls: [] };
		}
		const value: TableListingOut = tool.data;
		pinListing(input, value, deps);
		return {
			value,
			confidence: value.tables.length > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

function isTableListing(v: unknown): v is TableListingOut {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& Array.isArray(o['tables'])
		&& typeof o['truncated'] === 'boolean';
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// Table / view enumeration changes only on DDL; 7d TTL mirrors the
// other RDBMS introspection skills.

const OWNER_ID: OwnerId = 'skill:data.source.rdbms.list-tables';
const NAMESPACE = 'table-listings';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: ListTablesInput): string {
	return `${input.connectionId}::${input.schema ?? ''}::${input.limit ?? ''}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-listing',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as ListTablesInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'TableListingOut',
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

function readCachedListing(input: ListTablesInput, deps: SkillDeps): TableListingOut | undefined {
	const slot = deps.context?.slots.get('cached-listing');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<TableListingOut>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinListing(input: ListTablesInput, value: TableListingOut, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_list_tables' },
		payload: value,
		claims:  [`list-tables:${cacheKey(input)}`],
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

export function registerDataSourceRdbmsListTablesSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
