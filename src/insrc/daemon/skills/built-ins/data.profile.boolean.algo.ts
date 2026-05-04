/**
 * Shared math + IO contract for `data.profile.boolean.{rdbms,file}`
 * (Phase 5a.5 of plans/analyzers/data-analyzer-skills.md).
 *
 * Both transport wrappers ask `db_*_distinct` for the top-N distinct
 * values of a column (top-N=10 covers any reasonable boolean wire
 * format), then bucket each value into true / false / null / other
 * using a dialect-tolerant normaliser.
 */

export interface ProfileBooleanOutput {
	readonly target: string;
	readonly column: string;
	readonly trueCount: number;
	readonly falseCount: number;
	readonly nullCount: number;
	readonly otherCount: number;
	readonly trueRatio: number | null;
}

/** Top-N requested from `db_*_distinct`. 10 is more than enough. */
export const BOOLEAN_DISTINCT_TOP_N = 10;

/**
 * Bucket a `db_*_distinct` topValues array into true / false / null /
 * other counts and compute the trueRatio over non-null observations.
 */
export function buildBooleanProfile(
	target: string,
	column: string,
	topValues: readonly { value: unknown; count: number }[],
): ProfileBooleanOutput {
	let trueCount = 0;
	let falseCount = 0;
	let nullCount = 0;
	let otherCount = 0;
	for (const v of topValues) {
		const norm = normalizeBoolean(v.value);
		if (norm === true)        trueCount  += v.count;
		else if (norm === false)  falseCount += v.count;
		else if (norm === null)   nullCount  += v.count;
		else                      otherCount += v.count;
	}
	const nonNullObserved = trueCount + falseCount + otherCount;
	const trueRatio = nonNullObserved > 0 ? trueCount / nonNullObserved : null;
	return { target, column, trueCount, falseCount, nullCount, otherCount, trueRatio };
}

/**
 * Map a wire-format boolean to JS `true | false | null`. Falls
 * through to `undefined` ('other') for anything unrecognised.
 * Covers: native booleans, Postgres `t/f` + `true/false` strings,
 * integer 0 / 1, MSSQL BIT (0/1 from tedious), MySQL TINYINT(1)
 * (0/1), DuckDB native true/false.
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

export function emptyBooleanProfile(target: string, column: string): ProfileBooleanOutput {
	return { target, column, trueCount: 0, falseCount: 0, nullCount: 0, otherCount: 0, trueRatio: null };
}

export const BOOLEAN_PROFILE_OUTPUT_SCHEMA: Record<string, unknown> = {
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
};

export interface DistinctResultRaw {
	readonly target: string;
	readonly column: string;
	readonly distinctCount: number;
	readonly topValues: readonly { value: unknown; count: number }[];
}

export function isDistinctResult(v: unknown): v is DistinctResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['column'] === 'string'
		&& typeof o['distinctCount'] === 'number'
		&& Array.isArray(o['topValues']);
}
