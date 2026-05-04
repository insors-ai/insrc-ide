/**
 * Shared math + IO contract for `data.quality.uniqueness.{rdbms,file}`
 * (Phase 5d.2 of plans/analyzers/data-analyzer-skills.md).
 */

interface AggregateSpec {
	readonly column: string;
	readonly function: string;
	readonly args?: { readonly columns?: readonly string[] };
}

export const UNIQUENESS_COL_CAP = 15;

export interface ColumnUniqueness {
	readonly name: string;
	readonly nonNullCount: number | null;
	readonly distinctCount: number | null;
	readonly uniquenessRatio: number | null;
	readonly isPrimaryKeyCandidate: boolean;
}

export interface CompositePkCandidate {
	readonly columns: readonly string[];
	readonly distinctCount: number | null;
	readonly isCandidate: boolean;
}

export interface QualityUniquenessOutput {
	readonly target: string;
	readonly totalRows: number | null;
	readonly columns: readonly ColumnUniqueness[];
	readonly primaryKeyCandidates: readonly string[];
	readonly compositePkCandidates: readonly CompositePkCandidate[];
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

/**
 * Phase 5d.1/5d.2 multi-column PK: caller supplies candidate column
 * tuples; we add one composite_distinct_count aggregate per tuple.
 * Cap kept at the same 32-spec budget as the single-column path.
 */
export function compositePkAggregationsFor(candidates: readonly (readonly string[])[]): AggregateSpec[] {
	return candidates
		.filter(t => t.length >= 2)
		.map(t => ({
			column: '*',
			function: 'composite_distinct_count',
			args: { columns: t },
		}));
}

function compositeDistinctKey(cols: readonly string[]): string {
	return `*__composite_distinct_count_${[...cols].join('_')}`;
}

export function buildUniqueness(
	target: string,
	usedCols: readonly string[],
	truncated: boolean,
	values: Readonly<Record<string, number | string | null>>,
	compositePkCandidates: readonly (readonly string[])[] = [],
): QualityUniquenessOutput {
	const totalRows = numericFromAgg(values['*__count']);
	const columns: ColumnUniqueness[] = usedCols.map(name => {
		const nonNullCount = numericFromAgg(values[`${name}__count_non_null`]);
		const distinctCount = numericFromAgg(values[`${name}__distinct_count`]);
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

	const compositeOut: CompositePkCandidate[] = compositePkCandidates
		.filter(t => t.length >= 2)
		.map(t => {
			const distinctCount = numericFromAgg(values[compositeDistinctKey(t)]);
			const isCandidate = totalRows !== null && totalRows > 0
				&& distinctCount !== null && distinctCount === totalRows;
			return { columns: [...t], distinctCount, isCandidate };
		});

	return {
		target, totalRows, columns,
		primaryKeyCandidates, compositePkCandidates: compositeOut,
		truncated,
	};
}

export function emptyUniqueness(target: string): QualityUniquenessOutput {
	return {
		target, totalRows: null, columns: [],
		primaryKeyCandidates: [], compositePkCandidates: [],
		truncated: false,
	};
}

function numericFromAgg(v: number | string | null | undefined): number | null {
	if (v === null || v === undefined) return null;
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
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

const COMPOSITE_PK_SCHEMA = {
	type: 'object',
	properties: {
		columns:       { type: 'array', items: { type: 'string' } },
		distinctCount: { type: ['number', 'null'] },
		isCandidate:   { type: 'boolean' },
	},
	required: ['columns', 'distinctCount', 'isCandidate'],
	additionalProperties: false,
} as const;

export const UNIQUENESS_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:                 { type: 'string' },
		totalRows:              { type: ['number', 'null'] },
		columns:                { type: 'array', items: COLUMN_SCHEMA },
		primaryKeyCandidates:   { type: 'array', items: { type: 'string' } },
		compositePkCandidates:  { type: 'array', items: COMPOSITE_PK_SCHEMA },
		truncated:              { type: 'boolean' },
	},
	required: ['target', 'totalRows', 'columns', 'primaryKeyCandidates',
	           'compositePkCandidates', 'truncated'],
	additionalProperties: false,
};
