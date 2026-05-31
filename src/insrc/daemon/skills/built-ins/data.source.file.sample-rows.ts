/**
 * data.source.file.sample-rows -- Phase 2.3 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin typed wrapper over `db_file_sample`. Returns up
 * to 50 rows from a file connection with optional structured WHERE
 * filtering. Covers all 12 file kinds via the consolidated DuckDB-
 * backed driver.
 *
 * Confidence: `high` when at least one row returned, `medium` when
 * the sample is empty (the query ran clean -- empty is information),
 * `low` when the tool errored or the structured shape was missing.
 * The registry's calibration further clamps for sub-precondition
 * sample sizes.
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

interface WhereClauseIn {
	readonly column: string;
	readonly op: '=' | '!=' | 'in' | 'is null';
	readonly value?: unknown;
}

interface FileSampleRowsInput {
	readonly connectionId: string;
	readonly target?: string;
	readonly limit?: number;
	readonly where?: readonly WhereClauseIn[];
}

interface FileSampleRowsOutput {
	readonly target: string;
	readonly columns: readonly string[];
	readonly rows: readonly Readonly<Record<string, unknown>>[];
	readonly truncated: boolean;
	readonly samplingMethod: string;
}

const WHERE_SCHEMA = {
	type: 'array',
	items: {
		type: 'object',
		properties: {
			column: { type: 'string' },
			op:     { type: 'string', enum: ['=', '!=', 'in', 'is null'] },
			value:  {},
		},
		required: ['column', 'op'],
		additionalProperties: false,
	},
} as const;

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<FileSampleRowsInput, FileSampleRowsOutput> = {
	id: 'data.source.file.sample-rows',
	name: 'File: sample rows',
	description:
		'Sample up to 50 rows from a file connection (csv / tsv / jsonl / ndjson / json / parquet / arrow / feather / ' +
		'avro / bson / fixed-width / xlsx). Optional structured WHERE; raw SQL never accepted. xlsx target selects a sheet.',
	family: 'source-sampling',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string', description: 'xlsx: sheet name. Other kinds ignore it.' },
			limit:        { type: 'integer', minimum: 1, maximum: 50 },
			where:        WHERE_SCHEMA,
		},
		required: ['connectionId'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:         { type: 'string' },
			columns:        { type: 'array', items: { type: 'string' } },
			rows:           { type: 'array' },
			truncated:      { type: 'boolean' },
			samplingMethod: { type: 'string' },
		},
		required: ['target', 'columns', 'rows', 'truncated', 'samplingMethod'],
		additionalProperties: false,
	},
	toolDeps: ['db_file_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_file_sample'],
			reason: 'sole tool implementing file row-sampling',
		},
		{
			kind: 'connection-family',
			families: FILE_FAMILY_TAGS,
			reason: 'file sampling is family-scoped',
		},
	],

	async execute(input, deps): Promise<SkillResult<FileSampleRowsOutput>> {
		// Substrate: cache hit short-circuits the tool call.
		const cached = readCachedSample(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.rows.length > 0 ? 'high' : 'medium',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const limit = clampLimit(input.limit);
		const toolInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			limit,
		};
		if (input.target !== undefined && input.target.length > 0) toolInput['target'] = input.target;
		if (input.where !== undefined && input.where.length > 0) toolInput['where'] = input.where;

		const tool = await deps.runTool({ id: callId, name: 'db_file_sample', input: toolInput });

		if (tool.isError) {
			return {
				value: emptyResult(input.target ?? input.connectionId),
				confidence: 'low',
				notes: [`db_file_sample error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}

		const data = tool.data;
		if (!isSampleResult(data)) {
			return {
				value: emptyResult(input.target ?? input.connectionId),
				confidence: 'low',
				notes: ['db_file_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const value: FileSampleRowsOutput = {
			target:         data.target,
			columns:        data.columns,
			rows:           data.rows,
			truncated:      data.truncated,
			samplingMethod: data.metadata?.samplingMethod ?? 'first',
		};
		if (data.rows.length > 0) {
			pinSample(input, value, deps);
		}
		return {
			value,
			confidence: data.rows.length > 0 ? 'high' : 'medium',
			...(data.truncated ? { truncated: true } : {}),
			toolCalls: [],
		};
	},
};

function clampLimit(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 50;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

function emptyResult(target: string): FileSampleRowsOutput {
	return { target, columns: [], rows: [], truncated: false, samplingMethod: 'first' };
}

interface SampleResultRaw {
	readonly target: string;
	readonly columns: readonly string[];
	readonly rows: readonly Readonly<Record<string, unknown>>[];
	readonly truncated: boolean;
	readonly metadata?: { readonly samplingMethod?: string };
}

function isSampleResult(v: unknown): v is SampleResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& Array.isArray(o['columns'])
		&& Array.isArray(o['rows'])
		&& typeof o['truncated'] === 'boolean';
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// Row samples reflect live data; 1h TTL keeps them fresh while still
// short-circuiting repeat lookups within a single analyzer loop.

const OWNER_ID: OwnerId = 'skill:data.source.file.sample-rows';
const NAMESPACE = 'file-samples';
const TTL_MS = 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: FileSampleRowsInput): string {
	const limit = clampLimit(input.limit);
	const where = input.where !== undefined ? JSON.stringify(input.where) : '';
	return `${input.connectionId}::${input.target ?? ''}::${limit}::${where}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-sample',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as FileSampleRowsInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'FileSampleRowsOutput',
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

function readCachedSample(input: FileSampleRowsInput, deps: SkillDeps): FileSampleRowsOutput | undefined {
	const slot = deps.context?.slots.get('cached-sample');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<FileSampleRowsOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinSample(input: FileSampleRowsInput, value: FileSampleRowsOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_file_sample' },
		payload: value,
		claims:  [`file-sample:${cacheKey(input)}`],
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

export function registerDataSourceFileSampleRowsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
