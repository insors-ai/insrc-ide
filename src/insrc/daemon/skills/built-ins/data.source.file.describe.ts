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
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import type {
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

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

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// File schema is stable per (connectionId, target) until the file is
// replaced. 7d TTL matches the RDBMS describe-table TTL; consumers can
// force-refresh via a connection-add / manual trigger.

const OWNER_ID: OwnerId = 'skill:data.source.file.describe';
const NAMESPACE = 'file-descriptions';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: FileDescribeInput): string {
	return `${input.connectionId}::${input.target ?? ''}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-description',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as FileDescribeInput;
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

function readCachedDescription(input: FileDescribeInput, deps: SkillDeps): SchemaDescriptionOut | undefined {
	const slot = deps.context?.slots.get('cached-description');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<SchemaDescriptionOut>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinDescription(input: FileDescribeInput, value: SchemaDescriptionOut, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_file_describe' },
		payload: value,
		claims:  [`file-describe:${cacheKey(input)}`],
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

export function registerDataSourceFileDescribeSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
