/**
 * data.distribution.normality-test.rdbms -- Phase 5b.5 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: Jarque-Bera normality test on a numeric RDBMS
 * column. The test statistic
 *
 *   JB = n/6 * (S^2 + (K - 3)^2 / 4)
 *
 * (where S = skewness, K = kurtosis, n = sample size) follows a
 * chi-squared distribution with 2 degrees of freedom under the
 * null hypothesis of normality. The p-value has the closed form
 * `exp(-JB / 2)` for chi-squared(2), so no external stats library
 * is needed.
 *
 * **Why JB over Shapiro-Wilk.** Shapiro-Wilk is the gold standard
 * for n < 5000 but its Royston (1982) approximation is ~60 lines
 * of careful coefficient math; getting it right and verifying it
 * exceeds the value of marginally-better small-sample power. JB
 * works well for n >= 50, which is exactly the
 * `min-sample-size` precondition this skill declares.
 *
 * Mean and stddev are pulled server-side (precise, full-table
 * values) but skewness and kurtosis are computed over the 50-row
 * sample (db_sql_aggregate doesn't expose `skewness` or
 * `kurtosis` aggregate functions yet -- adding them is a small
 * future extension). This is documented in `momentSource: 'sample'`.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult, SkillToolResult } from '../types.js';

const SAMPLE_DEFAULT = 50;

interface NormalityTestInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly sampleSize?: number;
	/** Significance level for the verdict; default 0.05. */
	readonly alpha?: number;
}

type Verdict = 'normal' | 'non-normal' | 'inconclusive';

interface NormalityTestOutput {
	readonly target: string;
	readonly column: string;
	readonly sampleSize: number;
	readonly count: number | null;
	readonly mean: number | null;
	readonly stddev: number | null;
	readonly skewness: number | null;
	readonly kurtosis: number | null;
	readonly momentSource: 'sample' | 'unknown';
	readonly alpha: number;
	readonly jbStatistic: number | null;
	readonly pValue: number | null;
	readonly verdict: Verdict;
	readonly interpretation: string;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<NormalityTestInput, NormalityTestOutput> = {
	id: 'data.distribution.normality-test.rdbms',
	name: 'Distribution: Jarque-Bera normality test (RDBMS)',
	description:
		'Jarque-Bera normality test on a numeric column. Pulls server-side mean / stddev for anchoring, ' +
		'computes sample skewness + kurtosis over a 50-row sample, returns JB statistic + p-value + a ' +
		'verdict (normal / non-normal / inconclusive). Default alpha=0.05. Skewness / kurtosis are sample- ' +
		'derived; full-table moments need aggregate-tool extensions not yet shipped. Requires n >= 50.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			sampleSize:   { type: 'integer', minimum: 50, maximum: 50, description: 'Fixed at 50 (the tool cap matches the JB power floor).' },
			alpha:        { type: 'number',  minimum: 0.001, maximum: 0.5, description: 'Significance level; default 0.05.' },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:         { type: 'string' },
			column:         { type: 'string' },
			sampleSize:     { type: 'number' },
			count:          { type: ['number', 'null'] },
			mean:           { type: ['number', 'null'] },
			stddev:         { type: ['number', 'null'] },
			skewness:       { type: ['number', 'null'] },
			kurtosis:       { type: ['number', 'null'] },
			momentSource:   { type: 'string', enum: ['sample', 'unknown'] },
			alpha:          { type: 'number' },
			jbStatistic:    { type: ['number', 'null'] },
			pValue:         { type: ['number', 'null'] },
			verdict:        { type: 'string', enum: ['normal', 'non-normal', 'inconclusive'] },
			interpretation: { type: 'string' },
		},
		required: ['target', 'column', 'sampleSize', 'count', 'mean', 'stddev',
		           'skewness', 'kurtosis', 'momentSource', 'alpha',
		           'jbStatistic', 'pValue', 'verdict', 'interpretation'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_aggregate', 'db_sql_sample'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate', 'db_sql_sample'],
			reason: 'aggregate gives full-table mean / stddev; sample lets us compute skewness + kurtosis',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
		{
			kind: 'min-sample-size',
			n: 50,
			reason: 'Jarque-Bera has weak power below n=50; the verdict would be unreliable',
		},
	],

	async execute(input, deps): Promise<SkillResult<NormalityTestOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const alpha = clampAlpha(input.alpha);
		const col = input.column;

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({
				id: `${callBase}-agg`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: [
						{ column: col, function: 'count_non_null' },
						{ column: col, function: 'avg' },
						{ column: col, function: 'stddev' },
					],
				},
			}),
			deps.runTool({
				id: `${callBase}-sample`,
				name: 'db_sql_sample',
				input: { connectionId: input.connectionId, target: input.target, limit: SAMPLE_DEFAULT },
			}),
		]);

		const errors = collectToolErrors([['db_sql_aggregate', aggTool], ['db_sql_sample', sampleTool]]);
		if (errors.length > 0) {
			return {
				value: empty(input.target, col, alpha),
				confidence: 'low',
				notes: errors,
				toolCalls: [],
			};
		}

		const aggData = aggTool.data;
		const sampleData = sampleTool.data;
		if (!isAggregateResult(aggData) || !isSampleResult(sampleData)) {
			return {
				value: empty(input.target, col, alpha),
				confidence: 'low',
				notes: ['normality-test: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const count = aggData.values[`${col}__count_non_null`] ?? null;
		const mean  = aggData.values[`${col}__avg`] ?? null;
		const stddev = aggData.values[`${col}__stddev`] ?? null;

		// Pull numeric sample values.
		const values: number[] = [];
		if (sampleData.columns.includes(col)) {
			for (const row of sampleData.rows) {
				const raw = row[col];
				if (raw === null || raw === undefined) continue;
				const num = typeof raw === 'number' ? raw : Number(raw);
				if (Number.isFinite(num)) values.push(num);
			}
		}
		const n = values.length;

		// Compute skewness + kurtosis from the sample (using sample
		// mean / stddev for normalisation -- if we used the server
		// mean / stddev the moments would be biased toward zero).
		let skewness: number | null = null;
		let kurtosis: number | null = null;
		let jbStatistic: number | null = null;
		let pValue: number | null = null;
		let verdict: Verdict = 'inconclusive';
		let interpretation = '';
		let momentSource: 'sample' | 'unknown' = 'unknown';

		if (n >= 4) {
			const sampleMean = values.reduce((a, b) => a + b, 0) / n;
			let m2 = 0, m3 = 0, m4 = 0;
			for (const x of values) {
				const d = x - sampleMean;
				const d2 = d * d;
				m2 += d2;
				m3 += d2 * d;
				m4 += d2 * d2;
			}
			m2 /= n;
			m3 /= n;
			m4 /= n;
			const sampleStddev = Math.sqrt(m2);
			if (sampleStddev > 0) {
				skewness = m3 / Math.pow(sampleStddev, 3);
				kurtosis = m4 / Math.pow(sampleStddev, 4);
				momentSource = 'sample';

				if (n >= 50) {
					jbStatistic = (n / 6) * (skewness * skewness + Math.pow(kurtosis - 3, 2) / 4);
					// chi-squared(2) survival function: exp(-x/2)
					pValue = Math.exp(-jbStatistic / 2);
					if (pValue >= alpha) {
						verdict = 'normal';
						interpretation = `JB statistic = ${jbStatistic.toFixed(2)}, p = ${pValue.toFixed(4)}; cannot reject normality at alpha=${alpha}`;
					} else {
						verdict = 'non-normal';
						interpretation = describeShape(skewness, kurtosis, jbStatistic, pValue, alpha);
					}
				} else {
					verdict = 'inconclusive';
					interpretation = `sample size n=${n} below the 50-row floor for Jarque-Bera; moments computed but verdict suppressed`;
				}
			} else {
				interpretation = 'sample is constant (stddev = 0); normality undefined';
			}
		} else {
			interpretation = `sample too small (n=${n}); need at least 4 non-null observations`;
		}

		return {
			value: {
				target: aggData.target,
				column: col,
				sampleSize: n,
				count,
				mean,
				stddev,
				skewness,
				kurtosis,
				momentSource,
				alpha,
				jbStatistic,
				pValue,
				verdict,
				interpretation,
			},
			// `high` when the verdict landed (normal or non-normal).
			// `medium` when inconclusive (sample too small / constant).
			// `low` cases already returned above.
			confidence: verdict === 'inconclusive' ? 'medium' : 'high',
			toolCalls: [],
		};
	},
};

function describeShape(
	skewness: number, kurtosis: number, jb: number, p: number, alpha: number,
): string {
	const parts: string[] = [
		`JB statistic = ${jb.toFixed(2)}, p = ${p.toExponential(2)} (< alpha=${alpha})`,
	];
	if (Math.abs(skewness) > 1) {
		parts.push(skewness > 0 ? 'right-skewed (positive skew)' : 'left-skewed (negative skew)');
	} else if (Math.abs(skewness) > 0.5) {
		parts.push(skewness > 0 ? 'mildly right-skewed' : 'mildly left-skewed');
	}
	const excessKurt = kurtosis - 3;
	if (excessKurt > 1) parts.push('heavy-tailed (leptokurtic)');
	else if (excessKurt < -1) parts.push('light-tailed (platykurtic)');
	return parts.join('; ');
}

function clampAlpha(a: number | undefined): number {
	if (typeof a !== 'number' || !Number.isFinite(a)) return 0.05;
	return Math.min(Math.max(0.001, a), 0.5);
}

function empty(target: string, column: string, alpha: number): NormalityTestOutput {
	return {
		target, column,
		sampleSize: 0,
		count: null, mean: null, stddev: null,
		skewness: null, kurtosis: null,
		momentSource: 'unknown',
		alpha,
		jbStatistic: null, pValue: null,
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

export function registerDataDistributionNormalityTestRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
