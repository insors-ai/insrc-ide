/**
 * data.distribution.outliers-iqr.rdbms -- Phase 5b.2 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: Tukey-IQR outlier detection on one numeric RDBMS
 * column. A value `x` is flagged when `x < Q1 - k*IQR` or
 * `x > Q3 + k*IQR`, where IQR = Q3 - Q1 and the multiplier `k`
 * defaults to 1.5 (3.0 selects "extreme" outliers).
 *
 * Server-side path: `db_sql_aggregate` gives count + non-null +
 * min + max + p25 + p50 + p75 in one round-trip. The IQR bounds
 * are computed in the daemon from those values.
 *
 * Sample-based path: a separate `db_sql_sample` pulls up to 50
 * values; we partition into matched / unmatched against the
 * bounds and surface up to 3 low + 3 high examples. The
 * sample-derived outlier count + rate is **an estimate**, not the
 * full-table figure -- precise outlier counting needs a
 * `count_where` aggregate function that doesn't exist yet.
 * Documented in the output via a clear `sampleOutlierCount` vs
 * `sampleOutlierRate` naming.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult, SkillToolResult } from '../types.js';

interface OutliersIqrInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	/** IQR multiplier. 1.5 = standard "outlier"; 3.0 = "extreme outlier". */
	readonly k?: number;
	readonly sampleSize?: number;
}

interface OutliersIqrOutput {
	readonly target: string;
	readonly column: string;
	readonly k: number;
	readonly q1: number | null;
	readonly q3: number | null;
	readonly iqr: number | null;
	readonly lowerBound: number | null;
	readonly upperBound: number | null;
	readonly min: number | null;
	readonly max: number | null;
	readonly count: number | null;
	readonly nonNullCount: number | null;
	/** True when the column's min / max alone indicate at least one
	 *  outlier exists in the full table. Independent of the sample. */
	readonly hasFullTableOutliers: boolean | null;
	readonly sampleSize: number;
	readonly sampleOutlierCount: number;
	readonly sampleOutlierRate: number | null;
	readonly examples: {
		readonly low:  readonly number[];
		readonly high: readonly number[];
	};
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<OutliersIqrInput, OutliersIqrOutput> = {
	id: 'data.distribution.outliers-iqr.rdbms',
	name: 'Distribution: Tukey-IQR outliers (RDBMS)',
	description:
		'Tukey-IQR outlier detection on a numeric column. Computes Q1, Q3, IQR, and the lower/upper bounds ' +
		'(default k=1.5). Reports whether the column\'s min/max indicate full-table outliers and includes ' +
		'up to 3 low + 3 high examples from a 50-row sample. Sample-derived outlier counts are estimates; ' +
		'precise full-table counts require a count_where aggregate not yet shipped.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			k:            { type: 'number', minimum: 0.1, maximum: 10, description: 'IQR multiplier; default 1.5.' },
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
			k:                    { type: 'number' },
			q1:                   { type: ['number', 'null'] },
			q3:                   { type: ['number', 'null'] },
			iqr:                  { type: ['number', 'null'] },
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
					low:  { type: 'array', items: { type: 'number' } },
					high: { type: 'array', items: { type: 'number' } },
				},
				required: ['low', 'high'],
				additionalProperties: false,
			},
		},
		required: ['target', 'column', 'k', 'q1', 'q3', 'iqr', 'lowerBound', 'upperBound',
		           'min', 'max', 'count', 'nonNullCount', 'hasFullTableOutliers',
		           'sampleSize', 'sampleOutlierCount', 'sampleOutlierRate', 'examples'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_aggregate', 'db_sql_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate', 'db_sql_sample'],
			reason: 'aggregate gives the percentile bounds; sample gives examples of outlier values',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<OutliersIqrOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const k = clampMultiplier(input.k);
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
						{ column: col, function: 'percentile', args: { p: 0.25 } },
						{ column: col, function: 'percentile', args: { p: 0.75 } },
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
				value: empty(input.target, col, k),
				confidence: 'low',
				notes: errors,
				toolCalls: [],
			};
		}

		const aggData = aggTool.data;
		const sampleData = sampleTool.data;
		if (!isAggregateResult(aggData) || !isSampleResult(sampleData)) {
			return {
				value: empty(input.target, col, k),
				confidence: 'low',
				notes: ['outliers-iqr: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const v = aggData.values;
		const count = v[`${col}__count`] ?? null;
		const nonNullCount = v[`${col}__count_non_null`] ?? null;
		const min = v[`${col}__min`] ?? null;
		const max = v[`${col}__max`] ?? null;
		const q1  = v[`${col}__percentile_0_25`] ?? null;
		const q3  = v[`${col}__percentile_0_75`] ?? null;

		let iqr: number | null = null;
		let lowerBound: number | null = null;
		let upperBound: number | null = null;
		let hasFullTableOutliers: boolean | null = null;
		if (q1 !== null && q3 !== null) {
			iqr = q3 - q1;
			lowerBound = q1 - k * iqr;
			upperBound = q3 + k * iqr;
			if (min !== null && max !== null) {
				hasFullTableOutliers = min < lowerBound || max > upperBound;
			}
		}

		// Sample-based examples + estimated count.
		let sampleObserved = 0;
		let sampleOutlierCount = 0;
		const low: number[] = [];
		const high: number[] = [];
		if (sampleData.columns.includes(col) && lowerBound !== null && upperBound !== null) {
			for (const row of sampleData.rows) {
				const raw = row[col];
				if (raw === null || raw === undefined) continue;
				const num = typeof raw === 'number' ? raw : Number(raw);
				if (!Number.isFinite(num)) continue;
				sampleObserved++;
				if (num < lowerBound) {
					sampleOutlierCount++;
					if (low.length < 3) low.push(num);
				} else if (num > upperBound) {
					sampleOutlierCount++;
					if (high.length < 3) high.push(num);
				}
			}
		}
		const sampleOutlierRate = sampleObserved > 0 ? sampleOutlierCount / sampleObserved : null;

		return {
			value: {
				target: aggData.target,
				column: col,
				k, q1, q3, iqr,
				lowerBound, upperBound,
				min, max,
				count, nonNullCount,
				hasFullTableOutliers,
				sampleSize: sampleObserved,
				sampleOutlierCount,
				sampleOutlierRate,
				examples: { low, high },
			},
			// `high` when bounds were computed and we have a non-empty
			// observed sample. `medium` when the bounds came back null
			// (column may be empty or non-numeric) or the sample was
			// empty for that column. `low` only on tool errors.
			confidence: lowerBound !== null && upperBound !== null && sampleObserved > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

function clampMultiplier(k: number | undefined): number {
	if (typeof k !== 'number' || !Number.isFinite(k)) return 1.5;
	return Math.min(Math.max(0.1, k), 10);
}

function clampSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 50;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

function empty(target: string, column: string, k: number): OutliersIqrOutput {
	return {
		target, column, k,
		q1: null, q3: null, iqr: null,
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

export function registerDataDistributionOutliersIqrRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
