/**
 * data.profile.text.rdbms -- Phase 5a.4 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper over `db_sql_aggregate`
 * (count + non-null + distinct) and `db_sql_sample` (rows for length
 * stats). Math + sample-based length computation in
 * `data.profile.text.algo`. The `.file` sibling shares the same
 * algo module.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult, SkillToolResult } from '../types.js';
import {
	type ProfileTextOutput,
	TEXT_PROFILE_OUTPUT_SCHEMA,
	buildTextProfile,
	clampTextSample,
	emptyTextProfile,
	isAggregateResult,
	isSampleResult,
	textAggregationsFor,
} from './data.profile.text.algo.js';

interface ProfileTextInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly sampleSize?: number;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<ProfileTextInput, ProfileTextOutput> = {
	id: 'data.profile.text.rdbms',
	name: 'Profile: text column (RDBMS)',
	description:
		'Server-side cardinality + null rate plus sample-based length statistics (min / max / avg / median) ' +
		'for one text column. Sample size capped at 50; default 50.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: TEXT_PROFILE_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_aggregate', 'db_sql_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate', 'db_sql_sample'],
			reason: 'aggregate gives counts; sample gives values for length stats',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only; file connections route through `data.profile.text.file`',
		},
	],

	async execute(input, deps): Promise<SkillResult<ProfileTextOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampTextSample(input.sampleSize);

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({
				id: `${callBase}-agg`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: textAggregationsFor(input.column),
				},
			}),
			deps.runTool({
				id: `${callBase}-sample`,
				name: 'db_sql_sample',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					limit: sampleSize,
				},
			}),
		]);

		const errors = collectToolErrors([['db_sql_aggregate', aggTool], ['db_sql_sample', sampleTool]]);
		if (errors.length > 0) {
			return { value: emptyTextProfile(input.target, input.column), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isAggregateResult(aggTool.data) || !isSampleResult(sampleTool.data)) {
			return {
				value: emptyTextProfile(input.target, input.column),
				confidence: 'low',
				notes: ['text profile: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const profile = buildTextProfile(
			aggTool.data.target,
			input.column,
			aggTool.data.values,
			{ columns: sampleTool.data.columns, rows: sampleTool.data.rows },
		);
		return {
			value: profile,
			confidence: (profile.nonNullCount ?? 0) > 0 && profile.sampleSize > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

function collectToolErrors(
	pairs: readonly (readonly [string, SkillToolResult])[],
): string[] {
	const out: string[] = [];
	for (const [name, res] of pairs) {
		if (res.isError) out.push(`${name} error: ${res.content.slice(0, 200)}`);
	}
	return out;
}

export function registerDataProfileTextRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
