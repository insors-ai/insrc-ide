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
import type {
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

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
		// Substrate: cache hit short-circuits the tool call.
		const cached = readCachedDescription(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.columns.length > 0 ? 'high' : 'medium',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

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

		const value: SchemaDescriptionOut = {
			target:  data.target,
			columns: data.columns,
			source:  data.source,
		};
		pinDescription(input, value, deps);
		return {
			value,
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

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// Schema introspection is stable per (connectionId, target) until the
// indexer detects a schema change. 7d TTL is generous for normal DDL
// rates; consumers can force-refresh via a reindex trigger when needed.

const OWNER_ID: OwnerId = 'skill:data.source.rdbms.describe-table';
const NAMESPACE = 'table-descriptions';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: RdbmsDescribeTableInput): string {
	return `${input.connectionId}::${input.target}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-description',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as RdbmsDescribeTableInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'SchemaDescriptionOut',
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

function readCachedDescription(input: RdbmsDescribeTableInput, deps: SkillDeps): SchemaDescriptionOut | undefined {
	const slot = deps.context?.slots.get('cached-description');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<SchemaDescriptionOut>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinDescription(input: RdbmsDescribeTableInput, value: SchemaDescriptionOut, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_describe' },
		payload: value,
		claims:  [`describe-table:${cacheKey(input)}`],
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

export function registerDataSourceRdbmsDescribeTableSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
