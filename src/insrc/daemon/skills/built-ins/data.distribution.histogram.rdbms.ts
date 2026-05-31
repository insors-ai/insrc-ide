/**
 * data.distribution.histogram.rdbms -- Phase 5b.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper around `db_sql_histogram`.
 * The histogram math is entirely server-side (Phase 0.2 tool); this
 * skill normalises the tool result into a typed output and stamps
 * a top-level verdict.
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

interface HistogramRdbmsInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly buckets?: number;
	readonly mode?: HistogramMode;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<HistogramRdbmsInput, HistogramOutput> = {
	id: 'data.distribution.histogram.rdbms',
	name: 'Distribution: histogram (RDBMS)',
	description:
		'Server-side histogram on a numeric RDBMS column. Equal-width uses min/max bounds + FLOOR arithmetic ' +
		'(every dialect); equal-frequency uses NTILE() OVER (ORDER BY col) (Postgres / DuckDB / SQLite>=3.25 / ' +
		'MySQL>=8 / MSSQL / Oracle). Default 20 buckets, capped at 200.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			buckets:      { type: 'integer', minimum: 2, maximum: 200 },
			mode:         { type: 'string', enum: ['equal-width', 'equal-frequency'] },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: HISTOGRAM_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_histogram'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_histogram'],
			reason: 'sole tool that computes server-side histograms on RDBMS connections',
		},
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<HistogramOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const buckets = clampBuckets(input.buckets);
		const mode = normalizeMode(input.mode);
		const normalized: HistogramRdbmsInput = { ...input, buckets, mode };

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

		const tool = await deps.runTool({
			id: callId,
			name: 'db_sql_histogram',
			input: {
				connectionId: input.connectionId,
				target:       input.target,
				column:       input.column,
				buckets,
				mode,
			},
		});

		if (tool.isError) {
			return {
				value: emptyHistogram(input.target, input.column, mode, buckets),
				confidence: 'low',
				notes: [`db_sql_histogram error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		if (!isHistogramToolResult(tool.data)) {
			return {
				value: emptyHistogram(input.target, input.column, mode, buckets),
				confidence: 'low',
				notes: ['db_sql_histogram returned a result without the expected structured data shape'],
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

const OWNER_ID: OwnerId = 'skill:data.distribution.histogram.rdbms';
const NAMESPACE = 'histogram-distributions';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: HistogramRdbmsInput): string {
	return `${input.connectionId}::${input.target}::${input.column}::${input.buckets ?? ''}::${input.mode ?? ''}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-distribution',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as HistogramRdbmsInput;
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

function readCachedDistribution(input: HistogramRdbmsInput, deps: SkillDeps): HistogramOutput | undefined {
	const slot = deps.context?.slots.get('cached-distribution');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<HistogramOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinDistribution(input: HistogramRdbmsInput, value: HistogramOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_histogram' },
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

export function registerDataDistributionHistogramRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
