/**
 * data.profile.text.rdbms -- Phase 5a.4 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: profiles a text RDBMS column. Combines a server-
 * side cardinality + null check (`db_sql_aggregate`) with sample-
 * based length statistics (`db_sql_sample` -> compute lengths in
 * the daemon).
 *
 * Sample-vs-server tradeoff. The current `db_sql_aggregate` tool
 * doesn't expose `LENGTH()` -- a future text-aware aggregation
 * surface (`db_sql_text_aggregate` or a typed extension) would let
 * us push min/max/avg length server-side. Until then a 50-row
 * sample is the honest path; the skill returns the actual sample
 * size in its output and confidence calibration accounts for it.
 *
 * The plan also calls for "encoding" + "regex pattern inference".
 * Encoding detection is deferred (every modern stack stores text
 * as UTF-8; meaningful encoding analysis would require byte-level
 * inspection the driver doesn't surface). Regex pattern inference
 * overlaps with `pii.detect-patterns.rdbms` (which already
 * regex-matches over a sample); a generalized text pattern
 * inferrer would be its own skill, not bundled here.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult, SkillToolResult } from '../types.js';

interface ProfileTextInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly sampleSize?: number;
}

interface LengthStats {
	readonly min: number | null;
	readonly max: number | null;
	readonly avg: number | null;
	readonly median: number | null;
}

interface ProfileTextOutput {
	readonly target: string;
	readonly column: string;
	readonly count: number | null;
	readonly nonNullCount: number | null;
	readonly nullCount: number | null;
	readonly distinctCount: number | null;
	readonly emptyCount: number | null;
	readonly sampleSize: number;
	readonly length: LengthStats;
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
		'for one text column. Sample size capped at 50 by the underlying tool; default 50. Encoding + regex ' +
		'pattern inference are separate skills (encoding deferred; pattern inference covered by ' +
		'`pii.detect-patterns.rdbms`).',
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
	outputs: {
		type: 'object',
		properties: {
			target:        { type: 'string' },
			column:        { type: 'string' },
			count:         { type: ['number', 'null'] },
			nonNullCount:  { type: ['number', 'null'] },
			nullCount:     { type: ['number', 'null'] },
			distinctCount: { type: ['number', 'null'] },
			emptyCount:    { type: ['number', 'null'] },
			sampleSize:    { type: 'number' },
			length: {
				type: 'object',
				properties: {
					min:    { type: ['number', 'null'] },
					max:    { type: ['number', 'null'] },
					avg:    { type: ['number', 'null'] },
					median: { type: ['number', 'null'] },
				},
				required: ['min', 'max', 'avg', 'median'],
				additionalProperties: false,
			},
		},
		required: ['target', 'column', 'count', 'nonNullCount', 'nullCount', 'distinctCount',
		           'emptyCount', 'sampleSize', 'length'],
		additionalProperties: false,
	},
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
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<ProfileTextOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampSample(input.sampleSize);

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({
				id: `${callBase}-agg`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: [
						{ column: input.column, function: 'count' },
						{ column: input.column, function: 'count_non_null' },
						{ column: input.column, function: 'distinct_count' },
					],
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
			return {
				value: empty(input.target, input.column),
				confidence: 'low',
				notes: errors,
				toolCalls: [],
			};
		}

		const aggData = aggTool.data;
		const sampleData = sampleTool.data;
		if (!isAggregateResult(aggData) || !isSampleResult(sampleData)) {
			return {
				value: empty(input.target, input.column),
				confidence: 'low',
				notes: ['text profile: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const col = input.column;
		const count = aggData.values[`${col}__count`] ?? null;
		const nonNullCount = aggData.values[`${col}__count_non_null`] ?? null;
		const nullCount = (count !== null && nonNullCount !== null) ? count - nonNullCount : null;
		const distinctCount = aggData.values[`${col}__distinct_count`] ?? null;

		// Length stats over the sample.
		let emptyCount = 0;
		const lengths: number[] = [];
		const present = sampleData.columns.includes(col);
		if (present) {
			for (const row of sampleData.rows) {
				const v = row[col];
				if (v === null || v === undefined) continue;
				const s = typeof v === 'string' ? v : String(v);
				if (s.length === 0) emptyCount++;
				lengths.push(s.length);
			}
		}
		const length = computeLengthStats(lengths);

		return {
			value: {
				target: aggData.target,
				column: input.column,
				count,
				nonNullCount,
				nullCount,
				distinctCount,
				emptyCount: present ? emptyCount : null,
				sampleSize: lengths.length,
				length,
			},
			// `high` if both counts came back AND we got at least one
			// non-null sample to length-measure. `medium` if the column
			// is empty / all-null but the queries ran clean. `low`
			// already returned above on tool / shape errors.
			confidence: (nonNullCount ?? 0) > 0 && lengths.length > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

function clampSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 50;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

function computeLengthStats(lengths: readonly number[]): LengthStats {
	if (lengths.length === 0) return { min: null, max: null, avg: null, median: null };
	let min = lengths[0]!;
	let max = lengths[0]!;
	let sum = 0;
	for (const l of lengths) {
		if (l < min) min = l;
		if (l > max) max = l;
		sum += l;
	}
	const sorted = [...lengths].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 0
		? (sorted[mid - 1]! + sorted[mid]!) / 2
		: sorted[mid]!;
	return { min, max, avg: sum / lengths.length, median };
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

function empty(target: string, column: string): ProfileTextOutput {
	return {
		target, column,
		count: null, nonNullCount: null, nullCount: null, distinctCount: null,
		emptyCount: null, sampleSize: 0,
		length: { min: null, max: null, avg: null, median: null },
	};
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

export function registerDataProfileTextRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
