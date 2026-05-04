/**
 * Shared math + IO contract for `data.dependency.co-null-pattern.{rdbms,file}`
 * (Phase 5c.4 of plans/analyzers/data-analyzer-skills.md).
 *
 * Pairwise null co-occurrence. For each (A, B):
 *   bothNull / aNullOnly / bNullOnly / neitherNull bucket counts;
 *   jointNullRate = bothNull / sampleSize;
 *   jaccardSimilarity = bothNull / (bothNull + aNullOnly + bNullOnly).
 *
 * Two execution modes:
 *   - `sample` (default): builds bitmaps from a 50-row sample. Cheap;
 *     sampling-bias caveat applies.
 *   - `full-table`: issues four `count_where` aggregates per pair via
 *     the new Phase 0.1.x predicate-based aggregate. Precise. Caller
 *     pays N*(N-1)/2 round-trips' worth of aggregates; the wrapper
 *     batches them into one `db_*_aggregate` call up to the 32-spec
 *     budget, then chains additional calls if needed.
 */

export const CO_NULL_COL_CAP = 15;
export const CO_NULL_PAIR_OUTPUT_CAP = 50;
/** Pairs per aggregate batch (4 count_where specs each, 32-spec cap). */
export const CO_NULL_PAIRS_PER_BATCH = 8;

export type CoNullSource = 'sample' | 'full-table';

export interface CoNullPair {
	readonly columnA: string;
	readonly columnB: string;
	readonly bothNull: number;
	readonly aNullOnly: number;
	readonly bNullOnly: number;
	readonly neitherNull: number;
	readonly jointNullRate: number;
	readonly jaccardSimilarity: number | null;
}

export interface CoNullOutput {
	readonly target: string;
	readonly sampleSize: number;
	readonly columns: readonly string[];
	readonly pairs: readonly CoNullPair[];
	readonly truncated: boolean;
	readonly source: CoNullSource;
	readonly totalRows: number | null;
}

export function clampCoNullSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 50;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

export interface CoNullBuildResult {
	readonly output: CoNullOutput;
	readonly notes: readonly string[];
	readonly anyNull: boolean;
}

export function buildCoNullOutput(
	target: string,
	usedCols: readonly string[],
	rows: readonly Readonly<Record<string, unknown>>[],
	sampleColumns: readonly string[],
	truncated: boolean,
): CoNullBuildResult {
	const notes: string[] = [];
	const presentCols = usedCols.filter(c => sampleColumns.includes(c));
	if (presentCols.length < 2) {
		notes.push(`co-null-pattern: < 2 of the requested columns present in sample (have: ${sampleColumns.join(', ')})`);
		return {
			output: { target, sampleSize: rows.length, columns: presentCols, pairs: [], truncated, source: 'sample', totalRows: null },
			notes,
			anyNull: false,
		};
	}

	const nullBitmap = new Map<string, boolean[]>();
	for (const c of presentCols) {
		const bits: boolean[] = [];
		for (const row of rows) {
			const v = row[c];
			bits.push(v === null || v === undefined);
		}
		nullBitmap.set(c, bits);
	}
	const nRows = rows.length;

	const pairs: CoNullPair[] = [];
	for (let i = 0; i < presentCols.length; i++) {
		for (let j = i + 1; j < presentCols.length; j++) {
			const a = presentCols[i]!;
			const b = presentCols[j]!;
			const aBits = nullBitmap.get(a)!;
			const bBits = nullBitmap.get(b)!;
			let bothNull = 0, aNullOnly = 0, bNullOnly = 0, neitherNull = 0;
			for (let k = 0; k < nRows; k++) {
				const aN = aBits[k]!;
				const bN = bBits[k]!;
				if (aN && bN) bothNull++;
				else if (aN) aNullOnly++;
				else if (bN) bNullOnly++;
				else neitherNull++;
			}
			const union = bothNull + aNullOnly + bNullOnly;
			const jaccardSimilarity = union > 0 ? bothNull / union : null;
			pairs.push({
				columnA: a, columnB: b,
				bothNull, aNullOnly, bNullOnly, neitherNull,
				jointNullRate: nRows > 0 ? bothNull / nRows : 0,
				jaccardSimilarity,
			});
		}
	}
	pairs.sort((a, b) => {
		const aJ = a.jaccardSimilarity ?? -1;
		const bJ = b.jaccardSimilarity ?? -1;
		if (aJ !== bJ) return bJ - aJ;
		if (a.bothNull !== b.bothNull) return b.bothNull - a.bothNull;
		const ab = `${a.columnA}|${a.columnB}`;
		const bb = `${b.columnA}|${b.columnB}`;
		return ab.localeCompare(bb);
	});
	const cappedPairs = pairs.length > CO_NULL_PAIR_OUTPUT_CAP ? pairs.slice(0, CO_NULL_PAIR_OUTPUT_CAP) : pairs;
	if (pairs.length > CO_NULL_PAIR_OUTPUT_CAP) {
		notes.push(`co-null-pattern: ${pairs.length} pairs computed; output capped at ${CO_NULL_PAIR_OUTPUT_CAP} top-jaccard rows`);
	}
	const anyNull = pairs.some(p => p.bothNull > 0 || p.aNullOnly > 0 || p.bNullOnly > 0);
	return {
		output: {
			target, sampleSize: nRows,
			columns: presentCols,
			pairs: cappedPairs,
			truncated,
			source: 'sample',
			totalRows: null,
		},
		notes,
		anyNull,
	};
}

/**
 * Build the 4 count_where aggregations for one pair (a, b):
 * bothNull, aNullOnly, bNullOnly, neitherNull.
 */
export function coNullPairAggregations(a: string, b: string): readonly {
	readonly column: string;
	readonly function: string;
	readonly args: { readonly predicate: readonly { readonly column: string; readonly op: 'is null' | 'is not null' }[] };
}[] {
	return [
		{ column: a, function: 'count_where', args: { predicate: [{ column: a, op: 'is null' }, { column: b, op: 'is null' }] } },
		{ column: b, function: 'count_where', args: { predicate: [{ column: a, op: 'is null' }, { column: b, op: 'is not null' }] } },
		{ column: a, function: 'count_where', args: { predicate: [{ column: a, op: 'is not null' }, { column: b, op: 'is null' }] } },
		{ column: b, function: 'count_where', args: { predicate: [{ column: a, op: 'is not null' }, { column: b, op: 'is not null' }] } },
	];
}

interface CoNullPairCounts {
	readonly columnA: string;
	readonly columnB: string;
	readonly bothNull: number;
	readonly aNullOnly: number;
	readonly bNullOnly: number;
	readonly neitherNull: number;
}

/**
 * Build a CoNullOutput from the engine's full-table aggregate results.
 * Accepts the per-pair 4-count tuples in declaration order; renders the
 * same shape as the sample-based path. `totalRows` is the engine's
 * COUNT(*) (passed in alongside).
 */
export function buildCoNullOutputFromCounts(
	target: string,
	usedCols: readonly string[],
	pairCounts: readonly CoNullPairCounts[],
	totalRows: number,
	truncated: boolean,
): CoNullBuildResult {
	const notes: string[] = [];
	const pairs: CoNullPair[] = pairCounts.map(p => {
		const union = p.bothNull + p.aNullOnly + p.bNullOnly;
		return {
			columnA: p.columnA, columnB: p.columnB,
			bothNull: p.bothNull, aNullOnly: p.aNullOnly,
			bNullOnly: p.bNullOnly, neitherNull: p.neitherNull,
			jointNullRate: totalRows > 0 ? p.bothNull / totalRows : 0,
			jaccardSimilarity: union > 0 ? p.bothNull / union : null,
		};
	});
	pairs.sort((a, b) => {
		const aJ = a.jaccardSimilarity ?? -1;
		const bJ = b.jaccardSimilarity ?? -1;
		if (aJ !== bJ) return bJ - aJ;
		if (a.bothNull !== b.bothNull) return b.bothNull - a.bothNull;
		const ab = `${a.columnA}|${a.columnB}`;
		const bb = `${b.columnA}|${b.columnB}`;
		return ab.localeCompare(bb);
	});
	const cappedPairs = pairs.length > CO_NULL_PAIR_OUTPUT_CAP ? pairs.slice(0, CO_NULL_PAIR_OUTPUT_CAP) : pairs;
	if (pairs.length > CO_NULL_PAIR_OUTPUT_CAP) {
		notes.push(`co-null-pattern: ${pairs.length} pairs computed; output capped at ${CO_NULL_PAIR_OUTPUT_CAP} top-jaccard rows`);
	}
	const anyNull = pairs.some(p => p.bothNull > 0 || p.aNullOnly > 0 || p.bNullOnly > 0);
	return {
		output: {
			target, sampleSize: totalRows,
			columns: usedCols,
			pairs: cappedPairs,
			truncated,
			source: 'full-table',
			totalRows,
		},
		notes,
		anyNull,
	};
}

export function emptyCoNullOutput(target: string): CoNullOutput {
	return {
		target, sampleSize: 0, columns: [], pairs: [],
		truncated: false, source: 'sample', totalRows: null,
	};
}

const PAIR_SCHEMA = {
	type: 'object',
	properties: {
		columnA:           { type: 'string' },
		columnB:           { type: 'string' },
		bothNull:          { type: 'number' },
		aNullOnly:         { type: 'number' },
		bNullOnly:         { type: 'number' },
		neitherNull:       { type: 'number' },
		jointNullRate:     { type: 'number' },
		jaccardSimilarity: { type: ['number', 'null'] },
	},
	required: ['columnA', 'columnB', 'bothNull', 'aNullOnly', 'bNullOnly',
	           'neitherNull', 'jointNullRate', 'jaccardSimilarity'],
	additionalProperties: false,
} as const;

export const CO_NULL_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:     { type: 'string' },
		sampleSize: { type: 'number' },
		columns:    { type: 'array', items: { type: 'string' } },
		pairs:      { type: 'array', items: PAIR_SCHEMA },
		truncated:  { type: 'boolean' },
		source:     { type: 'string', enum: ['sample', 'full-table'] },
		totalRows:  { type: ['number', 'null'] },
	},
	required: ['target', 'sampleSize', 'columns', 'pairs', 'truncated', 'source', 'totalRows'],
	additionalProperties: false,
};
