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
import type { Skill, SkillResult, SkillToolResult } from '../types.js';

const SAMPLE_DEFAULT = 50;
const MS_PER_DAY = 86_400_000;

interface TimeseriesTrendInput {
	readonly connectionId: string;
	readonly target: string;
	readonly timestampColumn: string;
	readonly valueColumn: string;
	readonly sampleSize?: number;
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
		},
		required: ['target', 'timestampColumn', 'valueColumn', 'sampleSize',
		           'count', 'valueMean', 'slope', 'slopePerDay', 'intercept', 'rSquared',
		           'direction', 'strength', 'interpretation'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_aggregate', 'db_sql_sample'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate', 'db_sql_sample'],
			reason: 'aggregate gives count + mean for context; sample gives the (timestamp, value) pairs',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<TimeseriesTrendOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampSample(input.sampleSize);

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
		return {
			value: {
				target: aggData.target,
				timestampColumn: input.timestampColumn,
				valueColumn: input.valueColumn,
				sampleSize: n,
				count, valueMean,
				slope, slopePerDay, intercept, rSquared,
				direction, strength,
				interpretation,
			},
			confidence: 'high',
			toolCalls: [],
		};
	},
};

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

export function registerDataTimeseriesTrendRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
