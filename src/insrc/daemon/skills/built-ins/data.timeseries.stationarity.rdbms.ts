/**
 * data.timeseries.stationarity.rdbms -- Phase 5g.3 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic timeseries skill: tests whether a (timestamp, value) series
 * is stationary using the Dickey-Fuller unit-root test (the simple,
 * non-augmented form -- DF, not ADF). A stationary series has
 * statistical properties (mean, variance, autocorrelation) that don't
 * depend on the time of observation; a non-stationary series wanders
 * (random walk, trending random walk, etc.).
 *
 * Why this matters for data analysis: many downstream techniques
 * (regression, ARMA, hypothesis testing on means) assume stationarity.
 * A non-stationary metric needs differencing or detrending before
 * those tools work cleanly. Pairs with 5g.1 (trend) and 5g.2
 * (seasonality) -- trend captures slope, seasonality captures
 * periodicity, stationarity captures whether the process has a
 * persistent shock structure (random-walk-like) vs. mean-reverting.
 *
 * The math (constant-only DF model):
 *   Regress  Δy[t] = α + β * y[t-1] + ε
 *   Compute  t = β / SE(β)
 *   Compare  t to MacKinnon critical value for n
 *
 * Null hypothesis (H₀): β = 0 (random walk, non-stationary)
 * Reject H₀ when t < critical value -> series IS stationary
 *
 * Critical values (constant model, MacKinnon 1996), n=50:
 *   1%:  -3.58
 *   5%:  -2.93
 *   10%: -2.60
 *
 * v1 limits: simple DF (no augmented lagged-difference terms). The
 * augmented form (ADF) adds k lagged diffs as controls for serial
 * correlation in residuals; would need a 5x5+ matrix inverse for
 * default Schwert k=4 at n=50, ~100 lines of matrix code. Deferred
 * until a sample shows pronounced AR structure that DF mis-classifies.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult, SkillToolResult } from '../types.js';

const SAMPLE_DEFAULT = 50;
const MIN_SAMPLE     = 20;

// MacKinnon (1996) critical values for the constant-only Dickey-Fuller
// model, sample size n=50. Using a single n value (we cap at 50) keeps
// the table tiny; if the cap ever moves we'll need to interpolate.
const CV_50 = {
	pct1:  -3.58,
	pct5:  -2.93,
	pct10: -2.60,
} as const;

interface TimeseriesStationarityInput {
	readonly connectionId: string;
	readonly target: string;
	readonly timestampColumn: string;
	readonly valueColumn: string;
	readonly sampleSize?: number;
}

type Verdict = 'stationary' | 'non-stationary' | 'inconclusive';

interface TimeseriesStationarityOutput {
	readonly target: string;
	readonly timestampColumn: string;
	readonly valueColumn: string;
	readonly sampleSize: number;
	readonly count: number | null;             // full-table non-null count (server)
	readonly tStatistic: number | null;        // DF test statistic
	readonly beta: number | null;              // estimated coefficient on y[t-1]
	readonly betaStdErr: number | null;
	readonly alpha: number | null;             // estimated constant
	readonly criticalValue1pct: number;
	readonly criticalValue5pct: number;
	readonly criticalValue10pct: number;
	readonly rejectsAtLevel: '1%' | '5%' | '10%' | 'none';
	readonly verdict: Verdict;
	readonly interpretation: string;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<TimeseriesStationarityInput, TimeseriesStationarityOutput> = {
	id: 'data.timeseries.stationarity.rdbms',
	name: 'Timeseries: stationarity (RDBMS)',
	description:
		'Dickey-Fuller unit-root test on a (timestamp, value) sample. Regresses Δy[t] = α + β·y[t-1] + ε ' +
		'and compares the t-statistic on β to MacKinnon critical values. Verdict: stationary (rejects H₀ ' +
		'at 5% level), non-stationary (fails to reject), or inconclusive (n<20 or constant series). ' +
		'Sample-based at n=50 (min n=20). Constant-only DF model -- no augmented lagged-diff terms.',
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
			sampleSize:      { type: 'integer', minimum: MIN_SAMPLE, maximum: 50, description: 'Min 20 (DF unstable below); default 50.' },
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
			tStatistic:               { type: ['number', 'null'] },
			beta:                     { type: ['number', 'null'] },
			betaStdErr:               { type: ['number', 'null'] },
			alpha:                    { type: ['number', 'null'] },
			criticalValue1pct:        { type: 'number' },
			criticalValue5pct:        { type: 'number' },
			criticalValue10pct:       { type: 'number' },
			rejectsAtLevel:           { type: 'string', enum: ['1%', '5%', '10%', 'none'] },
			verdict:                  { type: 'string', enum: ['stationary', 'non-stationary', 'inconclusive'] },
			interpretation:           { type: 'string' },
		},
		required: ['target', 'timestampColumn', 'valueColumn', 'sampleSize',
		           'count', 'tStatistic', 'beta', 'betaStdErr', 'alpha',
		           'criticalValue1pct', 'criticalValue5pct', 'criticalValue10pct',
		           'rejectsAtLevel', 'verdict', 'interpretation'],
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

	async execute(input, deps): Promise<SkillResult<TimeseriesStationarityOutput>> {
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
				notes: ['timeseries.stationarity: tool result missing structured data'],
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
					interpretation: `sample too small (n=${n}); need at least ${MIN_SAMPLE} (timestamp, value) pairs for a stable DF test`,
				},
				confidence: 'medium',
				toolCalls: [],
			};
		}

		// Build the DF regression. Independent variable: y[t-1].
		// Dependent variable: Δy[t] = y[t] - y[t-1]. Both vectors of
		// length n-1 (skip the first observation since we have no lag
		// for it).
		const yLag: number[] = [];
		const dy: number[] = [];
		for (let i = 1; i < n; i++) {
			yLag.push(pairs[i - 1]!.y);
			dy.push(pairs[i]!.y - pairs[i - 1]!.y);
		}
		const m = yLag.length;  // = n - 1

		// OLS for Δy[t] = α + β * y[t-1] + ε.
		// β = Σ((x - x̄)(y - ȳ)) / Σ((x - x̄)²)
		// α = ȳ - β x̄
		// SE(β) = sqrt(σ² / Σ((x - x̄)²))
		// where σ² = RSS / (m - 2).
		const xMean = yLag.reduce((s, x) => s + x, 0) / m;
		const yMean = dy.reduce((s, y) => s + y, 0) / m;
		let sxx = 0, sxy = 0;
		for (let i = 0; i < m; i++) {
			const dx = yLag[i]! - xMean;
			const ddy = dy[i]! - yMean;
			sxx += dx * dx;
			sxy += dx * ddy;
		}

		if (sxx === 0) {
			return {
				value: {
					...empty(input),
					sampleSize: n, count,
					interpretation: 'lag series y[t-1] is constant; DF regression undefined (series is trivially constant -- treat as non-stationary degenerate)',
				},
				confidence: 'medium',
				toolCalls: [],
			};
		}

		const beta  = sxy / sxx;
		const alpha = yMean - beta * xMean;

		// Residuals + RSS.
		let rss = 0;
		for (let i = 0; i < m; i++) {
			const fitted = alpha + beta * yLag[i]!;
			const resid = dy[i]! - fitted;
			rss += resid * resid;
		}
		const sigmaSquared = rss / Math.max(1, m - 2);
		const betaStdErr = Math.sqrt(sigmaSquared / sxx);

		if (betaStdErr === 0 || !Number.isFinite(betaStdErr)) {
			return {
				value: {
					...empty(input),
					sampleSize: n, count,
					interpretation: 'standard error of β is zero (perfect fit) -- the series is deterministic; DF test inapplicable',
				},
				confidence: 'medium',
				toolCalls: [],
			};
		}

		const tStatistic = beta / betaStdErr;

		// Compare to critical values. DF test is one-sided: reject H₀
		// when t is MORE NEGATIVE than the critical value.
		let rejectsAtLevel: '1%' | '5%' | '10%' | 'none';
		if (tStatistic < CV_50.pct1)       rejectsAtLevel = '1%';
		else if (tStatistic < CV_50.pct5)  rejectsAtLevel = '5%';
		else if (tStatistic < CV_50.pct10) rejectsAtLevel = '10%';
		else                               rejectsAtLevel = 'none';

		const verdict: Verdict = rejectsAtLevel === 'none' ? 'non-stationary' : 'stationary';
		const interpretation = describe(verdict, rejectsAtLevel, tStatistic, n);

		return {
			value: {
				target: aggData.target,
				timestampColumn: input.timestampColumn,
				valueColumn: input.valueColumn,
				sampleSize: n,
				count,
				tStatistic,
				beta, betaStdErr, alpha,
				criticalValue1pct:  CV_50.pct1,
				criticalValue5pct:  CV_50.pct5,
				criticalValue10pct: CV_50.pct10,
				rejectsAtLevel,
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
	level: '1%' | '5%' | '10%' | 'none',
	t: number,
	n: number,
): string {
	if (verdict === 'inconclusive') return '';
	if (verdict === 'non-stationary') {
		return `non-stationary: t-statistic ${t.toFixed(3)} > critical value ${CV_50.pct10} (10% level); fails to reject the unit-root null. Series may need differencing or detrending before regression / ARMA modelling. (n=${n})`;
	}
	const cv = level === '1%' ? CV_50.pct1 : level === '5%' ? CV_50.pct5 : CV_50.pct10;
	return `stationary at the ${level} level: t-statistic ${t.toFixed(3)} < critical value ${cv}; rejects the unit-root null. Series is mean-reverting / has stable variance over the sampled window. (n=${n})`;
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

function empty(input: TimeseriesStationarityInput): TimeseriesStationarityOutput {
	return {
		target: input.target,
		timestampColumn: input.timestampColumn,
		valueColumn: input.valueColumn,
		sampleSize: 0,
		count: null,
		tStatistic: null,
		beta: null,
		betaStdErr: null,
		alpha: null,
		criticalValue1pct:  CV_50.pct1,
		criticalValue5pct:  CV_50.pct5,
		criticalValue10pct: CV_50.pct10,
		rejectsAtLevel: 'none',
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

export function registerDataTimeseriesStationarityRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
