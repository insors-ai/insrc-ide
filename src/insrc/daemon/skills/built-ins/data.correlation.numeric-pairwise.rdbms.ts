/**
 * data.correlation.numeric-pairwise.rdbms -- Phase 5c.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper over the shared correlation algo.
 * The `.file` sibling shares the algo module.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import {
	type CorrelationOutput,
	CORRELATION_MAX_COLUMNS,
	CORRELATION_OUTPUT_SCHEMA,
	buildCorrelationFromMatrix,
	buildCorrelationOutput,
	clampCorrelationSample,
	emptyCorrelationOutput,
	isCorrelationSampleResult,
	isDescribeResult,
	pickNumericColumns,
} from './data.correlation.numeric-pairwise.algo.js';

interface CorrelationInput {
	readonly connectionId: string;
	readonly target: string;
	readonly columns?: readonly string[];
	readonly sampleSize?: number;
	readonly mode?: 'sample' | 'full-table';
}

interface CorrelationMatrixToolResult {
	readonly target: string;
	readonly columns: readonly string[];
	readonly method: 'pearson' | 'spearman';
	readonly nonNullCount: number;
	readonly matrix: readonly (readonly (number | null)[])[];
}

function isCorrelationMatrixToolResult(v: unknown): v is CorrelationMatrixToolResult {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& Array.isArray(o['columns'])
		&& Array.isArray(o['matrix']);
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<CorrelationInput, CorrelationOutput> = {
	id: 'data.correlation.numeric-pairwise.rdbms',
	name: 'Correlation: numeric pairwise (RDBMS)',
	description: 'Pairwise Pearson + Spearman correlation across numeric columns over a 50-row sample. Cap 15 columns / 105 unordered pairs.',
	family: 'dependency',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			columns:      { type: 'array', items: { type: 'string' } },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
			mode:         { type: 'string', enum: ['sample', 'full-table'], description: 'Default sample. full-table delegates to db_sql_correlation_matrix (one call per method).' },
		},
		required: ['connectionId', 'target'],
		additionalProperties: false,
	},
	outputs: CORRELATION_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_describe', 'db_sql_sample', 'db_sql_correlation_matrix'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_describe', 'db_sql_sample', 'db_sql_correlation_matrix'], reason: 'sample mode: describe + sample. full-table mode: db_sql_correlation_matrix' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<CorrelationOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampCorrelationSample(input.sampleSize);

		const colsOrErr = await resolveColumns(input, deps, callBase);
		if (typeof colsOrErr === 'string') {
			return { value: emptyCorrelationOutput(input.target), confidence: 'low', notes: [colsOrErr], toolCalls: [] };
		}
		const allCols = colsOrErr;
		const truncatedColumns = allCols.length > CORRELATION_MAX_COLUMNS;
		const evaluatedColumns = allCols.slice(0, CORRELATION_MAX_COLUMNS);
		if (evaluatedColumns.length < 2) {
			return {
				value: { ...emptyCorrelationOutput(input.target), evaluatedColumns, interpretation: `need >= 2 numeric columns to compute pairwise correlations; found ${evaluatedColumns.length}` },
				confidence: 'medium',
				toolCalls: [],
			};
		}

		if (input.mode === 'full-table') {
			// Cap at 10 columns for the correlation_matrix tool.
			const matrixCols = evaluatedColumns.slice(0, 10);
			const truncatedHere = evaluatedColumns.length > 10 || truncatedColumns;
			const [pearsonRes, spearmanRes] = await Promise.all([
				deps.runTool({
					id: `${callBase}-corr-pearson`,
					name: 'db_sql_correlation_matrix',
					input: { connectionId: input.connectionId, target: input.target, columns: matrixCols, method: 'pearson' },
				}),
				deps.runTool({
					id: `${callBase}-corr-spearman`,
					name: 'db_sql_correlation_matrix',
					input: { connectionId: input.connectionId, target: input.target, columns: matrixCols, method: 'spearman' },
				}),
			]);
			if (pearsonRes.isError) {
				return { value: emptyCorrelationOutput(input.target), confidence: 'low', notes: [`db_sql_correlation_matrix(pearson) error: ${pearsonRes.content.slice(0, 200)}`], toolCalls: [] };
			}
			if (!isCorrelationMatrixToolResult(pearsonRes.data)) {
				return { value: emptyCorrelationOutput(input.target), confidence: 'low', notes: ['db_sql_correlation_matrix(pearson) returned a result without the expected structured data shape'], toolCalls: [] };
			}
			const spearmanMatrix = !spearmanRes.isError && isCorrelationMatrixToolResult(spearmanRes.data)
				? spearmanRes.data.matrix
				: null;
			const out = buildCorrelationFromMatrix(
				pearsonRes.data.target,
				matrixCols,
				truncatedHere,
				pearsonRes.data.nonNullCount,
				pearsonRes.data.matrix,
				spearmanMatrix,
			);
			return { value: out, confidence: 'high', toolCalls: [] };
		}

		const sampleTool = await deps.runTool({
			id: `${callBase}-sample`,
			name: 'db_sql_sample',
			input: { connectionId: input.connectionId, target: input.target, limit: sampleSize },
		});
		if (sampleTool.isError) {
			return { value: emptyCorrelationOutput(input.target), confidence: 'low', notes: [`db_sql_sample error: ${sampleTool.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isCorrelationSampleResult(sampleTool.data)) {
			return {
				value: emptyCorrelationOutput(input.target),
				confidence: 'low',
				notes: ['db_sql_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}
		return {
			value: buildCorrelationOutput(sampleTool.data.target, evaluatedColumns, truncatedColumns, sampleTool.data.rows),
			confidence: 'high',
			toolCalls: [],
		};
	},
};

async function resolveColumns(input: CorrelationInput, deps: SkillDeps, callBase: string): Promise<readonly string[] | string> {
	if (input.columns !== undefined && input.columns.length > 0) return input.columns;
	const describe = await deps.runTool({
		id: `${callBase}-desc`,
		name: 'db_sql_describe',
		input: { connectionId: input.connectionId, target: input.target },
	});
	if (describe.isError) return `db_sql_describe error: ${describe.content.slice(0, 200)}`;
	if (!isDescribeResult(describe.data)) {
		return 'db_sql_describe returned a result without the expected structured data shape';
	}
	const numeric = pickNumericColumns(describe.data.columns);
	if (numeric.length === 0) return `target '${input.target}' has no numeric columns`;
	return numeric;
}

export function registerDataCorrelationNumericPairwiseRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
