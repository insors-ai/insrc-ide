/**
 * data.drift.distribution.file -- Phase 5f.1 (file-side variant).
 *
 * Default `mode: 'sample'`. Opt-in `mode: 'full-table'` (Track-C
 * swap) routes through `db_file_aggregate` for exact-on-population
 * JS divergence. Mirrors the .rdbms variant's algorithm; the only
 * difference is the tool surface and the `path` (vs `target`) field
 * naming on the aggregate tool (tool-surface inconsistency tracked
 * in plan "Open cleanup work" §1).
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
	type DriftDistributionOutput,
	type DriftSource,
	type DriftWhereClauseIn,
	DRIFT_OUTPUT_SCHEMA,
	DRIFT_WHERE_SCHEMA,
	buildBucketEdges,
	buildDrift,
	buildDriftFromBucketCounts,
	clampDriftBins,
	clampDriftSample,
	collectToolErrors,
	driftBoundsAggregationsFor,
	driftBucketAggregationsFor,
	emptyDrift,
	extractNumbers,
	isAggregateResult,
	isSampleLike,
	parseDriftBounds,
	parseDriftBucketCounts,
} from './data.drift.distribution.algo.js';

interface DriftDistributionFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly windowAWhere: readonly DriftWhereClauseIn[];
	readonly windowBWhere: readonly DriftWhereClauseIn[];
	readonly target?: string;
	readonly sampleSize?: number;
	readonly bins?: number;
	readonly mode?: DriftSource;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<DriftDistributionFileInput, DriftDistributionOutput> = {
	id: 'data.drift.distribution.file',
	name: 'Drift: distribution divergence (file)',
	description:
		'Jensen-Shannon divergence between two windows of a numeric column on a file connection. Same shape ' +
		'as the RDBMS variant; caller supplies two WhereClause[] filters. Default `mode: sample` pulls a ' +
		'50-row sample per window. Opt-in `mode: full-table` issues 4 server-side aggregate calls via ' +
		'`db_file_aggregate` (DuckDB) for exact JS over the entire population.',
	family: 'drift',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId:  { type: 'string' },
			column:        { type: 'string' },
			windowAWhere:  DRIFT_WHERE_SCHEMA,
			windowBWhere:  DRIFT_WHERE_SCHEMA,
			target:        { type: 'string', description: 'Optional. xlsx: sheet name.' },
			sampleSize:    { type: 'integer', minimum: 1, maximum: 50 },
			bins:          { type: 'integer', minimum: 4, maximum: 50, description: 'Histogram bin count; default 10.' },
			mode: {
				type: 'string',
				enum: ['sample', 'full-table'],
				description: 'Default sample. full-table issues server-side bounds + bucket count_where aggregates.',
			},
		},
		required: ['connectionId', 'column', 'windowAWhere', 'windowBWhere'],
		additionalProperties: false,
	},
	outputs: DRIFT_OUTPUT_SCHEMA,
	toolDeps: ['db_file_sample', 'db_file_aggregate'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_file_sample', 'db_file_aggregate'],
			reason: 'sample mode: db_file_sample. full-table mode: db_file_aggregate (bounds + bucket count_where).',
		},
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<DriftDistributionOutput>> {
		const cached = readCachedDriftDistribution(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: 'high',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const binCount = clampDriftBins(input.bins);
		const col = input.column;
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		if (input.mode === 'full-table') {
			return runFullTableFile(input, deps, callBase, binCount, sheet);
		}

		// sample mode (default)
		const sampleSize = clampDriftSample(input.sampleSize);
		const buildSampleInput = (where: readonly DriftWhereClauseIn[]): Record<string, unknown> => {
			const base: Record<string, unknown> = { connectionId: input.connectionId, limit: sampleSize, where };
			if (sheet !== undefined) base['target'] = sheet;
			return base;
		};

		const [aTool, bTool] = await Promise.all([
			deps.runTool({ id: `${callBase}-a`, name: 'db_file_sample', input: buildSampleInput(input.windowAWhere) }),
			deps.runTool({ id: `${callBase}-b`, name: 'db_file_sample', input: buildSampleInput(input.windowBWhere) }),
		]);

		const errors = collectToolErrors([['db_file_sample (A)', aTool], ['db_file_sample (B)', bTool]]);
		if (errors.length > 0) {
			return { value: emptyDrift(input.target ?? '', col, binCount), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isSampleLike(aTool.data) || !isSampleLike(bTool.data)) {
			return {
				value: emptyDrift(input.target ?? '', col, binCount),
				confidence: 'low',
				notes: ['drift-distribution: one or both sample tool results were missing structured data'],
				toolCalls: [],
			};
		}

		const aValues = extractNumbers(aTool.data, col);
		const bValues = extractNumbers(bTool.data, col);
		const built = buildDrift(aTool.data.target, col, aValues, bValues, binCount);
		if (built.degradedConfidence !== null) {
			return { value: built.output, confidence: built.degradedConfidence, notes: [...built.notes], toolCalls: [] };
		}
		pinDriftDistribution(input, built.output, deps);
		return { value: built.output, confidence: 'high', toolCalls: [] };
	},
};

async function runFullTableFile(
	input: DriftDistributionFileInput,
	deps: SkillDeps,
	callBase: string,
	binCount: number,
	sheet: string | undefined,
): Promise<SkillResult<DriftDistributionOutput>> {
	const col = input.column;

	const buildAggInput = (
		aggregations: ReturnType<typeof driftBoundsAggregationsFor> | ReturnType<typeof driftBucketAggregationsFor>,
		where: readonly DriftWhereClauseIn[],
	): Record<string, unknown> => {
		const base: Record<string, unknown> = {
			connectionId: input.connectionId,
			aggregations,
			where,
		};
		// `db_file_aggregate` uses `path` for the xlsx sheet selector
		// (not `target`). Tool-surface inconsistency tracked in plan §1.
		if (sheet !== undefined) base['path'] = sheet;
		return base;
	};

	// Phase 1: parallel bounds queries.
	const boundsAggs = driftBoundsAggregationsFor(col);
	const [aBounds, bBounds] = await Promise.all([
		deps.runTool({ id: `${callBase}-bounds-a`, name: 'db_file_aggregate', input: buildAggInput(boundsAggs, input.windowAWhere) }),
		deps.runTool({ id: `${callBase}-bounds-b`, name: 'db_file_aggregate', input: buildAggInput(boundsAggs, input.windowBWhere) }),
	]);

	const boundsErrors = collectToolErrors([
		['db_file_aggregate (bounds A)', aBounds],
		['db_file_aggregate (bounds B)', bBounds],
	]);
	if (boundsErrors.length > 0) {
		return {
			value: emptyDrift(input.target ?? '', col, binCount, 'full-table'),
			confidence: 'low',
			notes: boundsErrors,
			toolCalls: [],
		};
	}
	if (!isAggregateResult(aBounds.data) || !isAggregateResult(bBounds.data)) {
		return {
			value: emptyDrift(input.target ?? '', col, binCount, 'full-table'),
			confidence: 'low',
			notes: ['drift-distribution: bounds tool result missing structured data'],
			toolCalls: [],
		};
	}

	const a = parseDriftBounds(aBounds.data.values, col);
	const b = parseDriftBounds(bBounds.data.values, col);
	const aStats = { sampleSize: a.count ?? 0, min: a.min, max: a.max, mean: null };
	const bStats = { sampleSize: b.count ?? 0, min: b.min, max: b.max, mean: null };

	if ((a.count ?? 0) === 0 || (b.count ?? 0) === 0
		|| a.min === null || a.max === null
		|| b.min === null || b.max === null) {
		return {
			value: { ...emptyDrift(input.target ?? '', col, binCount, 'full-table'), windowA: aStats, windowB: bStats },
			confidence: 'medium',
			notes: ['drift-distribution: at least one window has no rows -- cannot compute drift'],
			toolCalls: [],
		};
	}
	const sharedLo = Math.min(a.min, b.min);
	const sharedHi = Math.max(a.max, b.max);
	if (sharedHi <= sharedLo) {
		const built = buildDriftFromBucketCounts(
			aBounds.data.target, col, aStats, bStats, sharedLo, sharedHi, [], [], binCount,
		);
		return { value: built.output, confidence: built.degradedConfidence ?? 'medium', notes: [...built.notes], toolCalls: [] };
	}

	const edges = buildBucketEdges(sharedLo, sharedHi, binCount);
	const bucketAggs = driftBucketAggregationsFor(col, edges);
	const [aBuckets, bBuckets] = await Promise.all([
		deps.runTool({ id: `${callBase}-buckets-a`, name: 'db_file_aggregate', input: buildAggInput(bucketAggs, input.windowAWhere) }),
		deps.runTool({ id: `${callBase}-buckets-b`, name: 'db_file_aggregate', input: buildAggInput(bucketAggs, input.windowBWhere) }),
	]);

	const bucketErrors = collectToolErrors([
		['db_file_aggregate (buckets A)', aBuckets],
		['db_file_aggregate (buckets B)', bBuckets],
	]);
	if (bucketErrors.length > 0) {
		return {
			value: { ...emptyDrift(input.target ?? '', col, binCount, 'full-table'), windowA: aStats, windowB: bStats, sharedRange: { lower: sharedLo, upper: sharedHi } },
			confidence: 'low',
			notes: bucketErrors,
			toolCalls: [],
		};
	}
	if (!isAggregateResult(aBuckets.data) || !isAggregateResult(bBuckets.data)) {
		return {
			value: { ...emptyDrift(input.target ?? '', col, binCount, 'full-table'), windowA: aStats, windowB: bStats, sharedRange: { lower: sharedLo, upper: sharedHi } },
			confidence: 'low',
			notes: ['drift-distribution: bucket tool result missing structured data'],
			toolCalls: [],
		};
	}

	const aCounts = parseDriftBucketCounts(aBuckets.data.values, col, binCount);
	const bCounts = parseDriftBucketCounts(bBuckets.data.values, col, binCount);
	const built = buildDriftFromBucketCounts(
		aBuckets.data.target, col, aStats, bStats, sharedLo, sharedHi, aCounts, bCounts, binCount,
	);
	if (built.degradedConfidence !== null) {
		return { value: built.output, confidence: built.degradedConfidence, notes: [...built.notes], toolCalls: [] };
	}
	pinDriftDistribution(input, built.output, deps);
	return { value: built.output, confidence: 'high', toolCalls: [] };
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:data.drift.distribution.file';
const NAMESPACE = 'drift-distribution-reports';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: DriftDistributionFileInput): string {
	const ss = input.sampleSize ?? '';
	const b = input.bins ?? '';
	const m = input.mode ?? 'sample';
	const tgt = input.target ?? '';
	return `${input.connectionId}::${tgt}::${input.column}::${m}::${ss}::${b}::${JSON.stringify(input.windowAWhere)}::${JSON.stringify(input.windowBWhere)}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-drift-distribution',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as DriftDistributionFileInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'DriftDistributionOutput',
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

function readCachedDriftDistribution(input: DriftDistributionFileInput, deps: SkillDeps): DriftDistributionOutput | undefined {
	const slot = deps.context?.slots.get('cached-drift-distribution');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<DriftDistributionOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinDriftDistribution(input: DriftDistributionFileInput, value: DriftDistributionOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_file_aggregate' },
		payload: value,
		claims:  [`drift-distribution:${cacheKey(input)}`],
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

export function registerDataDriftDistributionFileSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
