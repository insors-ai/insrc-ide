/**
 * data.timeseries.gap-analysis.rdbms -- Phase 5g.4 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic timeseries skill: detects gaps in a temporal series by
 * looking at deltas between consecutive sorted timestamps. A gap is a
 * delta significantly larger than the median spacing -- evidence of
 * missing data, an outage, a process pause, or a fundamentally
 * irregular cadence.
 *
 * Pairs with the rest of the timeseries family: trend (5g.1) /
 * seasonality (5g.2) / stationarity (5g.3) all assume reasonably
 * regular sampling. This skill answers "is the cadence actually
 * regular?" and surfaces the worst gaps so the caller can decide
 * whether to fill, model around, or split the series at the gap.
 *
 * Algorithm (~50 lines, no statistics dep):
 *   1. Sort sample by timestamp; compute consecutive deltas.
 *   2. medianSpacing = median(deltas).
 *   3. A delta is a "gap" if delta > k × median (default k=2).
 *   4. regularityScore = fraction of deltas within [0.5×median,
 *      1.5×median] -- a "tight band" that lets us call the cadence
 *      regular even with small jitter.
 *   5. Return top-K gaps (sorted by ratio-to-median, K=10) plus the
 *      verdict ladder.
 *
 * Verdict ladder:
 *   regular         regularityScore >= 0.9
 *   mostly-regular  regularityScore >= 0.7
 *   has-gaps        regularityScore >= 0.5
 *   sparse          regularityScore < 0.5
 *   inconclusive    n < 10 (too few deltas) OR median delta = 0
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult, SkillToolResult } from '../types.js';
import type {
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

const SAMPLE_DEFAULT     = 50;
const MIN_SAMPLE         = 10;
const DEFAULT_GAP_RATIO  = 2;       // delta > k × median = "gap"
const REGULARITY_BAND    = 0.5;     // deltas within ±50% of median count as regular
const TOP_K_GAPS         = 10;

type GapMode = 'sample' | 'full-table';

interface TimeseriesGapAnalysisInput {
	readonly connectionId: string;
	readonly target: string;
	readonly timestampColumn: string;
	readonly sampleSize?: number;
	readonly gapRatio?: number;       // delta > gapRatio × median = gap; default 2
	readonly mode?: GapMode;
}

type Verdict = 'regular' | 'mostly-regular' | 'has-gaps' | 'sparse' | 'inconclusive';

interface GapEntry {
	readonly startTimestamp: string;   // ISO; the timestamp BEFORE the gap
	readonly endTimestamp:   string;   // ISO; the timestamp AFTER the gap
	readonly durationMs:     number;
	readonly ratioToMedian:  number;   // durationMs / medianSpacingMs
}

interface TimeseriesGapAnalysisOutput {
	readonly target: string;
	readonly timestampColumn: string;
	readonly sampleSize: number;
	readonly count: number | null;             // full-table non-null count (server)
	readonly medianSpacingMs: number | null;
	readonly cadenceHumanReadable: string | null;
	readonly regularityScore: number | null;   // 0..1
	readonly gapCount: number;                  // # deltas that crossed gapRatio threshold
	readonly topGaps: readonly GapEntry[];
	readonly verdict: Verdict;
	readonly interpretation: string;
	readonly source: GapMode;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<TimeseriesGapAnalysisInput, TimeseriesGapAnalysisOutput> = {
	id: 'data.timeseries.gap-analysis.rdbms',
	name: 'Timeseries: gap analysis (RDBMS)',
	description:
		'Detect gaps + irregular cadence in a temporal sample by comparing consecutive timestamp deltas ' +
		'against the median spacing. Returns the inferred cadence, top-K largest gaps (sorted by ratio ' +
		'to median), a regularity score (fraction of deltas within ±50% of median), and a verdict ' +
		'(regular / mostly-regular / has-gaps / sparse / inconclusive). Sample-based at n=50 (min n=10). ' +
		'Useful as a precondition for the rest of the timeseries family -- regression / autocorrelation ' +
		'/ DF tests all assume regular sampling.',
	family: 'timeseries',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId:    { type: 'string' },
			target:          { type: 'string' },
			timestampColumn: { type: 'string' },
			sampleSize:      { type: 'integer', minimum: MIN_SAMPLE, maximum: 50, description: 'Min 10; default 50.' },
			gapRatio:        { type: 'number', minimum: 1.5, description: 'A delta > gapRatio × median is flagged as a gap. Default 2.' },
			mode: {
				type: 'string',
				enum: ['sample', 'full-table'],
				description: 'Default sample. full-table delegates to db_sql_temporal_gap_stats (CTE + LAG).',
			},
		},
		required: ['connectionId', 'target', 'timestampColumn'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:                  { type: 'string' },
			timestampColumn:         { type: 'string' },
			sampleSize:              { type: 'number' },
			count:                   { type: ['number', 'null'] },
			medianSpacingMs:         { type: ['number', 'null'] },
			cadenceHumanReadable:    { type: ['string', 'null'] },
			regularityScore:         { type: ['number', 'null'] },
			gapCount:                { type: 'number' },
			topGaps: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						startTimestamp: { type: 'string' },
						endTimestamp:   { type: 'string' },
						durationMs:     { type: 'number' },
						ratioToMedian:  { type: 'number' },
					},
					required: ['startTimestamp', 'endTimestamp', 'durationMs', 'ratioToMedian'],
					additionalProperties: false,
				},
			},
			verdict:        { type: 'string', enum: ['regular', 'mostly-regular', 'has-gaps', 'sparse', 'inconclusive'] },
			interpretation: { type: 'string' },
			source:         { type: 'string', enum: ['sample', 'full-table'] },
		},
		required: ['target', 'timestampColumn', 'sampleSize', 'count', 'medianSpacingMs',
		           'cadenceHumanReadable', 'regularityScore', 'gapCount', 'topGaps',
		           'verdict', 'interpretation', 'source'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_aggregate', 'db_sql_sample', 'db_sql_temporal_gap_stats'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate', 'db_sql_sample', 'db_sql_temporal_gap_stats'],
			reason: 'sample mode: aggregate + sample. full-table mode: db_sql_temporal_gap_stats (CTE + LAG + PERCENTILE_CONT).',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<TimeseriesGapAnalysisOutput>> {
		const cached = readCachedGapAnalysis(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: 'high',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampSample(input.sampleSize);
		const gapRatio   = input.gapRatio !== undefined && Number.isFinite(input.gapRatio) && input.gapRatio >= 1.5
			? input.gapRatio : DEFAULT_GAP_RATIO;

		if (input.mode === 'full-table') {
			return runFullTable(input, deps, callBase, gapRatio);
		}

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({
				id: `${callBase}-agg`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: [{ column: input.timestampColumn, function: 'count_non_null' }],
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
			return { value: empty(input), confidence: 'low', notes: errors, toolCalls: [] };
		}

		const aggData = aggTool.data;
		const sampleData = sampleTool.data;
		if (!isAggregateResult(aggData) || !isSampleResult(sampleData)) {
			return {
				value: empty(input),
				confidence: 'low',
				notes: ['timeseries.gap-analysis: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const count = aggData.values[`${input.timestampColumn}__count_non_null`] ?? null;

		// Extract + sort timestamps. Skip null / unparseable rows.
		const timestamps: number[] = [];
		const haveCol = sampleData.columns.includes(input.timestampColumn);
		if (haveCol) {
			for (const row of sampleData.rows) {
				const tRaw = row[input.timestampColumn];
				if (tRaw === null || tRaw === undefined) continue;
				const t = parseTimestamp(tRaw);
				if (t === null) continue;
				timestamps.push(t);
			}
		}
		timestamps.sort((a, b) => a - b);
		const n = timestamps.length;

		if (n < MIN_SAMPLE) {
			return {
				value: {
					...empty(input),
					sampleSize: n, count,
					interpretation: `sample too small (n=${n}); need at least ${MIN_SAMPLE} timestamps for a stable cadence estimate`,
				},
				confidence: 'medium',
				toolCalls: [],
			};
		}

		// Consecutive deltas. n timestamps -> n-1 deltas.
		const deltas: number[] = [];
		for (let i = 1; i < n; i++) deltas.push(timestamps[i]! - timestamps[i - 1]!);
		const medianSpacingMs = median(deltas);

		if (medianSpacingMs === 0) {
			return {
				value: {
					...empty(input),
					sampleSize: n, count,
					interpretation: 'median spacing is zero (most timestamps are duplicates); cannot compute cadence or detect gaps',
				},
				confidence: 'medium',
				toolCalls: [],
			};
		}

		// Gaps + regularity. A delta is in the "regular band" if it
		// sits within ±REGULARITY_BAND × median; that's how we count
		// "regular cadence" even when there's small jitter.
		const lowBand  = medianSpacingMs * (1 - REGULARITY_BAND);
		const highBand = medianSpacingMs * (1 + REGULARITY_BAND);
		const gapThreshold = medianSpacingMs * gapRatio;

		let regularCount = 0;
		const gapsRaw: { startIdx: number; endIdx: number; delta: number }[] = [];
		for (let i = 0; i < deltas.length; i++) {
			const d = deltas[i]!;
			if (d >= lowBand && d <= highBand) regularCount++;
			if (d > gapThreshold) gapsRaw.push({ startIdx: i, endIdx: i + 1, delta: d });
		}
		const regularityScore = regularCount / deltas.length;

		gapsRaw.sort((a, b) => b.delta - a.delta);
		const topGaps: GapEntry[] = gapsRaw.slice(0, TOP_K_GAPS).map(g => ({
			startTimestamp: new Date(timestamps[g.startIdx]!).toISOString(),
			endTimestamp:   new Date(timestamps[g.endIdx]!).toISOString(),
			durationMs:     g.delta,
			ratioToMedian:  g.delta / medianSpacingMs,
		}));

		const verdict: Verdict = regularityScore >= 0.9 ? 'regular'
			: regularityScore >= 0.7 ? 'mostly-regular'
			: regularityScore >= 0.5 ? 'has-gaps'
			: 'sparse';

		const cadenceHumanReadable = humanReadableSpan(medianSpacingMs);
		const interpretation = describe(verdict, regularityScore, cadenceHumanReadable, gapsRaw.length, n);

		const value: TimeseriesGapAnalysisOutput = {
			target: aggData.target,
			timestampColumn: input.timestampColumn,
			sampleSize: n,
			count,
			medianSpacingMs,
			cadenceHumanReadable,
			regularityScore,
			gapCount: gapsRaw.length,
			topGaps,
			verdict,
			interpretation,
			source: 'sample',
		};
		pinGapAnalysis(input, value, deps);
		return {
			value,
			confidence: 'high',
			toolCalls: [],
		};
	},
};

/**
 * Phase 5g.4 Track-C full-table mode. Delegates to db_sql_temporal_gap_stats
 * (server-side LAG + PERCENTILE_CONT for the median; bucket counts for
 * regularity score; ORDER BY delta DESC + LIMIT for top-N gaps).
 */
async function runFullTable(
	input: TimeseriesGapAnalysisInput,
	deps: SkillDeps,
	callBase: string,
	gapRatio: number,
): Promise<SkillResult<TimeseriesGapAnalysisOutput>> {
	const tool = await deps.runTool({
		id: `${callBase}-gaps`,
		name: 'db_sql_temporal_gap_stats',
		input: {
			connectionId: input.connectionId,
			target: input.target,
			timestampColumn: input.timestampColumn,
			gapRatio,
			topGaps: TOP_K_GAPS,
		},
	});
	if (tool.isError) {
		return {
			value: { ...empty(input), source: 'full-table' },
			confidence: 'low',
			notes: [`db_sql_temporal_gap_stats error: ${tool.content.slice(0, 200)}`],
			toolCalls: [],
		};
	}
	if (!isGapStatsResult(tool.data)) {
		return {
			value: { ...empty(input), source: 'full-table' },
			confidence: 'low',
			notes: ['timeseries.gap-analysis (full-table): tool result missing structured data'],
			toolCalls: [],
		};
	}

	const t = tool.data;
	if (t.medianDeltaSeconds === null || t.regularityScore === null || t.n < MIN_SAMPLE) {
		return {
			value: {
				...empty(input),
				count: t.n,
				medianSpacingMs: t.medianDeltaSeconds !== null ? t.medianDeltaSeconds * 1000 : null,
				gapCount: t.gapCount,
				source: 'full-table',
				interpretation: t.n < MIN_SAMPLE
					? `population too small (n=${t.n}); need at least ${MIN_SAMPLE} timestamps`
					: 'cadence undefined: median delta is zero or negative -- duplicate / non-monotonic timestamps',
			},
			confidence: 'medium',
			toolCalls: [],
		};
	}

	const medianSpacingMs = t.medianDeltaSeconds * 1000;
	const cadenceHumanReadable = humanReadableSpan(medianSpacingMs);
	const verdict: Verdict = t.regularityScore >= 0.9 ? 'regular'
		: t.regularityScore >= 0.7 ? 'mostly-regular'
		: t.regularityScore >= 0.5 ? 'has-gaps'
		: 'sparse';
	const topGaps: GapEntry[] = t.topGaps.map(g => ({
		startTimestamp: new Date(g.fromEpoch * 1000).toISOString(),
		endTimestamp:   new Date(g.toEpoch   * 1000).toISOString(),
		durationMs:     g.deltaSeconds * 1000,
		ratioToMedian:  g.ratio,
	}));

	const interpretation = describe(verdict, t.regularityScore, cadenceHumanReadable, t.gapCount, t.n) + ' (full-table)';

	const value: TimeseriesGapAnalysisOutput = {
		target: t.target,
		timestampColumn: input.timestampColumn,
		sampleSize: 0,
		count: t.n,
		medianSpacingMs,
		cadenceHumanReadable,
		regularityScore: t.regularityScore,
		gapCount: t.gapCount,
		topGaps,
		verdict,
		interpretation,
		source: 'full-table',
	};
	pinGapAnalysis(input, value, deps);
	return {
		value,
		confidence: 'high',
		toolCalls: [],
	};
}

interface GapStatsResultRaw {
	readonly target: string;
	readonly timestampColumn: string;
	readonly n: number;
	readonly medianDeltaSeconds: number | null;
	readonly regularityScore: number | null;
	readonly gapCount: number;
	readonly topGaps: readonly { fromEpoch: number; toEpoch: number; deltaSeconds: number; ratio: number }[];
}

function isGapStatsResult(v: unknown): v is GapStatsResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['n'] === 'number'
		&& typeof o['gapCount'] === 'number'
		&& Array.isArray(o['topGaps'])
		&& (o['medianDeltaSeconds'] === null || typeof o['medianDeltaSeconds'] === 'number')
		&& (o['regularityScore']    === null || typeof o['regularityScore']    === 'number');
}

function describe(
	verdict: Verdict,
	regularity: number,
	cadence: string | null,
	gapCount: number,
	n: number,
): string {
	const r = (regularity * 100).toFixed(1);
	const cadenceStr = cadence ?? 'unknown';
	const gapsClause = gapCount === 0
		? 'no significant gaps detected'
		: `${gapCount} significant gap${gapCount === 1 ? '' : 's'} flagged`;
	switch (verdict) {
		case 'regular':
			return `regular cadence ≈ ${cadenceStr}; ${r}% of deltas within ±50% of median, ${gapsClause} (n=${n})`;
		case 'mostly-regular':
			return `mostly-regular cadence ≈ ${cadenceStr}; ${r}% of deltas in band, ${gapsClause} (n=${n})`;
		case 'has-gaps':
			return `irregular cadence with ${gapCount} significant gap${gapCount === 1 ? '' : 's'}; ${r}% of deltas in band around ≈ ${cadenceStr}. Consider gap-aware modelling (n=${n})`;
		case 'sparse':
			return `cadence is sparse / inconsistent; only ${r}% of deltas sit in a tight band around ≈ ${cadenceStr}. Series may need resampling or aggregation before timeseries analysis (n=${n})`;
		default:
			return '';
	}
}

const MS_PER_SEC  = 1_000;
const MS_PER_MIN  = 60 * MS_PER_SEC;
const MS_PER_HOUR = 60 * MS_PER_MIN;
const MS_PER_DAY  = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;

function humanReadableSpan(ms: number): string {
	if (ms >= MS_PER_WEEK) return `${(ms / MS_PER_WEEK).toFixed(1)} weeks`;
	if (ms >= MS_PER_DAY)  return `${(ms / MS_PER_DAY).toFixed(1)} days`;
	if (ms >= MS_PER_HOUR) return `${(ms / MS_PER_HOUR).toFixed(1)} hours`;
	if (ms >= MS_PER_MIN)  return `${(ms / MS_PER_MIN).toFixed(1)} minutes`;
	if (ms >= MS_PER_SEC)  return `${(ms / MS_PER_SEC).toFixed(1)} seconds`;
	return `${ms.toFixed(0)} ms`;
}

function median(xs: number[]): number {
	if (xs.length === 0) return 0;
	const sorted = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[mid - 1]! + sorted[mid]!) / 2
		: sorted[mid]!;
}

function parseTimestamp(raw: unknown): number | null {
	if (raw instanceof Date) return raw.getTime();
	if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
	if (typeof raw === 'string') {
		const ms = Date.parse(raw);
		return Number.isFinite(ms) ? ms : null;
	}
	if (typeof raw === 'bigint') return Number(raw);
	return null;
}

function clampSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return SAMPLE_DEFAULT;
	return Math.min(Math.max(MIN_SAMPLE, Math.floor(n)), 50);
}

function empty(input: TimeseriesGapAnalysisInput): TimeseriesGapAnalysisOutput {
	return {
		target: input.target,
		timestampColumn: input.timestampColumn,
		sampleSize: 0,
		count: null,
		medianSpacingMs: null,
		cadenceHumanReadable: null,
		regularityScore: null,
		gapCount: 0,
		topGaps: [],
		verdict: 'inconclusive',
		interpretation: '',
		source: 'sample',
	};
}

function collectToolErrors(
	pairs: readonly (readonly [string, SkillToolResult])[],
): string[] {
	const out: string[] = [];
	for (const [name, res] of pairs) {
		if (res.isError) out.push(`${name} error: ${res.content.slice(0, 200)}`);
	}
	return out;
}

interface AggregateResultRaw {
	readonly target: string;
	readonly values: Readonly<Record<string, number | null>>;
}

interface SampleResultRaw {
	readonly target: string;
	readonly columns: readonly string[];
	readonly rows: readonly Readonly<Record<string, unknown>>[];
}

function isAggregateResult(v: unknown): v is AggregateResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && typeof o['values'] === 'object' && o['values'] !== null;
}

function isSampleResult(v: unknown): v is SampleResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& Array.isArray(o['columns'])
		&& Array.isArray(o['rows']);
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:data.timeseries.gap-analysis.rdbms';
const NAMESPACE = 'gap-analysis-reports';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: TimeseriesGapAnalysisInput): string {
	const ss = input.sampleSize ?? '';
	const gr = input.gapRatio ?? '';
	const m = input.mode ?? 'sample';
	return `${input.connectionId}::${input.target}::${input.timestampColumn}::${m}::${ss}::${gr}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-gap-analysis',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as TimeseriesGapAnalysisInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'TimeseriesGapAnalysisOutput',
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

function readCachedGapAnalysis(input: TimeseriesGapAnalysisInput, deps: SkillDeps): TimeseriesGapAnalysisOutput | undefined {
	const slot = deps.context?.slots.get('cached-gap-analysis');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<TimeseriesGapAnalysisOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinGapAnalysis(input: TimeseriesGapAnalysisInput, value: TimeseriesGapAnalysisOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_temporal_gap_stats' },
		payload: value,
		claims:  [`gap-analysis:${cacheKey(input)}`],
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

export function registerDataTimeseriesGapAnalysisRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
