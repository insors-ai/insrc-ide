/**
 * data.timeseries.trend.rdbms -- Phase 5g.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic timeseries skill -- activates the `timeseries` family.
 * Computes the least-squares linear-regression slope of one numeric
 * column over a timestamp axis, plus R² as the fit-quality
 * indicator. Ordinary least squares closed-form math, ~30 lines of
 * pure JS over a 50-row sample.
 *
 * Slope is reported in two forms:
 *   - `slope`: raw rise-over-run in (valueUnits / millisecond)
 *   - `slopePerDay`: slope * 86_400_000 -- the human-readable form
 *     ("amount changes by X per day"). Defaults to per-day; the
 *     caller picks per-week / per-month rendering downstream.
 *
 * Direction + strength verdicts:
 *   direction = sign(slope) plus a near-zero "flat" band derived
 *               from the value range and sample noise.
 *   strength  = R² ladder: 'strong' (>= 0.7), 'moderate' (>= 0.3),
 *               'weak' (< 0.3), 'inconclusive' (n < 10 or constant
 *               column).
 *
 * Pairs with `drift.distribution.rdbms`: trend captures monotonic
 * change over time, drift captures shape change between two
 * windows. Together they answer "is this metric trending in a
 * direction AND is its distribution shape stable?".
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

const SAMPLE_DEFAULT = 50;
const MS_PER_DAY = 86_400_000;

type TrendMode = 'sample' | 'full-table';

interface TimeseriesTrendInput {
	readonly connectionId: string;
	readonly target: string;
	readonly timestampColumn: string;
	readonly valueColumn: string;
	readonly sampleSize?: number;
	readonly mode?: TrendMode;
}

type Direction = 'increasing' | 'decreasing' | 'flat';
type Strength = 'strong' | 'moderate' | 'weak' | 'inconclusive';

interface TimeseriesTrendOutput {
	readonly target: string;
	readonly timestampColumn: string;
	readonly valueColumn: string;
	readonly sampleSize: number;
	readonly count: number | null;             // full-table non-null count (server)
	readonly valueMean: number | null;          // full-table mean (server, for context)
	readonly slope: number | null;              // value units per millisecond
	readonly slopePerDay: number | null;        // value units per day (human-readable)
	readonly intercept: number | null;          // value at t=0 (epoch ms = 1970-01-01)
	readonly rSquared: number | null;           // 0..1; fraction of variance explained
	readonly direction: Direction;
	readonly strength: Strength;
	readonly interpretation: string;
	readonly source: TrendMode;                 // Phase 5g.1 Track-C: how slope was computed
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<TimeseriesTrendInput, TimeseriesTrendOutput> = {
	id: 'data.timeseries.trend.rdbms',
	name: 'Timeseries: trend slope (RDBMS)',
	description:
		'Least-squares linear-regression slope of `valueColumn` over `timestampColumn`. Returns slope ' +
		'(raw + per-day), intercept, R-squared, direction (increasing / decreasing / flat) and strength ' +
		'(strong / moderate / weak / inconclusive). Sample-based at n=50 with caller-supplied min on ' +
		'precondition. Caller is responsible for ensuring `timestampColumn` is temporal-typed (date / ' +
		'timestamp / datetime); the skill parses the value to epoch-ms and skips unparseable rows.',
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
			sampleSize:      { type: 'integer', minimum: 10, maximum: 50, description: 'Min 10 (slope/R² unstable below); default 50.' },
			mode: {
				type: 'string',
				enum: ['sample', 'full-table'],
				description: 'Default sample. full-table delegates to db_sql_temporal_trend (server-side OLS) for an exact slope/R² over the entire population.',
			},
		},
		required: ['connectionId', 'target', 'timestampColumn', 'valueColumn'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:          { type: 'string' },
			timestampColumn: { type: 'string' },
			valueColumn:     { type: 'string' },
			sampleSize:      { type: 'number' },
			count:           { type: ['number', 'null'] },
			valueMean:       { type: ['number', 'null'] },
			slope:           { type: ['number', 'null'] },
			slopePerDay:     { type: ['number', 'null'] },
			intercept:       { type: ['number', 'null'] },
			rSquared:        { type: ['number', 'null'] },
			direction:       { type: 'string', enum: ['increasing', 'decreasing', 'flat'] },
			strength:        { type: 'string', enum: ['strong', 'moderate', 'weak', 'inconclusive'] },
			interpretation:  { type: 'string' },
			source:          { type: 'string', enum: ['sample', 'full-table'] },
		},
		required: ['target', 'timestampColumn', 'valueColumn', 'sampleSize',
		           'count', 'valueMean', 'slope', 'slopePerDay', 'intercept', 'rSquared',
		           'direction', 'strength', 'interpretation', 'source'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_aggregate', 'db_sql_sample', 'db_sql_temporal_trend'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate', 'db_sql_sample', 'db_sql_temporal_trend'],
			reason: 'sample mode: aggregate + sample. full-table mode: db_sql_temporal_trend (server-side OLS).',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<TimeseriesTrendOutput>> {
		const cached = readCachedTrend(input, deps);
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

		if (input.mode === 'full-table') {
			return runFullTable(input, deps, callBase);
		}

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({
				id: `${callBase}-agg`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: [
						{ column: input.valueColumn, function: 'count_non_null' },
						{ column: input.valueColumn, function: 'avg' },
					],
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
				notes: ['timeseries.trend: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const count = aggData.values[`${input.valueColumn}__count_non_null`] ?? null;
		const valueMean = aggData.values[`${input.valueColumn}__avg`] ?? null;

		// Extract (epoch-ms, value) pairs from the sample. Skip rows
		// where either side is null or the timestamp doesn't parse.
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
		const n = pairs.length;

		if (n < 10) {
			return {
				value: {
					...empty(input),
					sampleSize: n, count, valueMean,
					interpretation: `sample too small (n=${n}); need at least 10 (timestamp, value) pairs for a stable slope estimate`,
				},
				confidence: 'medium',
				toolCalls: [],
			};
		}

		// OLS regression: slope, intercept, R^2.
		// slope = Σ((t-t̄)(y-ȳ)) / Σ((t-t̄)²)
		// intercept = ȳ - slope * t̄
		// R² = 1 - SSres / SStot
		const tMean = pairs.reduce((s, p) => s + p.t, 0) / n;
		const yMean = pairs.reduce((s, p) => s + p.y, 0) / n;
		let ssXY = 0, ssXX = 0, ssYY = 0;
		for (const { t, y } of pairs) {
			const dt = t - tMean;
			const dy = y - yMean;
			ssXY += dt * dy;
			ssXX += dt * dt;
			ssYY += dy * dy;
		}
		if (ssXX === 0 || ssYY === 0) {
			return {
				value: {
					...empty(input),
					sampleSize: n, count, valueMean,
					interpretation: ssXX === 0
						? 'all sampled timestamps are identical; cannot compute slope'
						: 'value column is constant in sample; trend is flat by definition',
				},
				confidence: 'medium',
				toolCalls: [],
			};
		}
		const slope = ssXY / ssXX;
		const intercept = yMean - slope * tMean;
		const ssRes = pairs.reduce((s, p) => {
			const fitted = intercept + slope * p.t;
			const resid = p.y - fitted;
			return s + resid * resid;
		}, 0);
		const rSquared = 1 - (ssRes / ssYY);

		// Direction band: "flat" when |slope * sampleTimeRange| is < 5% of value range.
		const tRange = pairs[pairs.length - 1]!.t - pairs[0]!.t;  // sample is unsorted; use the actual span
		const tMin = Math.min(...pairs.map(p => p.t));
		const tMax = Math.max(...pairs.map(p => p.t));
		const actualTSpan = tMax - tMin;
		const yMin = Math.min(...pairs.map(p => p.y));
		const yMax = Math.max(...pairs.map(p => p.y));
		const yRange = yMax - yMin;
		const expectedYChange = Math.abs(slope * actualTSpan);
		const flatThreshold = yRange * 0.05;
		let direction: Direction;
		if (expectedYChange < flatThreshold) direction = 'flat';
		else if (slope > 0) direction = 'increasing';
		else direction = 'decreasing';

		const strength: Strength = rSquared >= 0.7 ? 'strong'
			: rSquared >= 0.3 ? 'moderate'
			: rSquared >= 0   ? 'weak'
			: 'inconclusive';

		const slopePerDay = slope * MS_PER_DAY;
		const interpretation = describeTrend(direction, strength, slopePerDay, rSquared, n);

		void tRange;
		const value: TimeseriesTrendOutput = {
			target: aggData.target,
			timestampColumn: input.timestampColumn,
			valueColumn: input.valueColumn,
			sampleSize: n,
			count, valueMean,
			slope, slopePerDay, intercept, rSquared,
			direction, strength,
			interpretation,
			source: 'sample',
		};
		pinTrend(input, value, deps);
		return {
			value,
			confidence: 'high',
			toolCalls: [],
		};
	},
};

/**
 * Phase 5g.1 Track-C full-table mode. Delegates the regression to
 * the server-side `db_sql_temporal_trend` tool (which uses native
 * REGR_* on PG / DuckDB / Oracle and the SUM-of-moments path on
 * MySQL / SQLite / MSSQL). Pulls min/max valueColumn alongside via
 * aggregate so the direction-band heuristic stays consistent with
 * the sample path.
 */
async function runFullTable(
	input: TimeseriesTrendInput,
	deps: SkillDeps,
	callBase: string,
): Promise<SkillResult<TimeseriesTrendOutput>> {
	const [trendTool, aggTool] = await Promise.all([
		deps.runTool({
			id: `${callBase}-trend`,
			name: 'db_sql_temporal_trend',
			input: {
				connectionId: input.connectionId,
				target: input.target,
				timestampColumn: input.timestampColumn,
				valueColumn: input.valueColumn,
			},
		}),
		deps.runTool({
			id: `${callBase}-agg`,
			name: 'db_sql_aggregate',
			input: {
				connectionId: input.connectionId,
				target: input.target,
				aggregations: [
					{ column: input.valueColumn, function: 'count_non_null' },
					{ column: input.valueColumn, function: 'avg' },
					{ column: input.valueColumn, function: 'min' },
					{ column: input.valueColumn, function: 'max' },
				],
			},
		}),
	]);

	const errors = collectToolErrors([['db_sql_temporal_trend', trendTool], ['db_sql_aggregate', aggTool]]);
	if (errors.length > 0) {
		return {
			value: { ...empty(input), source: 'full-table' },
			confidence: 'low',
			notes: errors,
			toolCalls: [],
		};
	}
	if (!isTemporalTrendResult(trendTool.data) || !isAggregateResult(aggTool.data)) {
		return {
			value: { ...empty(input), source: 'full-table' },
			confidence: 'low',
			notes: ['timeseries.trend (full-table): tool result missing structured data'],
			toolCalls: [],
		};
	}

	const t = trendTool.data;
	const valueMean = numericFromAgg(aggTool.data.values[`${input.valueColumn}__avg`]);
	const valueMin  = numericFromAgg(aggTool.data.values[`${input.valueColumn}__min`]);
	const valueMax  = numericFromAgg(aggTool.data.values[`${input.valueColumn}__max`]);
	const count     = numericFromAgg(aggTool.data.values[`${input.valueColumn}__count_non_null`]);

	if (t.n < 2 || t.slope === null) {
		return {
			value: {
				...empty(input),
				count, valueMean,
				source: 'full-table',
				interpretation: t.n < 2
					? `not enough non-null (timestamp, value) pairs in the full table (n=${t.n}); need >= 2`
					: 'all timestamps are identical or the regression is undefined; cannot compute slope',
			},
			confidence: t.n < 2 ? 'medium' : 'medium',
			toolCalls: [],
		};
	}

	// db_sql_temporal_trend reports `slope` per second of epoch.
	// The skill's existing `slope` field is per millisecond, so
	// convert. `slopePerDay` is unit-invariant -- the tool already
	// computed it as `slope_sec * 86400`.
	const slope_ms = t.slope / 1000;
	const slopePerDay = t.slopePerDay;
	// Intercept stays the same: epoch-seconds=0 and epoch-ms=0 are both
	// 1970-01-01, so the y-value at x=0 is identical in either basis.
	const intercept = t.intercept;
	const rSquared  = t.r2;

	// Direction band: same heuristic as the sample path (5% of value
	// range) but using server-derived min/max + the actual time span.
	let direction: Direction;
	if (rSquared !== null && rSquared >= 0
		&& valueMin !== null && valueMax !== null
		&& t.minTimestampEpoch !== null && t.maxTimestampEpoch !== null
		&& slopePerDay !== null) {
		const yRange = valueMax - valueMin;
		const tSpanSec = t.maxTimestampEpoch - t.minTimestampEpoch;
		const expectedYChange = Math.abs(t.slope * tSpanSec);
		const flatThreshold = yRange * 0.05;
		if (expectedYChange < flatThreshold) direction = 'flat';
		else if (slopePerDay > 0)            direction = 'increasing';
		else                                  direction = 'decreasing';
	} else {
		direction = slopePerDay !== null && slopePerDay > 0 ? 'increasing'
			: slopePerDay !== null && slopePerDay < 0 ? 'decreasing'
			: 'flat';
	}

	const strength: Strength = rSquared === null ? 'inconclusive'
		: rSquared >= 0.7 ? 'strong'
		: rSquared >= 0.3 ? 'moderate'
		: rSquared >= 0   ? 'weak'
		: 'inconclusive';

	const value: TimeseriesTrendOutput = {
		target: t.target,
		timestampColumn: input.timestampColumn,
		valueColumn: input.valueColumn,
		sampleSize: 0,
		count, valueMean,
		slope: slope_ms, slopePerDay, intercept, rSquared,
		direction, strength,
		interpretation: describeTrend(direction, strength, slopePerDay ?? 0, rSquared ?? 0, t.n) + ' (full-table)',
		source: 'full-table',
	};
	pinTrend(input, value, deps);
	return {
		value,
		confidence: 'high',
		toolCalls: [],
	};
}

interface TemporalTrendResultRaw {
	readonly target: string;
	readonly timestampColumn: string;
	readonly valueColumn: string;
	readonly n: number;
	readonly slope: number | null;
	readonly slopePerDay: number | null;
	readonly intercept: number | null;
	readonly r2: number | null;
	readonly minTimestampEpoch: number | null;
	readonly maxTimestampEpoch: number | null;
}

function isTemporalTrendResult(v: unknown): v is TemporalTrendResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['n'] === 'number'
		&& (o['slope']     === null || typeof o['slope']     === 'number')
		&& (o['intercept'] === null || typeof o['intercept'] === 'number')
		&& (o['r2']        === null || typeof o['r2']        === 'number');
}

function numericFromAgg(v: number | string | null | undefined): number | null {
	if (v === null || v === undefined) return null;
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function describeTrend(
	direction: Direction,
	strength: Strength,
	slopePerDay: number,
	rSquared: number,
	n: number,
): string {
	const r2 = rSquared.toFixed(3);
	if (direction === 'flat') {
		return `slope is effectively zero (within 5% of value range); the metric is flat over the sampled window. R²=${r2}, n=${n}`;
	}
	const sign = direction === 'increasing' ? '+' : '';
	const perDay = slopePerDay.toFixed(4);
	return `${strength} ${direction} trend: slope ≈ ${sign}${perDay} per day; R²=${r2} (n=${n})`;
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
	return Math.min(Math.max(10, Math.floor(n)), 50);
}

function empty(input: TimeseriesTrendInput): TimeseriesTrendOutput {
	return {
		target: input.target,
		timestampColumn: input.timestampColumn,
		valueColumn: input.valueColumn,
		sampleSize: 0,
		count: null, valueMean: null,
		slope: null, slopePerDay: null,
		intercept: null, rSquared: null,
		direction: 'flat',
		strength: 'inconclusive',
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

const OWNER_ID: OwnerId = 'skill:data.timeseries.trend.rdbms';
const NAMESPACE = 'trend-reports';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: TimeseriesTrendInput): string {
	const ss = input.sampleSize ?? '';
	const m = input.mode ?? 'sample';
	return `${input.connectionId}::${input.target}::${input.timestampColumn}::${input.valueColumn}::${m}::${ss}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-trend',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as TimeseriesTrendInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'TimeseriesTrendOutput',
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

function readCachedTrend(input: TimeseriesTrendInput, deps: SkillDeps): TimeseriesTrendOutput | undefined {
	const slot = deps.context?.slots.get('cached-trend');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<TimeseriesTrendOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinTrend(input: TimeseriesTrendInput, value: TimeseriesTrendOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'db_sql_temporal_trend' },
		payload: value,
		claims:  [`trend:${cacheKey(input)}`],
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

export function registerDataTimeseriesTrendRdbmsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
