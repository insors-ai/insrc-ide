/**
 * data.distribution.outliers-mad.rdbms -- Phase 5b.4 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: MAD (median absolute deviation) outlier detection
 * on a numeric column. Robust to skewed / heavy-tailed data --
 * neither IQR-based nor Z-score-based detection handles those well.
 *
 * Modified Z-score formulation:
 *   m   = median(x)
 *   MAD = median(|x_i - m|)
 *   M_i = 0.6745 * (x_i - m) / MAD
 *   outlier when |M_i| > threshold (default 3.5)
 *
 * Equivalently: a value is flagged when
 *   |x - m| > threshold * MAD / 0.6745
 *
 * Hybrid server / sample. The median comes from `db_sql_aggregate`
 * (percentile_50 over the full table; precise). The MAD itself
 * needs a two-pass query (`median(abs(x - median(x)))`) which the
 * current aggregate tool doesn't expose -- we compute MAD over the
 * 50-row sample, which is **approximate** but usually within an
 * order of magnitude of the true MAD on well-behaved data. Output
 * surfaces this via the `madSource: 'sample'` field.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult, SkillToolResult } from '../types.js';

const MAD_TO_SIGMA = 1 / 0.6745;  // ~1.4826

interface OutliersMadInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	/** Modified Z-score threshold; default 3.5. */
	readonly threshold?: number;
	readonly sampleSize?: number;
}

interface OutliersMadOutput {
	readonly target: string;
	readonly column: string;
	readonly threshold: number;
	readonly median: number | null;
	readonly mad: number | null;
	readonly madSource: 'sample' | 'unknown';
	readonly lowerBound: number | null;
	readonly upperBound: number | null;
	readonly min: number | null;
	readonly max: number | null;
	readonly count: number | null;
	readonly nonNullCount: number | null;
	readonly hasFullTableOutliers: boolean | null;
	readonly sampleSize: number;
	readonly sampleOutlierCount: number;
	readonly sampleOutlierRate: number | null;
	readonly examples: {
		readonly low:  readonly { value: number; modifiedZ: number }[];
		readonly high: readonly { value: number; modifiedZ: number }[];
	};
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<OutliersMadInput, OutliersMadOutput> = {
	id: 'data.distribution.outliers-mad.rdbms',
	name: 'Distribution: MAD outliers (RDBMS)',
	description:
		'MAD (median absolute deviation) outlier detection on a numeric column. Robust to skewed / heavy- ' +
		'tailed distributions where IQR / Z-score detection underperforms. Median computed server-side; ' +
		'MAD computed over a 50-row sample (the only value that\'s sample-derived) -- the result\'s ' +
		'`madSource: \'sample\'` field surfaces this. Modified Z-score threshold default 3.5.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			threshold:    { type: 'number', minimum: 0.5, maximum: 10, description: 'Modified Z-score threshold; default 3.5.' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:               { type: 'string' },
			column:               { type: 'string' },
			threshold:            { type: 'number' },
			median:               { type: ['number', 'null'] },
			mad:                  { type: ['number', 'null'] },
			madSource:            { type: 'string', enum: ['sample', 'unknown'] },
			lowerBound:           { type: ['number', 'null'] },
			upperBound:           { type: ['number', 'null'] },
			min:                  { type: ['number', 'null'] },
			max:                  { type: ['number', 'null'] },
			count:                { type: ['number', 'null'] },
			nonNullCount:         { type: ['number', 'null'] },
			hasFullTableOutliers: { type: ['boolean', 'null'] },
			sampleSize:           { type: 'number' },
			sampleOutlierCount:   { type: 'number' },
			sampleOutlierRate:    { type: ['number', 'null'] },
			examples: {
				type: 'object',
				properties: {
					low: {
						type: 'array',
						items: {
							type: 'object',
							properties: { value: { type: 'number' }, modifiedZ: { type: 'number' } },
							required: ['value', 'modifiedZ'],
							additionalProperties: false,
						},
					},
					high: {
						type: 'array',
						items: {
							type: 'object',
							properties: { value: { type: 'number' }, modifiedZ: { type: 'number' } },
							required: ['value', 'modifiedZ'],
							additionalProperties: false,
						},
					},
				},
				required: ['low', 'high'],
				additionalProperties: false,
			},
		},
		required: ['target', 'column', 'threshold', 'median', 'mad', 'madSource',
		           'lowerBound', 'upperBound', 'min', 'max', 'count', 'nonNullCount',
		           'hasFullTableOutliers', 'sampleSize', 'sampleOutlierCount',
		           'sampleOutlierRate', 'examples'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_aggregate', 'db_sql_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate', 'db_sql_sample'],
			reason: 'aggregate gives the median; sample lets us compute MAD + examples',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<OutliersMadOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const threshold = clampThreshold(input.threshold);
		const sampleSize = clampSample(input.sampleSize);
		const col = input.column;

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({
				id: `${callBase}-agg`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: [
						{ column: col, function: 'count' },
						{ column: col, function: 'count_non_null' },
						{ column: col, function: 'min' },
						{ column: col, function: 'max' },
						{ column: col, function: 'percentile', args: { p: 0.5 } },
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
				notes: ['outliers-mad: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const v = aggData.values;
		const count = v[`${col}__count`] ?? null;
		const nonNullCount = v[`${col}__count_non_null`] ?? null;
		const min = v[`${col}__min`] ?? null;
		const max = v[`${col}__max`] ?? null;
		const median = v[`${col}__percentile_0_5`] ?? null;

		// Pull sample numerics for this column.
		const sampleValues: number[] = [];
		if (sampleData.columns.includes(col)) {
			for (const row of sampleData.rows) {
				const raw = row[col];
				if (raw === null || raw === undefined) continue;
				const num = typeof raw === 'number' ? raw : Number(raw);
				if (Number.isFinite(num)) sampleValues.push(num);
			}
		}

		// Compute MAD over sample (only when we have median + sample).
		let mad: number | null = null;
		let madSource: 'sample' | 'unknown' = 'unknown';
		if (median !== null && sampleValues.length > 0) {
			const deviations = sampleValues.map(x => Math.abs(x - median)).sort((a, b) => a - b);
			const mid = Math.floor(deviations.length / 2);
			mad = deviations.length % 2 === 0
				? (deviations[mid - 1]! + deviations[mid]!) / 2
				: deviations[mid]!;
			madSource = 'sample';
		}

		let lowerBound: number | null = null;
		let upperBound: number | null = null;
		let hasFullTableOutliers: boolean | null = null;
		if (median !== null && mad !== null && mad > 0) {
			const halfWidth = threshold * mad * MAD_TO_SIGMA;
			lowerBound = median - halfWidth;
			upperBound = median + halfWidth;
			if (min !== null && max !== null) {
				hasFullTableOutliers = min < lowerBound || max > upperBound;
			}
		}

		// Sample-based outlier examples.
		let sampleOutlierCount = 0;
		const low: { value: number; modifiedZ: number }[] = [];
		const high: { value: number; modifiedZ: number }[] = [];
		if (median !== null && mad !== null && mad > 0
		    && lowerBound !== null && upperBound !== null) {
			for (const num of sampleValues) {
				const modZ = 0.6745 * (num - median) / mad;
				if (num < lowerBound) {
					sampleOutlierCount++;
					if (low.length < 3) low.push({ value: num, modifiedZ: modZ });
				} else if (num > upperBound) {
					sampleOutlierCount++;
					if (high.length < 3) high.push({ value: num, modifiedZ: modZ });
				}
			}
		}
		const sampleObserved = sampleValues.length;
		const sampleOutlierRate = sampleObserved > 0 ? sampleOutlierCount / sampleObserved : null;

		return {
			value: {
				target: aggData.target,
				column: col,
				threshold,
				median, mad, madSource,
				lowerBound, upperBound,
				min, max,
				count, nonNullCount,
				hasFullTableOutliers,
				sampleSize: sampleObserved,
				sampleOutlierCount,
				sampleOutlierRate,
				examples: { low, high },
			},
			confidence: lowerBound !== null && upperBound !== null && sampleObserved > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

function clampThreshold(t: number | undefined): number {
	if (typeof t !== 'number' || !Number.isFinite(t)) return 3.5;
	return Math.min(Math.max(0.5, t), 10);
}

function clampSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 50;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

function empty(target: string, column: string, threshold: number): OutliersMadOutput {
	return {
		target, column, threshold,
		median: null, mad: null, madSource: 'unknown',
		lowerBound: null, upperBound: null,
		min: null, max: null,
		count: null, nonNullCount: null,
		hasFullTableOutliers: null,
		sampleSize: 0, sampleOutlierCount: 0, sampleOutlierRate: null,
		examples: { low: [], high: [] },
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

export function registerDataDistributionOutliersMadRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
