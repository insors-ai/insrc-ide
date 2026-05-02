/**
 * data.quality.validity.rdbms -- Phase 5d.3 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic quality skill: caller-supplied regex validity check. Pulls
 * a sample (up to 50 values) from the column, partitions each
 * non-null value into matched / mismatched against the regex, and
 * returns the match rate as the validity score.
 *
 * **Scope.** The plan's row 5d.3 covers "matches declared type /
 * domain / regex". This v1 ships **regex** only; the type and
 * domain checks need richer infrastructure (per-dialect CHECK
 * constraint introspection, enum domain reads) that would expand
 * the skill considerably. The regex variant alone is the most
 * common analyzer ask -- "does this `email` column actually
 * contain emails?" -- and reuses the regex-over-sample pattern
 * from `pii.detect-patterns`.
 *
 * The pattern is compiled with `new RegExp(pattern)` -- callers
 * pass any JS-valid regex. Anchoring (`^...$`) is the caller's
 * responsibility; an unanchored pattern matches any substring,
 * which produces a higher match rate but is sometimes what you
 * want (e.g. "contains an `@`").
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

interface QualityValidityInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly pattern: string;
	readonly sampleSize?: number;
}

interface QualityValidityOutput {
	readonly target: string;
	readonly column: string;
	readonly pattern: string;
	readonly sampleSize: number;
	readonly matchCount: number;
	readonly mismatchCount: number;
	readonly matchRate: number | null;
	readonly score: number | null;  // alias for matchRate; matches the scorecard naming
	readonly examples: {
		readonly matched: readonly string[];
		readonly mismatched: readonly string[];
	};
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<QualityValidityInput, QualityValidityOutput> = {
	id: 'data.quality.validity.rdbms',
	name: 'Quality: regex validity (RDBMS)',
	description:
		'Validates one column\'s sampled values against a caller-supplied regex pattern. Returns match / ' +
		'mismatch counts + match rate + up to 3 example matches and mismatches. The regex is compiled with ' +
		'JS RegExp; anchor with ^...$ for whole-value matching. Type / domain / CHECK-constraint validity ' +
		'are separate concerns deferred to a follow-up.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			pattern:      { type: 'string', minLength: 1, description: 'JS regex pattern. Anchor with ^...$ for whole-value matching.' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId', 'target', 'column', 'pattern'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:         { type: 'string' },
			column:         { type: 'string' },
			pattern:        { type: 'string' },
			sampleSize:     { type: 'number' },
			matchCount:     { type: 'number' },
			mismatchCount:  { type: 'number' },
			matchRate:      { type: ['number', 'null'] },
			score:          { type: ['number', 'null'] },
			examples: {
				type: 'object',
				properties: {
					matched:    { type: 'array', items: { type: 'string' } },
					mismatched: { type: 'array', items: { type: 'string' } },
				},
				required: ['matched', 'mismatched'],
				additionalProperties: false,
			},
		},
		required: ['target', 'column', 'pattern', 'sampleSize',
		           'matchCount', 'mismatchCount', 'matchRate', 'score', 'examples'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_sample'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_sample'],
			reason: 'sole tool that supplies the value sample we regex over',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only; file / kv variants ship as separate skills',
		},
	],

	async execute(input, deps): Promise<SkillResult<QualityValidityOutput>> {
		// Compile the regex up-front so a malformed pattern fails fast
		// with a clear note instead of crashing the row loop.
		let re: RegExp;
		try {
			re = new RegExp(input.pattern);
		} catch (err) {
			return {
				value: emptyOut(input.target, input.column, input.pattern),
				confidence: 'low',
				notes: [`pattern '${input.pattern}' is not a valid JS regex: ${(err as Error).message}`],
				toolCalls: [],
			};
		}

		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampSample(input.sampleSize);
		const tool = await deps.runTool({
			id: callId,
			name: 'db_sql_sample',
			input: {
				connectionId: input.connectionId,
				target: input.target,
				limit: sampleSize,
			},
		});

		if (tool.isError) {
			return {
				value: emptyOut(input.target, input.column, input.pattern),
				confidence: 'low',
				notes: [`db_sql_sample error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		const data = tool.data;
		if (!isSampleResult(data)) {
			return {
				value: emptyOut(input.target, input.column, input.pattern),
				confidence: 'low',
				notes: ['db_sql_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}
		if (!data.columns.includes(input.column)) {
			return {
				value: emptyOut(input.target, input.column, input.pattern),
				confidence: 'low',
				notes: [`column '${input.column}' not present in sample (available: ${data.columns.join(', ')})`],
				toolCalls: [],
			};
		}

		let matchCount = 0;
		let mismatchCount = 0;
		const matched: string[] = [];
		const mismatched: string[] = [];
		for (const row of data.rows) {
			const v = row[input.column];
			if (v === null || v === undefined) continue;
			const s = typeof v === 'string' ? v : String(v);
			if (re.test(s)) {
				matchCount++;
				if (matched.length < 3) matched.push(s);
			} else {
				mismatchCount++;
				if (mismatched.length < 3) mismatched.push(s);
			}
		}

		const total = matchCount + mismatchCount;
		const matchRate = total > 0 ? matchCount / total : null;

		return {
			value: {
				target: data.target,
				column: input.column,
				pattern: input.pattern,
				sampleSize: total,
				matchCount,
				mismatchCount,
				matchRate,
				score: matchRate,
				examples: { matched, mismatched },
			},
			// `high` when we got a non-empty sample and could compute a
			// rate; `medium` when the sample was empty / all-null;
			// `low` cases already returned above.
			confidence: total > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

function clampSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 50;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

function emptyOut(target: string, column: string, pattern: string): QualityValidityOutput {
	return {
		target, column, pattern,
		sampleSize: 0, matchCount: 0, mismatchCount: 0,
		matchRate: null, score: null,
		examples: { matched: [], mismatched: [] },
	};
}

interface SampleResultRaw {
	readonly target: string;
	readonly columns: readonly string[];
	readonly rows: readonly Readonly<Record<string, unknown>>[];
}

function isSampleResult(v: unknown): v is SampleResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& Array.isArray(o['columns'])
		&& Array.isArray(o['rows']);
}

export function registerDataQualityValidityRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
