/**
 * Shared math + IO contract for `data.profile.temporal.{rdbms,file}`
 * (Phase 5a.3 of plans/analyzers/data-analyzer-skills.md).
 *
 * Both transport wrappers ask `db_*_aggregate` for three keys
 * (count / count_non_null / distinct_count) and translate the result
 * into the typed temporal-profile shape.
 *
 * **Known partial.** Plan calls for "min/max range + gap detection +
 * period inference"; this v1 ships only count + cardinality. The
 * gap is the existing aggregate tool's `values: Record<string,
 * number | null>` shape -- it cannot return Date / timestamp values
 * from `min` / `max`. A type-aware aggregation surface is the
 * natural follow-up; gap / period detection layers on top.
 */

interface AggregateSpec {
	readonly column: string;
	readonly function: string;
}

export interface ProfileTemporalOutput {
	readonly target: string;
	readonly column: string;
	readonly count: number | null;
	readonly nonNullCount: number | null;
	readonly nullCount: number | null;
	readonly distinctCount: number | null;
}

export function temporalAggregationsFor(column: string): AggregateSpec[] {
	return [
		{ column, function: 'count' },
		{ column, function: 'count_non_null' },
		{ column, function: 'distinct_count' },
	];
}

export function buildTemporalProfile(
	target: string,
	column: string,
	values: Readonly<Record<string, number | null>>,
): ProfileTemporalOutput {
	const count = values[`${column}__count`] ?? null;
	const nonNullCount = values[`${column}__count_non_null`] ?? null;
	const nullCount = (count !== null && nonNullCount !== null) ? count - nonNullCount : null;
	return {
		target, column,
		count, nonNullCount, nullCount,
		distinctCount: values[`${column}__distinct_count`] ?? null,
	};
}

export function emptyTemporalProfile(target: string, column: string): ProfileTemporalOutput {
	return { target, column, count: null, nonNullCount: null, nullCount: null, distinctCount: null };
}

export const TEMPORAL_PROFILE_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:        { type: 'string' },
		column:        { type: 'string' },
		count:         { type: ['number', 'null'] },
		nonNullCount:  { type: ['number', 'null'] },
		nullCount:     { type: ['number', 'null'] },
		distinctCount: { type: ['number', 'null'] },
	},
	required: ['target', 'column', 'count', 'nonNullCount', 'nullCount', 'distinctCount'],
	additionalProperties: false,
};

/** Notes string both wrappers attach so the deferred-math caveat is consistent. */
export const TEMPORAL_DEFERRED_NOTE = 'min/max range + gap/period inference deferred -- needs a type-aware aggregation surface';

export interface AggregateResultRaw {
	readonly target: string;
	readonly values: Readonly<Record<string, number | null>>;
}

export function isAggregateResult(v: unknown): v is AggregateResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && typeof o['values'] === 'object' && o['values'] !== null;
}
