/**
 * Shared math + IO contract for `data.profile.numeric.{rdbms,file}`
 * (Phase 5a.1 of plans/analyzers/data-analyzer-skills.md).
 *
 * The two transport wrappers (`.rdbms` calling `db_sql_aggregate`,
 * `.file` calling `db_file_aggregate`) share an identical
 * algorithm: ask the engine for ten numeric aggregations, then
 * extract a flat typed profile from the `<column>__<function>`
 * keyed result. This module is the single source of truth for that
 * algorithm; both wrappers delegate.
 *
 * No tool deps, no skill deps -- pure-JS transformation. Importable
 * from anywhere in the daemon without dragging in registry side-
 * effects.
 */

export interface ProfileNumericOutput {
	readonly target: string;
	readonly column: string;
	readonly count: number | null;
	readonly nonNullCount: number | null;
	readonly nullCount: number | null;
	readonly distinctCount: number | null;
	readonly min: number | null;
	readonly max: number | null;
	readonly avg: number | null;
	readonly stddev: number | null;
	readonly variance: number | null;
	readonly p50: number | null;
	readonly p95: number | null;
}

interface AggregateSpec {
	readonly column: string;
	readonly function: string;
	readonly args?: { readonly p?: number };
}

/**
 * The full aggregations-array sent to `db_*_aggregate`. Extract via
 * helper so both wrappers (.rdbms / .file) emit identical specs.
 */
export function numericAggregationsFor(column: string): AggregateSpec[] {
	return [
		{ column, function: 'count' },
		{ column, function: 'count_non_null' },
		{ column, function: 'distinct_count' },
		{ column, function: 'min' },
		{ column, function: 'max' },
		{ column, function: 'avg' },
		{ column, function: 'stddev' },
		{ column, function: 'variance' },
		{ column, function: 'percentile', args: { p: 0.5 } },
		{ column, function: 'percentile', args: { p: 0.95 } },
	];
}

/**
 * Translate a `db_*_aggregate` result's flat `values` record into the
 * typed numeric profile. Both wrappers call this with the same
 * shape.
 */
export function buildNumericProfile(
	target: string,
	column: string,
	values: Readonly<Record<string, number | null>>,
): ProfileNumericOutput {
	const count = values[`${column}__count`] ?? null;
	const nonNullCount = values[`${column}__count_non_null`] ?? null;
	const nullCount = (count !== null && nonNullCount !== null) ? count - nonNullCount : null;

	return {
		target, column,
		count, nonNullCount, nullCount,
		distinctCount: values[`${column}__distinct_count`]   ?? null,
		min:           values[`${column}__min`]              ?? null,
		max:           values[`${column}__max`]              ?? null,
		avg:           values[`${column}__avg`]              ?? null,
		stddev:        values[`${column}__stddev`]           ?? null,
		variance:      values[`${column}__variance`]         ?? null,
		p50:           values[`${column}__percentile_0_5`]   ?? null,
		p95:           values[`${column}__percentile_0_95`]  ?? null,
	};
}

export function emptyNumericProfile(target: string, column: string): ProfileNumericOutput {
	return {
		target, column,
		count: null, nonNullCount: null, nullCount: null, distinctCount: null,
		min: null, max: null, avg: null, stddev: null, variance: null,
		p50: null, p95: null,
	};
}

/**
 * The output JSON Schema -- both wrappers reuse this. Kept as a
 * `Record<string, unknown>` (vs the strict TS type the validator
 * library uses) so it can be embedded inline in the wrapper's
 * skill definition without an `as const` on every leaf.
 */
export const NUMERIC_PROFILE_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:        { type: 'string' },
		column:        { type: 'string' },
		count:         { type: ['number', 'null'] },
		nonNullCount:  { type: ['number', 'null'] },
		nullCount:     { type: ['number', 'null'] },
		distinctCount: { type: ['number', 'null'] },
		min:           { type: ['number', 'null'] },
		max:           { type: ['number', 'null'] },
		avg:           { type: ['number', 'null'] },
		stddev:        { type: ['number', 'null'] },
		variance:      { type: ['number', 'null'] },
		p50:           { type: ['number', 'null'] },
		p95:           { type: ['number', 'null'] },
	},
	required: [
		'target', 'column', 'count', 'nonNullCount', 'nullCount', 'distinctCount',
		'min', 'max', 'avg', 'stddev', 'variance', 'p50', 'p95',
	],
	additionalProperties: false,
};

/**
 * Tool-result shape `db_*_aggregate` returns under `data`. Both
 * wrappers parse-check via this; centralising avoids drift.
 */
export interface AggregateResultRaw {
	readonly target: string;
	readonly values: Readonly<Record<string, number | null>>;
}

export function isAggregateResult(v: unknown): v is AggregateResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['values'] === 'object'
		&& o['values'] !== null;
}
