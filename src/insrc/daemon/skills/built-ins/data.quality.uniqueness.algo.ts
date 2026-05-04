/**
 * Shared math + IO contract for `data.quality.uniqueness.{rdbms,file}`
 * (Phase 5d.2 of plans/analyzers/data-analyzer-skills.md).
 */

interface AggregateSpec {
	readonly column: string;
	readonly function: string;
}

export const UNIQUENESS_COL_CAP = 15;

export interface ColumnUniqueness {
	readonly name: string;
	readonly nonNullCount: number | null;
	readonly distinctCount: number | null;
	readonly uniquenessRatio: number | null;
	readonly isPrimaryKeyCandidate: boolean;
}

export interface QualityUniquenessOutput {
	readonly target: string;
	readonly totalRows: number | null;
	readonly columns: readonly ColumnUniqueness[];
	readonly primaryKeyCandidates: readonly string[];
	readonly truncated: boolean;
}

export function uniquenessAggregationsFor(columns: readonly string[]): AggregateSpec[] {
	const out: AggregateSpec[] = [{ column: '*', function: 'count' }];
	for (const c of columns) {
		out.push({ column: c, function: 'count_non_null' });
		out.push({ column: c, function: 'distinct_count' });
	}
	return out;
}

export function buildUniqueness(
	target: string,
	usedCols: readonly string[],
	truncated: boolean,
	values: Readonly<Record<string, number | null>>,
): QualityUniquenessOutput {
	const totalRows = values['*__count'] ?? null;
	const columns: ColumnUniqueness[] = usedCols.map(name => {
		const nonNullCount = values[`${name}__count_non_null`] ?? null;
		const distinctCount = values[`${name}__distinct_count`] ?? null;
		const uniquenessRatio = (nonNullCount !== null && nonNullCount > 0 && distinctCount !== null)
			? distinctCount / nonNullCount
			: null;
		const isPrimaryKeyCandidate =
			totalRows !== null && totalRows > 0
			&& nonNullCount !== null && nonNullCount === totalRows
			&& distinctCount !== null && distinctCount === nonNullCount;
		return { name, nonNullCount, distinctCount, uniquenessRatio, isPrimaryKeyCandidate };
	});
	const primaryKeyCandidates = columns.filter(c => c.isPrimaryKeyCandidate).map(c => c.name);
	return { target, totalRows, columns, primaryKeyCandidates, truncated };
}

export function emptyUniqueness(target: string): QualityUniquenessOutput {
	return { target, totalRows: null, columns: [], primaryKeyCandidates: [], truncated: false };
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

export const UNIQUENESS_OUTPUT_SCHEMA: Record<string, unknown> = {
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
};
