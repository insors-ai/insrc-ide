/**
 * Shared math + IO contract for `data.profile.categorical.{rdbms,file}`
 * (Phase 5a.2 of plans/analyzers/data-analyzer-skills.md).
 *
 * Both transport wrappers ask `db_*_aggregate` for count + non-null
 * count, ask `db_*_distinct` for the top-N values + cardinality,
 * then merge into a typed profile with per-value frequency
 * (count / non-null count).
 */

interface AggregateSpec {
	readonly column: string;
	readonly function: string;
}

export interface ValueFrequency {
	readonly value: unknown;
	readonly count: number;
	readonly frequency: number;       // count / nonNullCount; 0 when no observations
}

export interface ProfileCategoricalOutput {
	readonly target: string;
	readonly column: string;
	readonly count: number | null;
	readonly nonNullCount: number | null;
	readonly nullCount: number | null;
	readonly distinctCount: number | null;
	readonly topValues: readonly ValueFrequency[];
}

export const CATEGORICAL_DEFAULT_TOP_N = 20;

export function categoricalAggregationsFor(column: string): AggregateSpec[] {
	return [
		{ column, function: 'count' },
		{ column, function: 'count_non_null' },
	];
}

export function buildCategoricalProfile(
	target: string,
	column: string,
	aggValues: Readonly<Record<string, number | null>>,
	distinctCount: number,
	rawTopValues: readonly { value: unknown; count: number }[],
): ProfileCategoricalOutput {
	const count = aggValues[`${column}__count`] ?? null;
	const nonNullCount = aggValues[`${column}__count_non_null`] ?? null;
	const nullCount = (count !== null && nonNullCount !== null) ? count - nonNullCount : null;
	const denom = nonNullCount !== null && nonNullCount > 0 ? nonNullCount : 0;
	const topValues: ValueFrequency[] = rawTopValues.map(v => ({
		value:     v.value,
		count:     v.count,
		frequency: denom > 0 ? v.count / denom : 0,
	}));
	return { target, column, count, nonNullCount, nullCount, distinctCount, topValues };
}

export function emptyCategoricalProfile(target: string, column: string): ProfileCategoricalOutput {
	return {
		target, column,
		count: null, nonNullCount: null, nullCount: null, distinctCount: null,
		topValues: [],
	};
}

const TOP_VALUES_SCHEMA = {
	type: 'array',
	items: {
		type: 'object',
		properties: {
			value:     {},
			count:     { type: 'number' },
			frequency: { type: 'number' },
		},
		required: ['value', 'count', 'frequency'],
		additionalProperties: false,
	},
} as const;

export const CATEGORICAL_PROFILE_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:        { type: 'string' },
		column:        { type: 'string' },
		count:         { type: ['number', 'null'] },
		nonNullCount:  { type: ['number', 'null'] },
		nullCount:     { type: ['number', 'null'] },
		distinctCount: { type: ['number', 'null'] },
		topValues:     TOP_VALUES_SCHEMA,
	},
	required: ['target', 'column', 'count', 'nonNullCount', 'nullCount', 'distinctCount', 'topValues'],
	additionalProperties: false,
};

export interface AggregateResultRaw {
	readonly target: string;
	readonly values: Readonly<Record<string, number | null>>;
}

export interface DistinctResultRaw {
	readonly target: string;
	readonly column: string;
	readonly distinctCount: number;
	readonly topValues: readonly { value: unknown; count: number }[];
}

export function isAggregateResult(v: unknown): v is AggregateResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && typeof o['values'] === 'object' && o['values'] !== null;
}

export function isDistinctResult(v: unknown): v is DistinctResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['column'] === 'string'
		&& typeof o['distinctCount'] === 'number'
		&& Array.isArray(o['topValues']);
}
