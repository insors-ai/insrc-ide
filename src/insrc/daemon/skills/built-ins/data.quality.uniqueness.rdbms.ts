/**
 * data.quality.uniqueness.rdbms -- Phase 5d.2 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic quality skill: per-column uniqueness ratio plus a
 * primary-key-candidate detector. A column is a PK candidate when
 * `distinctCount === nonNullCount` AND the column has no nulls
 * (`nullCount === 0`).
 *
 * Two tool round-trips: `db_sql_describe` to discover columns, then
 * one `db_sql_aggregate` packing `count(*)` + `count_non_null` +
 * `distinct_count` per column. The 32-spec aggregation cap means
 * `1 + 2N <= 32`, so the column cap lands at 15 -- wider tables
 * truncate with a clear note. Pass an explicit `columns` filter to
 * profile a different slice.
 *
 * Output: per-column metrics + a flat list of PK candidates +
 * `truncated` flag. The skill DOES NOT collapse multi-column unique
 * constraints (those need pairwise distinct counts which scale
 * combinatorially); single-column candidates only.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

const COL_CAP = 15;

interface QualityUniquenessInput {
	readonly connectionId: string;
	readonly target: string;
	readonly columns?: readonly string[];
}

interface ColumnUniqueness {
	readonly name: string;
	readonly nonNullCount: number | null;
	readonly distinctCount: number | null;
	readonly uniquenessRatio: number | null;
	readonly isPrimaryKeyCandidate: boolean;
}

interface QualityUniquenessOutput {
	readonly target: string;
	readonly totalRows: number | null;
	readonly columns: readonly ColumnUniqueness[];
	readonly primaryKeyCandidates: readonly string[];
	readonly truncated: boolean;
}

const COLUMN_SCHEMA = {
	type: 'object',
	properties: {
		name:                  { type: 'string' },
		nonNullCount:          { type: ['number', 'null'] },
		distinctCount:         { type: ['number', 'null'] },
		uniquenessRatio:       { type: ['number', 'null'] },
		isPrimaryKeyCandidate: { type: 'boolean' },
	},
	required: ['name', 'nonNullCount', 'distinctCount', 'uniquenessRatio', 'isPrimaryKeyCandidate'],
	additionalProperties: false,
} as const;

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<QualityUniquenessInput, QualityUniquenessOutput> = {
	id: 'data.quality.uniqueness.rdbms',
	name: 'Quality: uniqueness + PK candidates (RDBMS)',
	description:
		'Per-column distinct/total ratio plus single-column primary-key candidates. Auto-discovers columns ' +
		'via db_sql_describe; packs count_non_null + distinct_count per column into one db_sql_aggregate ' +
		'round-trip. Up to 15 columns per call; pass explicit `columns` to slice wider tables.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			columns:      { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 15 },
		},
		required: ['connectionId', 'target'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:               { type: 'string' },
			totalRows:            { type: ['number', 'null'] },
			columns:              { type: 'array', items: COLUMN_SCHEMA },
			primaryKeyCandidates: { type: 'array', items: { type: 'string' } },
			truncated:            { type: 'boolean' },
		},
		required: ['target', 'totalRows', 'columns', 'primaryKeyCandidates', 'truncated'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_describe', 'db_sql_aggregate'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_describe', 'db_sql_aggregate'],
			reason: 'describe for column list; aggregate for the per-column counts',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<QualityUniquenessOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const notes: string[] = [];

		const cols = await resolveColumns(input, deps, callBase);
		if (typeof cols === 'string') {
			return { value: empty(input.target), confidence: 'low', notes: [cols], toolCalls: [] };
		}
		const truncated = cols.length > COL_CAP;
		const usedCols = truncated ? cols.slice(0, COL_CAP) : cols;
		if (truncated) {
			notes.push(
				`uniqueness truncated: ${cols.length} columns in target, profiling first ${COL_CAP}. ` +
				`Pass explicit \`columns\` to profile a different slice.`,
			);
		}

		const aggInput: { connectionId: string; target: string; aggregations: { column: string; function: string }[] } = {
			connectionId: input.connectionId,
			target: input.target,
			aggregations: [{ column: '*', function: 'count' }],
		};
		for (const c of usedCols) {
			aggInput.aggregations.push({ column: c, function: 'count_non_null' });
			aggInput.aggregations.push({ column: c, function: 'distinct_count' });
		}

		const aggResult = await deps.runTool({
			id: `${callBase}-agg`,
			name: 'db_sql_aggregate',
			input: aggInput,
		});

		if (aggResult.isError) {
			return {
				value: empty(input.target),
				confidence: 'low',
				notes: [...notes, `db_sql_aggregate error: ${aggResult.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		const aggData = aggResult.data;
		if (!isAggregateResult(aggData)) {
			return {
				value: empty(input.target),
				confidence: 'low',
				notes: [...notes, 'db_sql_aggregate returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const totalRows = aggData.values['*__count'] ?? null;
		const columns: ColumnUniqueness[] = usedCols.map(name => {
			const nonNullCount  = aggData.values[`${name}__count_non_null`] ?? null;
			const distinctCount = aggData.values[`${name}__distinct_count`] ?? null;
			const uniquenessRatio = (nonNullCount !== null && nonNullCount > 0 && distinctCount !== null)
				? distinctCount / nonNullCount
				: null;
			// PK candidate: every value is distinct AND no nulls. We
			// require totalRows + nonNullCount to align (no nulls) AND
			// distinctCount to equal nonNullCount (full uniqueness).
			const isPrimaryKeyCandidate =
				totalRows !== null && totalRows > 0
				&& nonNullCount !== null && nonNullCount === totalRows
				&& distinctCount !== null && distinctCount === nonNullCount;
			return { name, nonNullCount, distinctCount, uniquenessRatio, isPrimaryKeyCandidate };
		});

		const primaryKeyCandidates = columns.filter(c => c.isPrimaryKeyCandidate).map(c => c.name);

		return {
			value: {
				target: aggData.target,
				totalRows,
				columns,
				primaryKeyCandidates,
				truncated,
			},
			confidence: totalRows !== null && totalRows > 0 ? 'high' : 'medium',
			...(notes.length > 0 ? { notes } : {}),
			toolCalls: [],
		};
	},
};

async function resolveColumns(
	input: QualityUniquenessInput,
	deps: SkillDeps,
	callBase: string,
): Promise<readonly string[] | string> {
	if (input.columns !== undefined && input.columns.length > 0) return input.columns;
	const describe = await deps.runTool({
		id: `${callBase}-desc`,
		name: 'db_sql_describe',
		input: { connectionId: input.connectionId, target: input.target },
	});
	if (describe.isError) {
		return `db_sql_describe error: ${describe.content.slice(0, 200)}`;
	}
	const data = describe.data;
	if (typeof data !== 'object' || data === null || !Array.isArray((data as { columns: unknown }).columns)) {
		return 'db_sql_describe returned a result without the expected structured data shape';
	}
	const cols = (data as { columns: { name: string }[] }).columns
		.map(c => c.name)
		.filter(n => typeof n === 'string' && n.length > 0);
	if (cols.length === 0) return `target '${input.target}' has no columns`;
	return cols;
}

function empty(target: string): QualityUniquenessOutput {
	return { target, totalRows: null, columns: [], primaryKeyCandidates: [], truncated: false };
}

interface AggregateResultRaw {
	readonly target: string;
	readonly values: Readonly<Record<string, number | null>>;
}

function isAggregateResult(v: unknown): v is AggregateResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && typeof o['values'] === 'object' && o['values'] !== null;
}

export function registerDataQualityUniquenessRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
