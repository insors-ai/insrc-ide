/**
 * data.dependency.co-null-pattern.rdbms -- Phase 5c.4 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper over the shared co-null algo.
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

interface CoNullInput {
	readonly connectionId: string;
	readonly target: string;
	readonly columns?: readonly string[];
	readonly sampleSize?: number;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<CoNullInput, CoNullOutput> = {
	id: 'data.dependency.co-null-pattern.rdbms',
	name: 'Dependency: pairwise null co-occurrence (RDBMS)',
	description: 'Pairwise null co-occurrence analysis over a 50-row sample. Cap: 15 columns / 105 pairs per call.',
	family: 'dependency',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			columns:      { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 15 },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId', 'target'],
		additionalProperties: false,
	},
	outputs: CO_NULL_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_describe', 'db_sql_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_sql_describe', 'db_sql_sample'], reason: 'describe gives the column list; sample gives the rows we partition by null pattern' },
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<CoNullOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampCoNullSample(input.sampleSize);
		const notes: string[] = [];

		const cols = await resolveColumns(input, deps, callBase);
		if (typeof cols === 'string') {
			return { value: emptyCoNullOutput(input.target), confidence: 'low', notes: [cols], toolCalls: [] };
		}
		if (cols.length < 2) {
			return {
				value: { target: input.target, sampleSize: 0, columns: cols, pairs: [], truncated: false },
				confidence: 'medium',
				notes: ['co-null-pattern needs at least 2 columns; nothing to compare'],
				toolCalls: [],
			};
		}

		const truncated = cols.length > CO_NULL_COL_CAP;
		const usedCols = truncated ? cols.slice(0, CO_NULL_COL_CAP) : cols;
		if (truncated) {
			notes.push(`co-null-pattern truncated: ${cols.length} columns -> profiling first ${CO_NULL_COL_CAP}. Pass explicit \`columns\` to profile a different slice.`);
		}

		const sampleResult = await deps.runTool({
			id: `${callBase}-sample`,
			name: 'db_sql_sample',
			input: { connectionId: input.connectionId, target: input.target, limit: sampleSize },
		});
		if (sampleResult.isError) {
			return { value: emptyCoNullOutput(input.target), confidence: 'low', notes: [...notes, `db_sql_sample error: ${sampleResult.content.slice(0, 200)}`], toolCalls: [] };
		}
		if (!isCorrelationSampleResult(sampleResult.data)) {
			return {
				value: emptyCoNullOutput(input.target),
				confidence: 'low',
				notes: [...notes, 'db_sql_sample returned a result without the expected structured data shape'],
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

async function resolveColumns(input: CoNullInput, deps: SkillDeps, callBase: string): Promise<readonly string[] | string> {
	if (input.columns !== undefined && input.columns.length > 0) return input.columns;
	const describe = await deps.runTool({
		id: `${callBase}-desc`,
		name: 'db_sql_describe',
		input: { connectionId: input.connectionId, target: input.target },
	});
	if (describe.isError) return `db_sql_describe error: ${describe.content.slice(0, 200)}`;
	if (!isDescribeResult(describe.data)) return 'db_sql_describe returned a result without the expected structured data shape';
	const cols = describe.data.columns
		.map(c => c.name)
		.filter(n => typeof n === 'string' && n.length > 0);
	if (cols.length === 0) return `target '${input.target}' has no columns`;
	return cols;
}

export function registerDataDependencyCoNullPatternRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
