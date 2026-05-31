/**
 * data.timeseries.seasonality.rdbms -- Phase 5g.2 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic timeseries skill: detects periodic / seasonal structure in a
 * (timestamp, value) sample by looking for peaks in the autocorrelation
 * function of the detrended series. Pure JS, ~80 lines of math, no
 * new tooling required (reuses `db_sql_aggregate` + `db_sql_sample`).
 *
 * The autocorrelation at lag k measures how much value(t) co-varies
 * with value(t+k) — a sharp peak at lag k means the series repeats
 * itself every k sample-positions. The skill reports the strongest
 * such peak and translates it to time-units via the median spacing
 * between consecutive sorted timestamps.
 *
 * We detrend before computing autocorrelation: a strong linear
 * trend would otherwise dominate the autocorrelation at every lag
 * and mask any underlying periodicity. OLS slope/intercept come
 * from the same sample and are subtracted off in one pass — no
 * dependency on `data.timeseries.trend.rdbms` (avoids sub-skill
 * coupling for what's <10 extra lines).
 *
 * Verdict ladder:
 *   seasonal          best |r| >= 0.5 AND > significance threshold
 *   weakly-seasonal   best |r| >= 0.3 AND > significance threshold
 *   aperiodic         no peak clears the threshold
 *   inconclusive      n < 20 OR detrended series is constant
 *
 * Significance threshold for white-noise autocorrelation is
 * 1.96 / sqrt(n) (the 95% Bartlett band). At n=50 that's ~0.28;
 * peaks below this are likely sampling noise on an aperiodic series.
 *
 * Pairs with `data.timeseries.trend.rdbms` (5g.1) for the full
 * temporal-analysis story: trend = monotonic slope, seasonality =
 * periodic structure. A series can have either, both, or neither.
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

const SAMPLE_DEFAULT  = 50;
const MIN_SAMPLE      = 20;
const SEASONAL_R      = 0.5;
const WEAK_R          = 0.3;
const TOP_K_REPORTED  = 5;

interface TimeseriesSeasonalityInput {
	readonly connectionId: string;
	readonly target: string;
	readonly timestampColumn: string;
	readonly valueColumn: string;
	readonly sampleSize?: number;
}

type Verdict = 'seasonal' | 'weakly-seasonal' | 'aperiodic' | 'inconclusive';

interface AutocorrPoint {
	readonly lag: number;             // sample positions, 1..n/2
	readonly r: number;               // autocorrelation at that lag, -1..1
	readonly approxSpanMs: number;    // lag * median-spacing
}

interface TimeseriesSeasonalityOutput {
	readonly target: string;
	readonly timestampColumn: string;
	readonly valueColumn: string;
	readonly sampleSize: number;
	readonly count: number | null;             // full-table non-null count (server)
	readonly medianSpacingMs: number | null;   // median delta between consecutive timestamps
	readonly significanceThreshold: number | null;
	readonly topPeaks: readonly AutocorrPoint[];
	readonly bestPeriodLag: number | null;
	readonly bestPeriodSpanMs: number | null;
	readonly bestPeriodHumanReadable: string | null;
	readonly bestAutocorrelation: number | null;
	readonly verdict: Verdict;
	readonly interpretation: string;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<TimeseriesSeasonalityInput, TimeseriesSeasonalityOutput> = {
	id: 'data.timeseries.seasonality.rdbms',
	name: 'Timeseries: seasonality (RDBMS)',
	description:
		'Detect periodic structure in a (timestamp, value) series via autocorrelation peaks of the ' +
		'detrended sample. Returns the strongest peak (lag + estimated time-span) and a verdict ' +
		'(seasonal / weakly-seasonal / aperiodic / inconclusive). Sample-based at n=50 (min n=20 ' +
		'for a stable verdict). Significance threshold is 1.96/sqrt(n) (95% Bartlett band).',
	family: 'timeseries',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId:    { type: 'string' },
			target:          { type: 'string' },
			timestampColumn: { type: 'string' },
			valueColumn:     { type: 'string' },
			sampleSize:      { type: 'integer', minimum: MIN_SAMPLE, maximum: 50, description: 'Min 20 (autocorrelation noisy below); default 50.' },
		},
		required: ['connectionId', 'target', 'timestampColumn', 'valueColumn'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:                   { type: 'string' },
			timestampColumn:          { type: 'string' },
			valueColumn:              { type: 'string' },
			sampleSize:               { type: 'number' },
			count:                    { type: ['number', 'null'] },
			medianSpacingMs:          { type: ['number', 'null'] },
			significanceThreshold:    { type: ['number', 'null'] },
			topPeaks: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						lag:          { type: 'number' },
						r:            { type: 'number' },
						approxSpanMs: { type: 'number' },
					},
					required: ['lag', 'r', 'approxSpanMs'],
					additionalProperties: false,
				},
			},
			bestPeriodLag:            { type: ['number', 'null'] },
			bestPeriodSpanMs:         { type: ['number', 'null'] },
			bestPeriodHumanReadable:  { type: ['string', 'null'] },
			bestAutocorrelation:      { type: ['number', 'null'] },
			verdict:                  { type: 'string', enum: ['seasonal', 'weakly-seasonal', 'aperiodic', 'inconclusive'] },
			interpretation:           { type: 'string' },
		},
		required: ['target', 'timestampColumn', 'valueColumn', 'sampleSize',
		           'count', 'medianSpacingMs', 'significanceThreshold', 'topPeaks',
		           'bestPeriodLag', 'bestPeriodSpanMs', 'bestPeriodHumanReadable',
		           'bestAutocorrelation', 'verdict', 'interpretation'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_aggregate', 'db_sql_sample'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate', 'db_sql_sample'],
			reason: 'aggregate gives count for context; sample gives the (timestamp, value) pairs',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<TimeseriesSeasonalityOutput>> {
		const cached = readCachedSeasonality(input, deps);
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

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({
				id: `${callBase}-agg`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: [{ column: input.valueColumn, function: 'count_non_null' }],
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
				notes: ['timeseries.seasonality: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const count = aggData.values[`${input.valueColumn}__count_non_null`] ?? null;

		// Extract + sort (timestamp, value) pairs.
		const pairs: { t: number; y: number }[] = [];
		const haveCols = sampleData.columns.includes(input.timestampColumn)
			&& sampleData.columns.includes(input.valueColumn);
		if (haveCols) {
			for (const row of sampleData.rows) {
				const tRaw = row[input.timestampColumn];
				const yRaw = row[input.valueColumn];
				if (tRaw === null || tRaw === undefined || yRaw === null || yRaw === undefined) continue;
				const t = parseTimestamp(tRaw);
				const y = typeof yRaw === 'number' ? yRaw : Number(yRaw);
				if (t === null || !Number.isFinite(y)) continue;
				pairs.push({ t, y });
			}
		}
		pairs.sort((a, b) => a.t - b.t);
		const n = pairs.length;

		if (n < MIN_SAMPLE) {
			return {
				value: {
					...empty(input),
					sampleSize: n, count,
					interpretation: `sample too small (n=${n}); need at least ${MIN_SAMPLE} (timestamp, value) pairs to estimate autocorrelation reliably`,
				},
				confidence: 'medium',
				toolCalls: [],
			};
		}

		// Median spacing between consecutive sorted timestamps. Used
		// to translate lag (in sample positions) -> approximate time
		// span. If spacing is highly irregular this estimate is rough.
		const deltas: number[] = [];
		for (let i = 1; i < n; i++) deltas.push(pairs[i]!.t - pairs[i - 1]!.t);
		const medianSpacingMs = median(deltas);

		// Detrend: OLS slope + intercept, subtract the linear fit so
		// the autocorrelation isn't dominated by trend.
		const tMean = pairs.reduce((s, p) => s + p.t, 0) / n;
		const yMean = pairs.reduce((s, p) => s + p.y, 0) / n;
		let ssXY = 0, ssXX = 0;
		for (const { t, y } of pairs) {
			const dt = t - tMean;
			const dy = y - yMean;
			ssXY += dt * dy;
			ssXX += dt * dt;
		}
		const slope     = ssXX === 0 ? 0 : ssXY / ssXX;
		const intercept = yMean - slope * tMean;
		const residuals = pairs.map(p => p.y - (intercept + slope * p.t));

		const rMean = residuals.reduce((s, r) => s + r, 0) / n;
		const centred = residuals.map(r => r - rMean);
		const denom = centred.reduce((s, r) => s + r * r, 0);
		if (denom === 0) {
			return {
				value: {
					...empty(input),
					sampleSize: n, count, medianSpacingMs,
					interpretation: 'detrended series is constant; no periodic structure to detect',
				},
				confidence: 'medium',
				toolCalls: [],
			};
		}

		// Autocorrelation r(k) for k = 1 .. floor(n/2).
		const maxLag = Math.floor(n / 2);
		const autocorr: AutocorrPoint[] = [];
		for (let k = 1; k <= maxLag; k++) {
			let num = 0;
			for (let t = 0; t < n - k; t++) num += centred[t]! * centred[t + k]!;
			autocorr.push({ lag: k, r: num / denom, approxSpanMs: k * medianSpacingMs });
		}

		const significanceThreshold = 1.96 / Math.sqrt(n);

		// Local-maxima peak detection: r(k) is a peak iff r(k) > r(k-1)
		// and r(k) > r(k+1), with magnitude > threshold. Lag 1's
		// implicit left neighbor is r(0)=1 (autocorrelation with self),
		// so lag 1 can NEVER be a true local maximum vs lag 0; we
		// exclude it explicitly. Without this, smooth signals (where
		// consecutive samples are similar by continuity, not by
		// periodicity) get lag 1 reported as the "period" -- which is
		// noise, not seasonality.
		const peaks: AutocorrPoint[] = [];
		for (let i = 1; i < autocorr.length; i++) {  // start at i=1 (lag 2)
			const here = autocorr[i]!;
			if (Math.abs(here.r) <= significanceThreshold) continue;
			const left  = autocorr[i - 1]!.r;
			const right = i < autocorr.length - 1 ? autocorr[i + 1]!.r : -Infinity;
			if (here.r > left && here.r > right) peaks.push(here);
		}
		peaks.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
		const topPeaks = peaks.slice(0, TOP_K_REPORTED);

		const best = topPeaks[0];
		let verdict: Verdict;
		if (best === undefined) {
			verdict = 'aperiodic';
		} else if (Math.abs(best.r) >= SEASONAL_R) {
			verdict = 'seasonal';
		} else if (Math.abs(best.r) >= WEAK_R) {
			verdict = 'weakly-seasonal';
		} else {
			verdict = 'aperiodic';
		}

		const bestPeriodLag = best?.lag ?? null;
		const bestPeriodSpanMs = best?.approxSpanMs ?? null;
		const bestPeriodHumanReadable = bestPeriodSpanMs === null
			? null
			: humanReadableSpan(bestPeriodSpanMs);
		const bestAutocorrelation = best?.r ?? null;

		const interpretation = describeSeasonality(
			verdict, bestPeriodLag, bestPeriodHumanReadable, bestAutocorrelation,
			significanceThreshold, n,
		);

		const value: TimeseriesSeasonalityOutput = {
			target: aggData.target,
			timestampColumn: input.timestampColumn,
			valueColumn: input.valueColumn,
			sampleSize: n,
			count,
			medianSpacingMs,
			significanceThreshold,
			topPeaks,
			bestPeriodLag,
			bestPeriodSpanMs,
			bestPeriodHumanReadable,
			bestAutocorrelation,
			verdict,
			interpretation,
		};
		pinSeasonality(input, value, deps);
		return {
			value,
			confidence: 'high',
			toolCalls: [],
		};
	},
};

function describeSeasonality(
	verdict: Verdict,
	lag: number | null,
	humanSpan: string | null,
	r: number | null,
	threshold: number,
	n: number,
): string {
	if (verdict === 'inconclusive') return '';
	if (verdict === 'aperiodic') {
		return `no autocorrelation peak clears the 95% noise floor (|r| > ${threshold.toFixed(2)}); the series shows no detectable periodic structure at the sampled granularity (n=${n})`;
	}
	const rStr = r === null ? 'n/a' : r.toFixed(3);
	const lagStr = lag === null ? '?' : lag.toString();
	const spanStr = humanSpan ?? 'unknown span';
	return `${verdict}: autocorrelation peak at lag ${lagStr} (≈ ${spanStr}), r=${rStr}; threshold=${threshold.toFixed(2)} (n=${n})`;
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

function empty(input: TimeseriesSeasonalityInput): TimeseriesSeasonalityOutput {
	return {
		target: input.target,
		timestampColumn: input.timestampColumn,
		valueColumn: input.valueColumn,
		sampleSize: 0,
		count: null,
		medianSpacingMs: null,
		significanceThreshold: null,
		topPeaks: [],
		bestPeriodLag: null,
		bestPeriodSpanMs: null,
		bestPeriodHumanReadable: null,
		bestAutocorrelation: null,
		verdict: 'inconclusive',
		interpretation: '',
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

const OWNER_ID: OwnerId = 'skill:data.timeseries.seasonality.rdbms';
const NAMESPACE = 'seasonality-reports';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: TimeseriesSeasonalityInput): string {
	const ss = input.sampleSize ?? '';
	return `${input.connectionId}::${input.target}::${input.timestampColumn}::${input.valueColumn}::${ss}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-seasonality',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as TimeseriesSeasonalityInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'TimeseriesSeasonalityOutput',
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

function readCachedSeasonality(input: TimeseriesSeasonalityInput, deps: SkillDeps): TimeseriesSeasonalityOutput | undefined {
	const slot = deps.context?.slots.get('cached-seasonality');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<TimeseriesSeasonalityOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinSeasonality(input: TimeseriesSeasonalityInput, value: TimeseriesSeasonalityOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_sample' },
		payload: value,
		claims:  [`seasonality:${cacheKey(input)}`],
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

export function registerDataTimeseriesSeasonalityRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
