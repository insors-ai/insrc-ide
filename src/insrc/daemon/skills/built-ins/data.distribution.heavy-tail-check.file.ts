/**
 * data.distribution.heavy-tail-check.file -- Phase 5b.6 of
 * plans/analyzers/data-analyzer-skills.md (file-side variant).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';
import {
	type HeavyTailOutput,
	HEAVY_TAIL_OUTPUT_SCHEMA,
	HEAVY_TAIL_SAMPLE_SIZE,
	buildHeavyTailCheck,
	clampHeavyTailThreshold,
	emptyHeavyTailCheck,
	heavyTailAggregationsFor,
} from './data.distribution.heavy-tail-check.algo.js';
import {
	collectToolErrors,
	isAggregateResult,
	isSampleResult,
} from './data.distribution.outliers-iqr.algo.js';

interface HeavyTailFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly target?: string;
	readonly threshold?: number;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<HeavyTailFileInput, HeavyTailOutput> = {
	id: 'data.distribution.heavy-tail-check.file',
	name: 'Distribution: heavy-tail check (file)',
	description: 'Binary verdict on tail heaviness from sample kurtosis. Same shape as the RDBMS variant.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			column:       { type: 'string' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			threshold:    { type: 'number', minimum: 0.1, maximum: 10 },
		},
		required: ['connectionId', 'column'],
		additionalProperties: false,
	},
	outputs: HEAVY_TAIL_OUTPUT_SCHEMA,
	toolDeps: ['db_file_aggregate', 'db_file_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_aggregate', 'db_file_sample'], reason: 'aggregate gives mean/stddev; sample gives values for kurtosis' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<HeavyTailOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const threshold = clampHeavyTailThreshold(input.threshold);
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		const aggInput: Record<string, unknown> = { connectionId: input.connectionId, aggregations: heavyTailAggregationsFor(input.column) };
		if (sheet !== undefined) aggInput['path'] = sheet;
		const sampleInput: Record<string, unknown> = { connectionId: input.connectionId, limit: HEAVY_TAIL_SAMPLE_SIZE };
		if (sheet !== undefined) sampleInput['target'] = sheet;

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({ id: `${callBase}-agg`,    name: 'db_file_aggregate', input: aggInput }),
			deps.runTool({ id: `${callBase}-sample`, name: 'db_file_sample',    input: sampleInput }),
		]);

		const errors = collectToolErrors([['db_file_aggregate', aggTool], ['db_file_sample', sampleTool]]);
		if (errors.length > 0) {
			return { value: emptyHeavyTailCheck(input.target ?? '', input.column, threshold), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isSampleResult(sampleTool.data)) {
			return {
				value: emptyHeavyTailCheck(input.target ?? '', input.column, threshold),
				confidence: 'low',
				notes: ['heavy-tail-check: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const out = buildHeavyTailCheck(
			aggTool.data.target,
			input.column,
			threshold,
			aggTool.data.values,
			{ columns: sampleTool.data.columns, rows: sampleTool.data.rows },
		);
		return {
			value: out,
			confidence: out.verdict === 'inconclusive' ? 'medium' : 'high',
			toolCalls: [],
		};
	},
};

export function registerDataDistributionHeavyTailCheckFileSkill(): void {
	registerSkill(skill as unknown as Skill);
}
