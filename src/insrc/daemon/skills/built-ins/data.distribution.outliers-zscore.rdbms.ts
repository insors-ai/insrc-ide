/**
 * data.distribution.outliers-zscore.rdbms -- Phase 5b.3 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: Z-score outlier detection on a numeric column. A
 * value `x` is flagged when `|z| > threshold`, where
 * `z = (x - mean) / stddev`. Default threshold = 3.0 (the classic
 * "outside 3-sigma" rule).
 *
 * Z-score outlier detection is parametric -- it ASSUMES roughly
 * normal data. If the column is skewed or heavy-tailed, the IQR
 * variant (`data.distribution.outliers-iqr.rdbms`) is more
 * robust. Callers picking which variant to run can use
 * `data.profile.numeric.rdbms` first to inspect mean / stddev /
 * percentile spread.
 *
 * Same sample-vs-server tradeoff as the IQR sibling: bounds come
 * from server-side aggregate (mean + stddev); examples + estimated
 * count come from the 50-row sample.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult, SkillToolResult } from '../types.js';

interface OutliersZScoreInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	/** Z threshold; default 3.0. */
	readonly threshold?: number;
	readonly sampleSize?: number;
}

interface OutliersZScoreOutput {
	readonly target: string;
	readonly column: string;
	readonly threshold: number;
	readonly mean: number | null;
	readonly stddev: number | null;
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
		readonly low:  readonly { value: number; z: number }[];
		readonly high: readonly { value: number; z: number }[];
	};
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<OutliersZScoreInput, OutliersZScoreOutput> = {
	id: 'data.distribution.outliers-zscore.rdbms',
	name: 'Distribution: Z-score outliers (RDBMS)',
	description:
		'Z-score outlier detection on a numeric column. Computes mean + stddev server-side, derives the ' +
		'3-sigma (configurable) bounds, samples up to 50 values for examples + estimated outlier rate. ' +
		'Parametric: assumes near-normal data. Use the IQR variant for heavy-tailed columns.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			threshold:    { type: 'number', minimum: 0.5, maximum: 10, description: 'Z threshold; default 3.0.' },
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
			mean:                 { type: ['number', 'null'] },
			stddev:               { type: ['number', 'null'] },
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
							properties: { value: { type: 'number' }, z: { type: 'number' } },
							required: ['value', 'z'],
							additionalProperties: false,
						},
					},
					high: {
						type: 'array',
						items: {
							type: 'object',
							properties: { value: { type: 'number' }, z: { type: 'number' } },
							required: ['value', 'z'],
							additionalProperties: false,
						},
					},
				},
				required: ['low', 'high'],
				additionalProperties: false,
			},
		},
		required: ['target', 'column', 'threshold', 'mean', 'stddev',
		           'lowerBound', 'upperBound', 'min', 'max', 'count', 'nonNullCount',
		           'hasFullTableOutliers', 'sampleSize', 'sampleOutlierCount', 'sampleOutlierRate', 'examples'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_aggregate', 'db_sql_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate', 'db_sql_sample'],
			reason: 'aggregate gives mean / stddev; sample gives examples',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<OutliersZScoreOutput>> {
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
						{ column: col, function: 'avg' },
						{ column: col, function: 'stddev' },
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
				notes: ['outliers-zscore: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const v = aggData.values;
		const count = v[`${col}__count`] ?? null;
		const nonNullCount = v[`${col}__count_non_null`] ?? null;
		const min = v[`${col}__min`] ?? null;
		const max = v[`${col}__max`] ?? null;
		const mean = v[`${col}__avg`] ?? null;
		const stddev = v[`${col}__stddev`] ?? null;

		let lowerBound: number | null = null;
		let upperBound: number | null = null;
		let hasFullTableOutliers: boolean | null = null;
		if (mean !== null && stddev !== null && stddev > 0) {
			lowerBound = mean - threshold * stddev;
			upperBound = mean + threshold * stddev;
			if (min !== null && max !== null) {
				hasFullTableOutliers = min < lowerBound || max > upperBound;
			}
		}

		// Sample-based examples + estimated count.
		let sampleObserved = 0;
		let sampleOutlierCount = 0;
		const low: { value: number; z: number }[] = [];
		const high: { value: number; z: number }[] = [];
		if (sampleData.columns.includes(col)
		    && lowerBound !== null && upperBound !== null
		    && mean !== null && stddev !== null && stddev > 0) {
			for (const row of sampleData.rows) {
				const raw = row[col];
				if (raw === null || raw === undefined) continue;
				const num = typeof raw === 'number' ? raw : Number(raw);
				if (!Number.isFinite(num)) continue;
				sampleObserved++;
				const z = (num - mean) / stddev;
				if (num < lowerBound) {
					sampleOutlierCount++;
					if (low.length < 3) low.push({ value: num, z });
				} else if (num > upperBound) {
					sampleOutlierCount++;
					if (high.length < 3) high.push({ value: num, z });
				}
			}
		}
		const sampleOutlierRate = sampleObserved > 0 ? sampleOutlierCount / sampleObserved : null;

		return {
			value: {
				target: aggData.target,
				column: col,
				threshold,
				mean, stddev,
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
	if (typeof t !== 'number' || !Number.isFinite(t)) return 3.0;
	return Math.min(Math.max(0.5, t), 10);
}

function clampSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 50;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

function empty(target: string, column: string, threshold: number): OutliersZScoreOutput {
	return {
		target, column, threshold,
		mean: null, stddev: null,
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

export function registerDataDistributionOutliersZScoreRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
