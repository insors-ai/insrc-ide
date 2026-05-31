/**
 * data.distribution.modes.rdbms -- Phase 5b.7 of
 * plans/analyzers/data-analyzer-skills.md.
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
	type ModesOutput,
	MODES_OUTPUT_SCHEMA,
	buildModes,
	buildModesFromHistogram,
	clampModesBins,
	clampModesProminence,
	clampModesSample,
	emptyModes,
	modesAggregationsFor,
} from './data.distribution.modes.algo.js';
import {
	collectToolErrors,
	isAggregateResult,
	isSampleResult,
} from './data.distribution.outliers-iqr.algo.js';

interface ModesInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly sampleSize?: number;
	readonly bins?: number;
	readonly minProminence?: number;
	readonly mode?: 'sample' | 'full-table';
}

interface HistogramToolResultRaw {
	readonly target: string;
	readonly column: string;
	readonly mode: string;
	readonly bounds: { lower: number | null; upper: number | null };
	readonly buckets: readonly { lower: number; upper: number; count: number }[];
	readonly nonNullCount: number;
	readonly nullCount: number;
}

function isHistogramToolResult(v: unknown): v is HistogramToolResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['column'] === 'string'
		&& Array.isArray(o['buckets']);
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<ModesInput, ModesOutput> = {
	id: 'data.distribution.modes.rdbms',
	name: 'Distribution: modes (RDBMS)',
	description: 'Sample-based multimodal detection on a numeric column. Histogram + smoothing + peak detection. Default 10 bins, prominence 0.5.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId:  { type: 'string' },
			target:        { type: 'string' },
			column:        { type: 'string' },
			sampleSize:    { type: 'integer', minimum: 1, maximum: 50 },
			bins:          { type: 'integer', minimum: 4, maximum: 50 },
			minProminence: { type: 'number', minimum: 0.1, maximum: 1 },
			mode:          { type: 'string', enum: ['sample', 'full-table'], description: 'Default sample. full-table delegates to db_sql_histogram for precise bin counts.' },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: MODES_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_aggregate', 'db_sql_sample', 'db_sql_histogram'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_aggregate', 'db_sql_sample', 'db_sql_histogram'], reason: 'sample mode: aggregate + sample. full-table mode: db_sql_histogram' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<ModesOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampModesSample(input.sampleSize);
		const binCount = clampModesBins(input.bins);
		const minProminence = clampModesProminence(input.minProminence);
		const normalized: ModesInput = { ...input, sampleSize, bins: binCount, minProminence };

		// Substrate: cache hit short-circuits the tool calls.
		const cached = readCachedDistribution(normalized, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.modality === 'inconclusive' ? 'medium' : 'high',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		if (input.mode === 'full-table') {
			const [histTool, aggTool] = await Promise.all([
				deps.runTool({
					id: `${callBase}-hist`,
					name: 'db_sql_histogram',
					input: {
						connectionId: input.connectionId,
						target: input.target,
						column: input.column,
						buckets: binCount,
						mode: 'equal-width',
					},
				}),
				deps.runTool({
					id: `${callBase}-agg`,
					name: 'db_sql_aggregate',
					input: {
						connectionId: input.connectionId,
						target: input.target,
						aggregations: [{ column: input.column, function: 'avg' }],
					},
				}),
			]);
			if (histTool.isError) {
				return { value: emptyModes(input.target, input.column), confidence: 'low', notes: [`db_sql_histogram error: ${histTool.content.slice(0, 200)}`], toolCalls: [] };
			}
			if (!isHistogramToolResult(histTool.data)) {
				return { value: emptyModes(input.target, input.column), confidence: 'low', notes: ['db_sql_histogram returned a result without the expected structured data shape'], toolCalls: [] };
			}
			const mean = isAggregateResult(aggTool.data)
				? (aggTool.data.values[`${input.column}__avg`] ?? null)
				: null;
			const meanNum = typeof mean === 'number' ? mean
				: typeof mean === 'string' ? Number(mean)
				: null;
			const out = buildModesFromHistogram(
				histTool.data.target,
				input.column,
				histTool.data.buckets,
				histTool.data.nonNullCount,
				meanNum !== null && Number.isFinite(meanNum) ? meanNum : null,
				minProminence,
			);
			const confidence = out.modality === 'inconclusive' ? 'medium' : 'high';
			if (confidence === 'high') {
				pinDistribution(normalized, out, deps);
			}
			return {
				value: out,
				confidence,
				toolCalls: [],
			};
		}

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({
				id: `${callBase}-agg`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: modesAggregationsFor(input.column),
				},
			}),
			deps.runTool({
				id: `${callBase}-sample`,
				name: 'db_sql_sample',
				input: { connectionId: input.connectionId, target: input.target, limit: sampleSize },
			}),
		]);

		const errors = collectToolErrors([['db_sql_aggregate', aggTool], ['db_sql_sample', sampleTool]]);
		if (errors.length > 0) {
			return { value: emptyModes(input.target, input.column), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isSampleResult(sampleTool.data)) {
			return {
				value: emptyModes(input.target, input.column),
				confidence: 'low',
				notes: ['modes: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const out = buildModes(
			aggTool.data.target,
			input.column,
			binCount,
			minProminence,
			aggTool.data.values,
			{ columns: sampleTool.data.columns, rows: sampleTool.data.rows },
		);
		const confidence = out.modality === 'inconclusive' ? 'medium' : 'high';
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

const OWNER_ID: OwnerId = 'skill:data.distribution.modes.rdbms';
const NAMESPACE = 'modes-distributions';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: ModesInput): string {
	return `${input.connectionId}::${input.target}::${input.column}::${input.sampleSize ?? ''}::${input.bins ?? ''}::${input.minProminence ?? ''}::${input.mode ?? ''}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-distribution',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as ModesInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'ModesOutput',
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

function readCachedDistribution(input: ModesInput, deps: SkillDeps): ModesOutput | undefined {
	const slot = deps.context?.slots.get('cached-distribution');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<ModesOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinDistribution(input: ModesInput, value: ModesOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_aggregate' },
		payload: value,
		claims:  [`modes:${cacheKey(input)}`],
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

export function registerDataDistributionModesRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
