/**
 * data.distribution.histogram.file -- Phase 5b.1 of
 * plans/analyzers/data-analyzer-skills.md (file-side variant).
 *
 * Mirrors `data.distribution.histogram.rdbms`; same algo module.
 * Routes through `db_file_histogram` (DuckDB-backed file driver
 * supports both equal-width arithmetic and NTILE natively).
 * xlsx sheet selection via the optional `target` field.
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
import {
	type HistogramMode,
	type HistogramOutput,
	HISTOGRAM_OUTPUT_SCHEMA,
	buildHistogramOutput,
	clampBuckets,
	emptyHistogram,
	isHistogramToolResult,
	normalizeMode,
} from './data.distribution.histogram.algo.js';

interface HistogramFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly target?: string;
	readonly buckets?: number;
	readonly mode?: HistogramMode;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<HistogramFileInput, HistogramOutput> = {
	id: 'data.distribution.histogram.file',
	name: 'Distribution: histogram (file)',
	description:
		'Server-side histogram on a numeric column from a file connection. Same shape + math as the RDBMS ' +
		'variant; routes through `db_file_histogram` (DuckDB backend). Default 20 buckets, capped at 200. ' +
		'xlsx sheet selection via the optional `target` field.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			column:       { type: 'string' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			buckets:      { type: 'integer', minimum: 2, maximum: 200 },
			mode:         { type: 'string', enum: ['equal-width', 'equal-frequency'] },
		},
		required: ['connectionId', 'column'],
		additionalProperties: false,
	},
	outputs: HISTOGRAM_OUTPUT_SCHEMA,
	toolDeps: ['db_file_histogram'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_file_histogram'],
			reason: 'sole tool that computes server-side histograms on file connections',
		},
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<HistogramOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const buckets = clampBuckets(input.buckets);
		const mode = normalizeMode(input.mode);
		const normalized: HistogramFileInput = { ...input, buckets, mode };
		// Used for the empty-fallback target slot when the tool is unreachable; the
		// real target comes from the tool's response.
		const targetSlot = input.target ?? '';

		// Substrate: cache hit short-circuits the tool call.
		const cached = readCachedDistribution(normalized, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.verdict === 'has-data' ? 'high' : cached.verdict === 'empty' ? 'medium' : 'low',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const toolInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			column:       input.column,
			buckets,
			mode,
		};
		if (input.target !== undefined) toolInput['target'] = input.target;

		const tool = await deps.runTool({
			id: callId,
			name: 'db_file_histogram',
			input: toolInput,
		});

		if (tool.isError) {
			return {
				value: emptyHistogram(targetSlot, input.column, mode, buckets),
				confidence: 'low',
				notes: [`db_file_histogram error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		if (!isHistogramToolResult(tool.data)) {
			return {
				value: emptyHistogram(targetSlot, input.column, mode, buckets),
				confidence: 'low',
				notes: ['db_file_histogram returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const out = buildHistogramOutput(tool.data, buckets);
		const confidence = out.verdict === 'has-data' ? 'high' : out.verdict === 'empty' ? 'medium' : 'low';
		if (confidence === 'high') {
			pinDistribution(normalized, out, deps);
		}
		return {
			value: out,
			confidence,
			toolCalls: [],
		};
	},
};

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:data.distribution.histogram.file';
const NAMESPACE = 'histogram-distributions';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: HistogramFileInput): string {
	return `${input.connectionId}::${input.target ?? ''}::${input.column}::${input.buckets ?? ''}::${input.mode ?? ''}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-distribution',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as HistogramFileInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'HistogramOutput',
		autoDistill: 'always-on-success',
		indexing:    { kind: 'never' },
		ttl:         '24h',
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

function readCachedDistribution(input: HistogramFileInput, deps: SkillDeps): HistogramOutput | undefined {
	const slot = deps.context?.slots.get('cached-distribution');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<HistogramOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinDistribution(input: HistogramFileInput, value: HistogramOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_file_histogram' },
		payload: value,
		claims:  [`histogram:${cacheKey(input)}`],
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

export function registerDataDistributionHistogramFileSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
