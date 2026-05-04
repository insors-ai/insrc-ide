/**
 * Shared math + IO contract for `data.quality.completeness.{rdbms,file}`
 * (Phase 5d.1 of plans/analyzers/data-analyzer-skills.md).
 */

interface AggregateSpec {
	readonly column: string;
	readonly function: string;
}

export const COMPLETENESS_COL_CAP = 31;

export interface ColumnCompleteness {
	readonly name: string;
	readonly nonNullCount: number | null;
	readonly nullCount: number | null;
	readonly nullRate: number | null;
}

export interface QualityCompletenessOutput {
	readonly target: string;
	readonly totalRows: number | null;
	readonly columns: readonly ColumnCompleteness[];
	readonly overallNullRate: number | null;
	readonly truncated: boolean;
}

export function completenessAggregationsFor(columns: readonly string[]): AggregateSpec[] {
	return [
		{ column: '*', function: 'count' },
		...columns.map(c => ({ column: c, function: 'count_non_null' })),
	];
}

export function buildCompleteness(
	target: string,
	usedCols: readonly string[],
	truncated: boolean,
	values: Readonly<Record<string, number | null>>,
): QualityCompletenessOutput {
	const totalRows = values['*__count'] ?? null;
	const columns: ColumnCompleteness[] = usedCols.map(name => {
		const nonNullCount = values[`${name}__count_non_null`] ?? null;
		const nullCount = (totalRows !== null && nonNullCount !== null) ? totalRows - nonNullCount : null;
		const nullRate = (totalRows !== null && totalRows > 0 && nullCount !== null) ? nullCount / totalRows : null;
		return { name, nonNullCount, nullCount, nullRate };
	});
	const observedRates = columns.map(c => c.nullRate).filter((r): r is number => r !== null);
	const overallNullRate = observedRates.length > 0
		? observedRates.reduce((a, b) => a + b, 0) / observedRates.length
		: null;
	return { target, totalRows, columns, overallNullRate, truncated };
}

export function emptyCompleteness(target: string): QualityCompletenessOutput {
	return { target, totalRows: null, columns: [], overallNullRate: null, truncated: false };
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

export const COMPLETENESS_OUTPUT_SCHEMA: Record<string, unknown> = {
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
};

export interface AggregateResultRaw {
	readonly target: string;
	readonly values: Readonly<Record<string, number | null>>;
}

export function isAggregateResult(v: unknown): v is AggregateResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && typeof o['values'] === 'object' && o['values'] !== null;
}
