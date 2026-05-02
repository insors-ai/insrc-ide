/**
 * data.quality.completeness.rdbms -- Phase 5d.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic quality skill: computes the null-rate of every column in a
 * target table plus the table-level overall null rate. Two tool
 * round-trips: `db_sql_describe` to discover columns, then a single
 * `db_sql_aggregate` packing `count(*)` + `count_non_null(<col>)` for
 * each column.
 *
 * Column cap. `db_sql_aggregate` accepts up to 32 aggregation specs
 * per call. We use 1 for `count(*)` plus 1 per column, so the cap
 * lands at 31 columns. Tables wider than that get truncated and a
 * `truncated: true` flag in the output -- callers needing every
 * column should call with an explicit `columns` filter to slice.
 *
 * Output: per-column null counts + null rate, plus an `overallNullRate`
 * (mean across columns). The mean is intentionally simple; richer
 * weighting (e.g. by data-importance metadata) is a future plan.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

const COL_CAP = 31;

interface QualityCompletenessInput {
	readonly connectionId: string;
	readonly target: string;
	readonly columns?: readonly string[];
}

interface ColumnCompleteness {
	readonly name: string;
	readonly nonNullCount: number | null;
	readonly nullCount: number | null;
	readonly nullRate: number | null;
}

interface QualityCompletenessOutput {
	readonly target: string;
	readonly totalRows: number | null;
	readonly columns: readonly ColumnCompleteness[];
	readonly overallNullRate: number | null;
	readonly truncated: boolean;
}

const COLUMN_SCHEMA = {
	type: 'object',
	properties: {
		name:         { type: 'string' },
		nonNullCount: { type: ['number', 'null'] },
		nullCount:    { type: ['number', 'null'] },
		nullRate:     { type: ['number', 'null'] },
	},
	required: ['name', 'nonNullCount', 'nullCount', 'nullRate'],
	additionalProperties: false,
} as const;

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<QualityCompletenessInput, QualityCompletenessOutput> = {
	id: 'data.quality.completeness.rdbms',
	name: 'Quality: completeness (RDBMS)',
	description:
		'Per-column null rate plus overall table null rate. Auto-discovers columns via db_sql_describe; ' +
		'packs every count_non_null into one db_sql_aggregate round-trip. Up to 31 columns per call; ' +
		'pass explicit `columns` to slice wider tables.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			columns:      { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 31 },
		},
		required: ['connectionId', 'target'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:          { type: 'string' },
			totalRows:       { type: ['number', 'null'] },
			columns:         { type: 'array', items: COLUMN_SCHEMA },
			overallNullRate: { type: ['number', 'null'] },
			truncated:       { type: 'boolean' },
		},
		required: ['target', 'totalRows', 'columns', 'overallNullRate', 'truncated'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_describe', 'db_sql_aggregate'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_describe', 'db_sql_aggregate'],
			reason: 'describe gives column list; aggregate gives counts',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<QualityCompletenessOutput>> {
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
				`completeness truncated: ${cols.length} columns in target, profiling first ${COL_CAP}. ` +
				`Pass explicit \`columns\` to profile a different slice.`,
			);
		}

		const aggResult = await deps.runTool({
			id: `${callBase}-agg`,
			name: 'db_sql_aggregate',
			input: {
				connectionId: input.connectionId,
				target: input.target,
				aggregations: [
					{ column: '*', function: 'count' },
					...usedCols.map(c => ({ column: c, function: 'count_non_null' as const })),
				],
			},
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
		const columns: ColumnCompleteness[] = usedCols.map(name => {
			const nonNullCount = aggData.values[`${name}__count_non_null`] ?? null;
			const nullCount   = (totalRows !== null && nonNullCount !== null) ? totalRows - nonNullCount : null;
			const nullRate    = (totalRows !== null && totalRows > 0 && nullCount !== null) ? nullCount / totalRows : null;
			return { name, nonNullCount, nullCount, nullRate };
		});

		const observedRates = columns.map(c => c.nullRate).filter((r): r is number => r !== null);
		const overallNullRate = observedRates.length > 0
			? observedRates.reduce((a, b) => a + b, 0) / observedRates.length
			: null;

		return {
			value: {
				target: aggData.target,
				totalRows,
				columns,
				overallNullRate,
				truncated,
			},
			confidence: totalRows !== null && totalRows > 0 ? 'high' : 'medium',
			...(notes.length > 0 ? { notes } : {}),
			toolCalls: [],
		};
	},
};

/**
 * If the caller supplied `columns`, validate non-empty + return.
 * Otherwise call `db_sql_describe` to get the column list. Returns a
 * string error message on tool failure.
 */
async function resolveColumns(
	input: QualityCompletenessInput,
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

function empty(target: string): QualityCompletenessOutput {
	return { target, totalRows: null, columns: [], overallNullRate: null, truncated: false };
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

export function registerDataQualityCompletenessRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
