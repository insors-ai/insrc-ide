/**
 * data.profile.boolean.rdbms -- Phase 5a.5 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: profiles a boolean RDBMS column. Returns true /
 * false / null counts plus the true ratio. Backed by `db_sql_distinct`
 * (server-side GROUP BY -- canonical truth across dialects that vary
 * in how they store booleans, e.g. Postgres `t/f`, MySQL 0/1, MSSQL
 * BIT, SQLite INTEGER).
 *
 * The skill normalizes the values it receives to JS booleans /
 * `null` so callers see one shape regardless of the dialect's wire
 * representation. Anything that doesn't normalize to a known token
 * lands under `other` (rare but possible if the column is BIT and
 * the source has corrupt rows).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

interface ProfileBooleanInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
}

interface ProfileBooleanOutput {
	readonly target: string;
	readonly column: string;
	readonly trueCount: number;
	readonly falseCount: number;
	readonly nullCount: number;
	readonly otherCount: number;
	readonly trueRatio: number | null;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<ProfileBooleanInput, ProfileBooleanOutput> = {
	id: 'data.profile.boolean.rdbms',
	name: 'Profile: boolean column (RDBMS)',
	description:
		'Server-side boolean profile of one RDBMS column. Returns true / false / null / other counts plus ' +
		'the true ratio (over non-null observations). Normalizes wire-format differences across Postgres / ' +
		'MySQL / MSSQL / SQLite / Oracle.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:     { type: 'string' },
			column:     { type: 'string' },
			trueCount:  { type: 'number' },
			falseCount: { type: 'number' },
			nullCount:  { type: 'number' },
			otherCount: { type: 'number' },
			trueRatio:  { type: ['number', 'null'] },
		},
		required: ['target', 'column', 'trueCount', 'falseCount', 'nullCount', 'otherCount', 'trueRatio'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_distinct'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_distinct'],
			reason: 'GROUP BY over the column gives us the per-bucket counts in one round-trip',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<ProfileBooleanOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		// 4 buckets are enough: true / false / null / other.
		// Top-N=10 covers any sane representation (e.g. Postgres 't'/'f'
		// + JS true/false depending on driver wire format).
		const tool = await deps.runTool({
			id: callId,
			name: 'db_sql_distinct',
			input: {
				connectionId: input.connectionId,
				target: input.target,
				column: input.column,
				topN: 10,
			},
		});

		if (tool.isError) {
			return {
				value: emptyProfile(input.target, input.column),
				confidence: 'low',
				notes: [`db_sql_distinct error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}

		const data = tool.data;
		if (!isDistinctResult(data)) {
			return {
				value: emptyProfile(input.target, input.column),
				confidence: 'low',
				notes: ['db_sql_distinct returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		let trueCount = 0;
		let falseCount = 0;
		let nullCount = 0;
		let otherCount = 0;
		for (const v of data.topValues) {
			const norm = normalizeBoolean(v.value);
			if (norm === true)  trueCount  += v.count;
			else if (norm === false) falseCount += v.count;
			else if (norm === null)  nullCount  += v.count;
			else otherCount += v.count;
		}

		const nonNullObserved = trueCount + falseCount + otherCount;
		const trueRatio = nonNullObserved > 0 ? trueCount / nonNullObserved : null;

		return {
			value: {
				target: data.target,
				column: input.column,
				trueCount, falseCount, nullCount, otherCount, trueRatio,
			},
			confidence: nonNullObserved > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

/**
 * Map a wire-format boolean to JS `true | false | null`. Falls
 * through to `'other'` (returned as `undefined`) for anything we
 * don't recognise. The set covers: native booleans, Postgres `t/f`
 * + `true/false` strings, integer 0 / 1, MSSQL BIT (returned as
 * 0 / 1 by tedious / mssql), MySQL TINYINT(1) (0 / 1).
 */
function normalizeBoolean(v: unknown): true | false | null | undefined {
	if (v === null || v === undefined) return null;
	if (typeof v === 'boolean') return v;
	if (typeof v === 'number') {
		if (v === 1) return true;
		if (v === 0) return false;
		return undefined;
	}
	if (typeof v === 'string') {
		const lower = v.toLowerCase();
		if (lower === 't' || lower === 'true'  || lower === '1') return true;
		if (lower === 'f' || lower === 'false' || lower === '0') return false;
		return undefined;
	}
	return undefined;
}

function emptyProfile(target: string, column: string): ProfileBooleanOutput {
	return {
		target, column,
		trueCount: 0, falseCount: 0, nullCount: 0, otherCount: 0,
		trueRatio: null,
	};
}

interface DistinctResultRaw {
	readonly target: string;
	readonly column: string;
	readonly distinctCount: number;
	readonly topValues: readonly { value: unknown; count: number }[];
}

function isDistinctResult(v: unknown): v is DistinctResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['column'] === 'string'
		&& typeof o['distinctCount'] === 'number'
		&& Array.isArray(o['topValues']);
}

export function registerDataProfileBooleanRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
