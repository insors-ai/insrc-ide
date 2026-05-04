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
import type { Skill, SkillResult, SkillToolResult } from '../types.js';

const SAMPLE_DEFAULT     = 50;
const MIN_SAMPLE         = 10;
const DEFAULT_GAP_RATIO  = 2;       // delta > k × median = "gap"
const REGULARITY_BAND    = 0.5;     // deltas within ±50% of median count as regular
const TOP_K_GAPS         = 10;

interface TimeseriesGapAnalysisInput {
	readonly connectionId: string;
	readonly target: string;
	readonly timestampColumn: string;
	readonly sampleSize?: number;
	readonly gapRatio?: number;       // delta > gapRatio × median = gap; default 2
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
		},
		required: ['target', 'timestampColumn', 'sampleSize', 'count', 'medianSpacingMs',
		           'cadenceHumanReadable', 'regularityScore', 'gapCount', 'topGaps',
		           'verdict', 'interpretation'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_aggregate', 'db_sql_sample'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate', 'db_sql_sample'],
			reason: 'aggregate gives count for context; sample gives the timestamps',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<TimeseriesGapAnalysisOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampSample(input.sampleSize);
		const gapRatio   = input.gapRatio !== undefined && Number.isFinite(input.gapRatio) && input.gapRatio >= 1.5
			? input.gapRatio : DEFAULT_GAP_RATIO;

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

		return {
			value: {
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
			},
			confidence: 'high',
			toolCalls: [],
		};
	},
};

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

export function registerDataTimeseriesGapAnalysisRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
