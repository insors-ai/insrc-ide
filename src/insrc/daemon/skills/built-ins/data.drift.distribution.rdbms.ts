/**
 * data.drift.distribution.rdbms -- Phase 5f.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Default `mode: 'sample'` -- both windows pull a 50-row sample;
 * histograms + JS computed in JS over the samples. Opt-in
 * `mode: 'full-table'` (Track-C swap) issues four parallel server-side
 * aggregate calls -- two for per-window bounds (min/max/count_non_null),
 * then two for per-window bucket counts via count_where -- and computes
 * JS divergence on the exact bucket counts.
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

interface DriftDistributionRdbmsInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly windowAWhere: readonly DriftWhereClauseIn[];
	readonly windowBWhere: readonly DriftWhereClauseIn[];
	readonly sampleSize?: number;
	readonly bins?: number;
	readonly mode?: DriftSource;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<DriftDistributionRdbmsInput, DriftDistributionOutput> = {
	id: 'data.drift.distribution.rdbms',
	name: 'Drift: distribution divergence (RDBMS)',
	description:
		'Jensen-Shannon divergence between two windows of a numeric column. Caller supplies two ' +
		'WhereClause[] filters. Default `mode: sample` pulls a 50-row sample per window and computes JS ' +
		'in JS. Opt-in `mode: full-table` issues 4 server-side aggregate calls (per-window bounds + ' +
		'per-window bucket counts) for an exact JS over the entire population. Verdict ladder: identical ' +
		'(<0.05) / similar (<0.20) / shifted (<0.50) / divergent (>=0.50) / inconclusive.',
	family: 'drift',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId:  { type: 'string' },
			target:        { type: 'string' },
			column:        { type: 'string' },
			windowAWhere:  DRIFT_WHERE_SCHEMA,
			windowBWhere:  DRIFT_WHERE_SCHEMA,
			sampleSize:    { type: 'integer', minimum: 1, maximum: 50 },
			bins:          { type: 'integer', minimum: 4, maximum: 50, description: 'Histogram bin count; default 10.' },
			mode: {
				type: 'string',
				enum: ['sample', 'full-table'],
				description: 'Default sample. full-table issues server-side bounds + bucket count_where aggregates.',
			},
		},
		required: ['connectionId', 'target', 'column', 'windowAWhere', 'windowBWhere'],
		additionalProperties: false,
	},
	outputs: DRIFT_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_sample', 'db_sql_aggregate'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_sample', 'db_sql_aggregate'],
			reason: 'sample mode: db_sql_sample. full-table mode: db_sql_aggregate (bounds + bucket count_where).',
		},
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
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

		if (input.mode === 'full-table') {
			return runFullTable(input, deps, callBase, binCount);
		}

		// sample mode (default)
		const sampleSize = clampDriftSample(input.sampleSize);
		const [aTool, bTool] = await Promise.all([
			deps.runTool({
				id: `${callBase}-a`,
				name: 'db_sql_sample',
				input: { connectionId: input.connectionId, target: input.target, limit: sampleSize, where: input.windowAWhere },
			}),
			deps.runTool({
				id: `${callBase}-b`,
				name: 'db_sql_sample',
				input: { connectionId: input.connectionId, target: input.target, limit: sampleSize, where: input.windowBWhere },
			}),
		]);

		const errors = collectToolErrors([['db_sql_sample (A)', aTool], ['db_sql_sample (B)', bTool]]);
		if (errors.length > 0) {
			return { value: emptyDrift(input.target, col, binCount), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isSampleLike(aTool.data) || !isSampleLike(bTool.data)) {
			return {
				value: emptyDrift(input.target, col, binCount),
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

async function runFullTable(
	input: DriftDistributionRdbmsInput,
	deps: SkillDeps,
	callBase: string,
	binCount: number,
): Promise<SkillResult<DriftDistributionOutput>> {
	const col = input.column;

	// Phase 1: parallel bounds queries (one per window).
	const boundsAggs = driftBoundsAggregationsFor(col);
	const [aBounds, bBounds] = await Promise.all([
		deps.runTool({
			id: `${callBase}-bounds-a`,
			name: 'db_sql_aggregate',
			input: {
				connectionId: input.connectionId,
				target: input.target,
				aggregations: boundsAggs,
				where: input.windowAWhere,
			},
		}),
		deps.runTool({
			id: `${callBase}-bounds-b`,
			name: 'db_sql_aggregate',
			input: {
				connectionId: input.connectionId,
				target: input.target,
				aggregations: boundsAggs,
				where: input.windowBWhere,
			},
		}),
	]);

	const boundsErrors = collectToolErrors([
		['db_sql_aggregate (bounds A)', aBounds],
		['db_sql_aggregate (bounds B)', bBounds],
	]);
	if (boundsErrors.length > 0) {
		return {
			value: emptyDrift(input.target, col, binCount, 'full-table'),
			confidence: 'low',
			notes: boundsErrors,
			toolCalls: [],
		};
	}
	if (!isAggregateResult(aBounds.data) || !isAggregateResult(bBounds.data)) {
		return {
			value: emptyDrift(input.target, col, binCount, 'full-table'),
			confidence: 'low',
			notes: ['drift-distribution: bounds tool result missing structured data'],
			toolCalls: [],
		};
	}

	const a = parseDriftBounds(aBounds.data.values, col);
	const b = parseDriftBounds(bBounds.data.values, col);
	const aStats = { sampleSize: a.count ?? 0, min: a.min, max: a.max, mean: null };
	const bStats = { sampleSize: b.count ?? 0, min: b.min, max: b.max, mean: null };

	// Short-circuit: if either window has no rows, joint range is
	// undefined (or single-window). Cannot compute drift; return
	// medium with a clear note instead of issuing pointless bucket
	// queries that would fall through to a low-confidence error.
	if ((a.count ?? 0) === 0 || (b.count ?? 0) === 0
		|| a.min === null || a.max === null
		|| b.min === null || b.max === null) {
		return {
			value: { ...emptyDrift(input.target, col, binCount, 'full-table'), windowA: aStats, windowB: bStats },
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

	// Phase 2: parallel bucket queries (N count_where each, on shared edges).
	const edges = buildBucketEdges(sharedLo, sharedHi, binCount);
	const bucketAggs = driftBucketAggregationsFor(col, edges);
	const [aBuckets, bBuckets] = await Promise.all([
		deps.runTool({
			id: `${callBase}-buckets-a`,
			name: 'db_sql_aggregate',
			input: {
				connectionId: input.connectionId,
				target: input.target,
				aggregations: bucketAggs,
				where: input.windowAWhere,
			},
		}),
		deps.runTool({
			id: `${callBase}-buckets-b`,
			name: 'db_sql_aggregate',
			input: {
				connectionId: input.connectionId,
				target: input.target,
				aggregations: bucketAggs,
				where: input.windowBWhere,
			},
		}),
	]);

	const bucketErrors = collectToolErrors([
		['db_sql_aggregate (buckets A)', aBuckets],
		['db_sql_aggregate (buckets B)', bBuckets],
	]);
	if (bucketErrors.length > 0) {
		return {
			value: { ...emptyDrift(input.target, col, binCount, 'full-table'), windowA: aStats, windowB: bStats, sharedRange: { lower: sharedLo, upper: sharedHi } },
			confidence: 'low',
			notes: bucketErrors,
			toolCalls: [],
		};
	}
	if (!isAggregateResult(aBuckets.data) || !isAggregateResult(bBuckets.data)) {
		return {
			value: { ...emptyDrift(input.target, col, binCount, 'full-table'), windowA: aStats, windowB: bStats, sharedRange: { lower: sharedLo, upper: sharedHi } },
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

const OWNER_ID: OwnerId = 'skill:data.drift.distribution.rdbms';
const NAMESPACE = 'drift-distribution-reports';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: DriftDistributionRdbmsInput): string {
	const ss = input.sampleSize ?? '';
	const b = input.bins ?? '';
	const m = input.mode ?? 'sample';
	return `${input.connectionId}::${input.target}::${input.column}::${m}::${ss}::${b}::${JSON.stringify(input.windowAWhere)}::${JSON.stringify(input.windowBWhere)}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-drift-distribution',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as DriftDistributionRdbmsInput;
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

function readCachedDriftDistribution(input: DriftDistributionRdbmsInput, deps: SkillDeps): DriftDistributionOutput | undefined {
	const slot = deps.context?.slots.get('cached-drift-distribution');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<DriftDistributionOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinDriftDistribution(input: DriftDistributionRdbmsInput, value: DriftDistributionOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_aggregate' },
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

export function registerDataDriftDistributionRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
