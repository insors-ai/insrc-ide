/**
 * data.dependency.co-null-pattern.file -- Phase 5c.4 of
 * plans/analyzers/data-analyzer-skills.md (file-side variant).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import {
	type CoNullOutput,
	CO_NULL_COL_CAP,
	CO_NULL_OUTPUT_SCHEMA,
	buildCoNullOutput,
	clampCoNullSample,
	emptyCoNullOutput,
} from './data.dependency.co-null-pattern.algo.js';
import {
	isCorrelationSampleResult,
	isDescribeResult,
} from './data.correlation.numeric-pairwise.algo.js';

interface CoNullFileInput {
	readonly connectionId: string;
	readonly columns?: readonly string[];
	readonly target?: string;
	readonly sampleSize?: number;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<CoNullFileInput, CoNullOutput> = {
	id: 'data.dependency.co-null-pattern.file',
	name: 'Dependency: pairwise null co-occurrence (file)',
	description: 'Pairwise null co-occurrence over a sample of a file connection. Same shape as the RDBMS variant.',
	family: 'dependency',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			columns:      { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 15 },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId'],
		additionalProperties: false,
	},
	outputs: CO_NULL_OUTPUT_SCHEMA,
	toolDeps: ['db_file_describe', 'db_file_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_describe', 'db_file_sample'], reason: 'describe gives the column list; sample gives the rows we partition by null pattern' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<CoNullOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampCoNullSample(input.sampleSize);
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;
		const notes: string[] = [];

		const cols = await resolveColumns(input, deps, callBase, sheet);
		if (typeof cols === 'string') {
			return { value: emptyCoNullOutput(input.target ?? ''), confidence: 'low', notes: [cols], toolCalls: [] };
		}
		if (cols.length < 2) {
			return {
				value: { target: input.target ?? '', sampleSize: 0, columns: cols, pairs: [], truncated: false },
				confidence: 'medium',
				notes: ['co-null-pattern needs at least 2 columns; nothing to compare'],
				toolCalls: [],
			};
		}

		const truncated = cols.length > CO_NULL_COL_CAP;
		const usedCols = truncated ? cols.slice(0, CO_NULL_COL_CAP) : cols;
		if (truncated) {
			notes.push(`co-null-pattern truncated: ${cols.length} columns -> profiling first ${CO_NULL_COL_CAP}.`);
		}

		const sampleInput: Record<string, unknown> = { connectionId: input.connectionId, limit: sampleSize };
		if (sheet !== undefined) sampleInput['target'] = sheet;
		const sampleResult = await deps.runTool({ id: `${callBase}-sample`, name: 'db_file_sample', input: sampleInput });
		if (sampleResult.isError) {
			return { value: emptyCoNullOutput(input.target ?? ''), confidence: 'low', notes: [...notes, `db_file_sample error: ${sampleResult.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isCorrelationSampleResult(sampleResult.data)) {
			return {
				value: emptyCoNullOutput(input.target ?? ''),
				confidence: 'low',
				notes: [...notes, 'db_file_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const built = buildCoNullOutput(sampleResult.data.target, usedCols, sampleResult.data.rows, sampleResult.data.columns, truncated);
		const allNotes = [...notes, ...built.notes];
		return {
			value: built.output,
			confidence: built.anyNull ? 'high' : 'medium',
			...(allNotes.length > 0 ? { notes: allNotes } : {}),
			toolCalls: [],
		};
	},
};

async function resolveColumns(input: CoNullFileInput, deps: SkillDeps, callBase: string, sheet: string | undefined): Promise<readonly string[] | string> {
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

export function registerDataDependencyCoNullPatternFileSkill(): void {
	registerSkill(skill as unknown as Skill);
}
