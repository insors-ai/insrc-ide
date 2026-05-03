/**
 * data.distribution.heavy-tail-check.rdbms -- Phase 5b.6 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic distribution skill: binary verdict on whether a numeric
 * column has heavy / light / normal tails, computed from sample
 * kurtosis. Excess kurtosis (kurtosis - 3) is the signal:
 *
 *   excess >  +threshold  -> heavy-tailed (leptokurtic)
 *   excess <  -threshold  -> light-tailed (platykurtic)
 *   |excess| <= threshold -> mesokurtic (normal-ish tails)
 *
 * Default threshold = 1.0 -- a value typically considered
 * "noticeably non-normal" in applied stats. Raise it for stricter
 * verdicts.
 *
 * **Sample-based.** `db_sql_aggregate` doesn't expose `kurtosis`
 * yet -- adding it is a small future extension. Until then we
 * compute kurtosis over the 50-row sample. Plan §5b says "n >= 200"
 * for this skill; the v1 ships at n >= 50 (the sampling tool's
 * cap) and documents the precision limit. Kurtosis estimators are
 * notoriously high-variance at small n; treat the verdict as a
 * *signal*, not a guarantee.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult, SkillToolResult } from '../types.js';

const SAMPLE_DEFAULT = 50;

interface HeavyTailInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	/** Excess-kurtosis threshold; default 1.0. */
	readonly threshold?: number;
}

type Verdict = 'heavy-tailed' | 'light-tailed' | 'mesokurtic' | 'inconclusive';

interface HeavyTailOutput {
	readonly target: string;
	readonly column: string;
	readonly sampleSize: number;
	readonly count: number | null;
	readonly mean: number | null;
	readonly stddev: number | null;
	readonly kurtosis: number | null;
	readonly excessKurtosis: number | null;
	readonly threshold: number;
	readonly verdict: Verdict;
	readonly interpretation: string;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<HeavyTailInput, HeavyTailOutput> = {
	id: 'data.distribution.heavy-tail-check.rdbms',
	name: 'Distribution: heavy-tail check (RDBMS)',
	description:
		'Binary verdict on tail heaviness from sample kurtosis. Returns heavy-tailed / light-tailed / ' +
		'mesokurtic / inconclusive plus the excess-kurtosis value (kurtosis - 3). Default threshold 1.0. ' +
		'Sample-based (n=50; precision-limited compared to the plan\'s n>=200 ideal). Pairs with the ' +
		'outlier picker -- heavy-tailed columns warrant MAD over IQR / Z-score.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			threshold:    { type: 'number', minimum: 0.1, maximum: 10, description: 'Excess-kurtosis threshold; default 1.0.' },
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
			kurtosis:       { type: ['number', 'null'] },
			excessKurtosis: { type: ['number', 'null'] },
			threshold:      { type: 'number' },
			verdict:        { type: 'string', enum: ['heavy-tailed', 'light-tailed', 'mesokurtic', 'inconclusive'] },
			interpretation: { type: 'string' },
		},
		required: ['target', 'column', 'sampleSize', 'count', 'mean', 'stddev',
		           'kurtosis', 'excessKurtosis', 'threshold', 'verdict', 'interpretation'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_aggregate', 'db_sql_sample'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate', 'db_sql_sample'],
			reason: 'aggregate gives full-table mean / stddev for context; sample lets us compute kurtosis',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
		{
			kind: 'min-sample-size',
			n: 50,
			reason: 'sample kurtosis is unstable below n=50; plan §5b ideal is n>=200, ship n>=50 until broader sampling lands',
		},
	],

	async execute(input, deps): Promise<SkillResult<HeavyTailOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const threshold = clampThreshold(input.threshold);
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
				value: empty(input.target, col, threshold),
				confidence: 'low',
				notes: errors,
				toolCalls: [],
			};
		}

		const aggData = aggTool.data;
		const sampleData = sampleTool.data;
		if (!isAggregateResult(aggData) || !isSampleResult(sampleData)) {
			return {
				value: empty(input.target, col, threshold),
				confidence: 'low',
				notes: ['heavy-tail-check: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const count = aggData.values[`${col}__count_non_null`] ?? null;
		const mean  = aggData.values[`${col}__avg`] ?? null;
		const stddev = aggData.values[`${col}__stddev`] ?? null;

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

		let kurtosis: number | null = null;
		let excessKurtosis: number | null = null;
		let verdict: Verdict = 'inconclusive';
		let interpretation = '';

		if (n >= 4) {
			const sampleMean = values.reduce((a, b) => a + b, 0) / n;
			let m2 = 0, m4 = 0;
			for (const x of values) {
				const d = x - sampleMean;
				const d2 = d * d;
				m2 += d2;
				m4 += d2 * d2;
			}
			m2 /= n;
			m4 /= n;
			if (m2 > 0) {
				kurtosis = m4 / (m2 * m2);
				excessKurtosis = kurtosis - 3;
				if (n >= 50) {
					if (excessKurtosis > threshold) {
						verdict = 'heavy-tailed';
						interpretation = `excess kurtosis ${excessKurtosis.toFixed(2)} > +${threshold}; heavier tails than normal -- consider MAD over IQR / Z-score for outlier detection`;
					} else if (excessKurtosis < -threshold) {
						verdict = 'light-tailed';
						interpretation = `excess kurtosis ${excessKurtosis.toFixed(2)} < -${threshold}; lighter tails than normal (uniform-like)`;
					} else {
						verdict = 'mesokurtic';
						interpretation = `excess kurtosis ${excessKurtosis.toFixed(2)} within ±${threshold}; normal-shaped tails`;
					}
				} else {
					interpretation = `sample size n=${n} below the 50-row floor; verdict suppressed (kurtosis estimate too noisy)`;
				}
			} else {
				interpretation = 'sample is constant (variance = 0); kurtosis undefined';
			}
		} else {
			interpretation = `sample too small (n=${n}); need at least 4 non-null observations`;
		}

		return {
			value: {
				target: aggData.target,
				column: col,
				sampleSize: n,
				count, mean, stddev,
				kurtosis, excessKurtosis,
				threshold,
				verdict,
				interpretation,
			},
			confidence: verdict === 'inconclusive' ? 'medium' : 'high',
			toolCalls: [],
		};
	},
};

function clampThreshold(t: number | undefined): number {
	if (typeof t !== 'number' || !Number.isFinite(t)) return 1.0;
	return Math.min(Math.max(0.1, t), 10);
}

function empty(target: string, column: string, threshold: number): HeavyTailOutput {
	return {
		target, column,
		sampleSize: 0,
		count: null, mean: null, stddev: null,
		kurtosis: null, excessKurtosis: null,
		threshold,
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

export function registerDataDistributionHeavyTailCheckRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
