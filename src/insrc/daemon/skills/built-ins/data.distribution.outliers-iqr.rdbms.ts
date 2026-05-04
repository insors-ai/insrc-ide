/**
 * data.distribution.outliers-iqr.rdbms -- Phase 5b.2 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper. Math + output schema in
 * `data.distribution.outliers-iqr.algo`; the `.file` sibling shares
 * the same algo module.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';
import {
	type OutliersIqrOutput,
	type OutliersSource,
	OUTLIERS_IQR_OUTPUT_SCHEMA,
	buildOutliersIqr,
	buildOutliersIqrFromOutlierTool,
	clampIqrMultiplier,
	clampSampleSize,
	collectToolErrors,
	emptyOutliersIqr,
	isAggregateResult,
	isSampleResult,
	outliersIqrAggregationsFor,
} from './data.distribution.outliers-iqr.algo.js';

interface OutliersIqrInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly k?: number;
	readonly sampleSize?: number;
	readonly mode?: OutliersSource;
}

interface OutlierToolResultRaw {
	readonly target: string;
	readonly column: string;
	readonly threshold: number;
	readonly nonNullCount: number;
	readonly lowerBound: number | null;
	readonly upperBound: number | null;
	readonly belowCount: number;
	readonly aboveCount: number;
	readonly center: number | null;
	readonly spread: number | null;
	readonly examples: readonly { value: number; side: 'below' | 'above' }[];
}

function isOutlierToolResult(v: unknown): v is OutlierToolResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['column'] === 'string'
		&& Array.isArray(o['examples']);
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
		'Tukey-IQR outlier detection on a numeric column. Q1/Q3/IQR bounds from server-side aggregate; ' +
		'examples + estimated outlier rate from a 50-row sample. Default k=1.5 (3.0 = "extreme").',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			k:            { type: 'number', minimum: 0.1, maximum: 10 },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
			mode:         { type: 'string', enum: ['sample', 'full-table'], description: 'Default sample. full-table delegates to db_sql_outliers for precise counts.' },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: OUTLIERS_IQR_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_aggregate', 'db_sql_sample', 'db_sql_outliers'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate', 'db_sql_sample', 'db_sql_outliers'],
			reason: 'sample mode: aggregate + sample. full-table mode: db_sql_outliers',
		},
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<OutliersIqrOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const k = clampIqrMultiplier(input.k);
		const sampleSize = clampSampleSize(input.sampleSize);

		if (input.mode === 'full-table') {
			const tool = await deps.runTool({
				id: `${callBase}-outliers`,
				name: 'db_sql_outliers',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					column: input.column,
					method: 'iqr',
					threshold: k,
				},
			});
			if (tool.isError) {
				return { value: emptyOutliersIqr(input.target, input.column, k), confidence: 'low', notes: [`db_sql_outliers error: ${tool.content.slice(0, 200)}`], toolCalls: [] };
			}
			if (!isOutlierToolResult(tool.data)) {
				return {
					value: emptyOutliersIqr(input.target, input.column, k),
					confidence: 'low',
					notes: ['db_sql_outliers returned a result without the expected structured data shape'],
					toolCalls: [],
				};
			}
			const out = buildOutliersIqrFromOutlierTool(tool.data);
			return {
				value: out,
				confidence: out.lowerBound !== null && out.upperBound !== null ? 'high' : 'medium',
				toolCalls: [],
			};
		}

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({
				id: `${callBase}-agg`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: outliersIqrAggregationsFor(input.column),
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
			return { value: emptyOutliersIqr(input.target, input.column, k), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isSampleResult(sampleTool.data)) {
			return {
				value: emptyOutliersIqr(input.target, input.column, k),
				confidence: 'low',
				notes: ['outliers-iqr: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const out = buildOutliersIqr(
			aggTool.data.target,
			input.column,
			k,
			aggTool.data.values,
			{ columns: sampleTool.data.columns, rows: sampleTool.data.rows },
		);
		return {
			value: out,
			confidence: out.lowerBound !== null && out.upperBound !== null && out.sampleSize > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

export function registerDataDistributionOutliersIqrRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
