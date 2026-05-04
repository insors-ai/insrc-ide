/**
 * data.quality.uniqueness.file -- Phase 5d.2 (file-side variant).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import {
	type QualityUniquenessOutput,
	UNIQUENESS_COL_CAP,
	UNIQUENESS_OUTPUT_SCHEMA,
	buildUniqueness,
	emptyUniqueness,
	uniquenessAggregationsFor,
} from './data.quality.uniqueness.algo.js';
import { isAggregateResult } from './data.quality.completeness.algo.js';
import { isDescribeResult } from './data.correlation.numeric-pairwise.algo.js';

interface QualityUniquenessFileInput {
	readonly connectionId: string;
	readonly columns?: readonly string[];
	readonly target?: string;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<QualityUniquenessFileInput, QualityUniquenessOutput> = {
	id: 'data.quality.uniqueness.file',
	name: 'Quality: uniqueness (file)',
	description: 'Per-column uniqueness ratio + PK candidate detection for a file connection.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			columns:      { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 15 },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
		},
		required: ['connectionId'],
		additionalProperties: false,
	},
	outputs: UNIQUENESS_OUTPUT_SCHEMA,
	toolDeps: ['db_file_describe', 'db_file_aggregate'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_describe', 'db_file_aggregate'], reason: 'describe gives column list; aggregate gives counts' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<QualityUniquenessOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const notes: string[] = [];
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		const cols = await resolveColumns(input, deps, callBase, sheet);
		if (typeof cols === 'string') {
			return { value: emptyUniqueness(input.target ?? ''), confidence: 'low', notes: [cols], toolCalls: [] };
		}
		const truncated = cols.length > UNIQUENESS_COL_CAP;
		const usedCols = truncated ? cols.slice(0, UNIQUENESS_COL_CAP) : cols;
		if (truncated) notes.push(`uniqueness truncated: ${cols.length} columns -> profiling first ${UNIQUENESS_COL_CAP}.`);

		const aggInput: Record<string, unknown> = { connectionId: input.connectionId, aggregations: uniquenessAggregationsFor(usedCols) };
		if (sheet !== undefined) aggInput['path'] = sheet;
		const aggResult = await deps.runTool({ id: `${callBase}-agg`, name: 'db_file_aggregate', input: aggInput });
		if (aggResult.isError) {
			return { value: emptyUniqueness(input.target ?? ''), confidence: 'low', notes: [...notes, `db_file_aggregate error: ${aggResult.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isAggregateResult(aggResult.data)) {
			return {
				value: emptyUniqueness(input.target ?? ''),
				confidence: 'low',
				notes: [...notes, 'db_file_aggregate returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const out = buildUniqueness(aggResult.data.target, usedCols, truncated, aggResult.data.values);
		return {
			value: out,
			confidence: out.totalRows !== null && out.totalRows > 0 ? 'high' : 'medium',
			...(notes.length > 0 ? { notes } : {}),
			toolCalls: [],
		};
	},
};

async function resolveColumns(input: QualityUniquenessFileInput, deps: SkillDeps, callBase: string, sheet: string | undefined): Promise<readonly string[] | string> {
	if (input.columns !== undefined && input.columns.length > 0) return input.columns;
	const describeInput: Record<string, unknown> = { connectionId: input.connectionId };
	if (sheet !== undefined) describeInput['target'] = sheet;
	const describe = await deps.runTool({ id: `${callBase}-desc`, name: 'db_file_describe', input: describeInput });
	if (describe.isError) return `db_file_describe error: ${describe.content.slice(0, 200)}`;
	if (!isDescribeResult(describe.data)) return 'db_file_describe returned a result without the expected structured data shape';
	const cols = describe.data.columns.map(c => c.name).filter(n => typeof n === 'string' && n.length > 0);
	if (cols.length === 0) return `connection '${input.connectionId}' has no columns`;
	return cols;
}

export function registerDataQualityUniquenessFileSkill(): void {
	registerSkill(skill as unknown as Skill);
}
