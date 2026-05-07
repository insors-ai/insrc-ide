/**
 * data.distribution.histogram.rdbms -- Phase 5b.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin RDBMS wrapper around `db_sql_histogram`.
 * The histogram math is entirely server-side (Phase 0.2 tool); this
 * skill normalises the tool result into a typed output and stamps
 * a top-level verdict.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';
import {
	type HistogramMode,
	type HistogramOutput,
	HISTOGRAM_DEFAULT_BUCKETS,
	HISTOGRAM_OUTPUT_SCHEMA,
	buildHistogramOutput,
	clampBuckets,
	emptyHistogram,
	isHistogramToolResult,
	normalizeMode,
} from './data.distribution.histogram.algo.js';

interface HistogramRdbmsInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly buckets?: number;
	readonly mode?: HistogramMode;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<HistogramRdbmsInput, HistogramOutput> = {
	id: 'data.distribution.histogram.rdbms',
	name: 'Distribution: histogram (RDBMS)',
	description:
		'Server-side histogram on a numeric RDBMS column. Equal-width uses min/max bounds + FLOOR arithmetic ' +
		'(every dialect); equal-frequency uses NTILE() OVER (ORDER BY col) (Postgres / DuckDB / SQLite>=3.25 / ' +
		'MySQL>=8 / MSSQL / Oracle). Default 20 buckets, capped at 200.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			buckets:      { type: 'integer', minimum: 2, maximum: 200 },
			mode:         { type: 'string', enum: ['equal-width', 'equal-frequency'] },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: HISTOGRAM_OUTPUT_SCHEMA,
	toolDeps: ['db_sql_histogram'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_histogram'],
			reason: 'sole tool that computes server-side histograms on RDBMS connections',
		},
		{ kind: 'connection-family', families: RDBMS_FAMILY_TAGS, reason: 'RDBMS-only' },
	],

	async execute(input, deps): Promise<SkillResult<HistogramOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const buckets = clampBuckets(input.buckets);
		const mode = normalizeMode(input.mode);

		const tool = await deps.runTool({
			id: callId,
			name: 'db_sql_histogram',
			input: {
				connectionId: input.connectionId,
				target:       input.target,
				column:       input.column,
				buckets,
				mode,
			},
		});

		if (tool.isError) {
			return {
				value: emptyHistogram(input.target, input.column, mode, buckets),
				confidence: 'low',
				notes: [`db_sql_histogram error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		if (!isHistogramToolResult(tool.data)) {
			return {
				value: emptyHistogram(input.target, input.column, mode, buckets),
				confidence: 'low',
				notes: ['db_sql_histogram returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const out = buildHistogramOutput(tool.data, buckets);
		return {
			value: out,
			confidence: out.verdict === 'has-data' ? 'high' : out.verdict === 'empty' ? 'medium' : 'low',
			toolCalls: [],
		};
	},
};

export function registerDataDistributionHistogramRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
