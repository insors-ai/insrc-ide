/**
 * data.distribution.outliers-iqr.file -- Phase 5b.2 of
 * plans/analyzers/data-analyzer-skills.md (file-side variant).
 *
 * Mirrors `data.distribution.outliers-iqr.rdbms`; same algo module.
 * Calls `db_file_aggregate` + `db_file_sample`. xlsx sheet selection
 * via the optional `target` field (mapped to the file-tool's `path`
 * for aggregate, kept as `target` for sample -- tool-surface naming
 * inconsistency tracked in plan "Open cleanup work" §1).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';
import {
	type OutliersIqrOutput,
	OUTLIERS_IQR_OUTPUT_SCHEMA,
	buildOutliersIqr,
	clampIqrMultiplier,
	clampSampleSize,
	collectToolErrors,
	emptyOutliersIqr,
	isAggregateResult,
	isSampleResult,
	outliersIqrAggregationsFor,
} from './data.distribution.outliers-iqr.algo.js';

interface OutliersIqrFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly target?: string;
	readonly k?: number;
	readonly sampleSize?: number;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<OutliersIqrFileInput, OutliersIqrOutput> = {
	id: 'data.distribution.outliers-iqr.file',
	name: 'Distribution: Tukey-IQR outliers (file)',
	description:
		'Tukey-IQR outlier detection on a numeric column from a file connection. Same shape + math as the ' +
		'RDBMS variant; bounds via `db_file_aggregate`, examples via `db_file_sample`. Default k=1.5.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			column:       { type: 'string' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			k:            { type: 'number', minimum: 0.1, maximum: 10 },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId', 'column'],
		additionalProperties: false,
	},
	outputs: OUTLIERS_IQR_OUTPUT_SCHEMA,
	toolDeps: ['db_file_aggregate', 'db_file_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_file_aggregate', 'db_file_sample'],
			reason: 'aggregate gives bounds; sample gives outlier examples',
		},
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<OutliersIqrOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const k = clampIqrMultiplier(input.k);
		const sampleSize = clampSampleSize(input.sampleSize);
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		const aggInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			aggregations: outliersIqrAggregationsFor(input.column),
		};
		if (sheet !== undefined) aggInput['path'] = sheet;
		const sampleInput: Record<string, unknown> = { connectionId: input.connectionId, limit: sampleSize };
		if (sheet !== undefined) sampleInput['target'] = sheet;

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({ id: `${callBase}-agg`,    name: 'db_file_aggregate', input: aggInput }),
			deps.runTool({ id: `${callBase}-sample`, name: 'db_file_sample',    input: sampleInput }),
		]);

		const errors = collectToolErrors([['db_file_aggregate', aggTool], ['db_file_sample', sampleTool]]);
		if (errors.length > 0) {
			return { value: emptyOutliersIqr(input.target ?? '', input.column, k), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isSampleResult(sampleTool.data)) {
			return {
				value: emptyOutliersIqr(input.target ?? '', input.column, k),
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

export function registerDataDistributionOutliersIqrFileSkill(): void {
	registerSkill(skill as unknown as Skill);
}
