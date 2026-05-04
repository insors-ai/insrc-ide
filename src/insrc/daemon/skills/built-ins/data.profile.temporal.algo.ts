/**
 * Shared math + IO contract for `data.profile.temporal.{rdbms,file}`
 * (Phase 5a.3 of plans/analyzers/data-analyzer-skills.md).
 *
 * Both transport wrappers ask `db_*_aggregate` for count + cardinality
 * + temporal min / max and translate the result into the typed
 * temporal-profile shape. Phase 0.1.x widened `AggregateResult.values`
 * to `number | string | null`; the temporal min / max come back as ISO
 * date / datetime strings (or as Date objects coerced to ISO via
 * `readAggregateRow`).
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
	readonly minValue: string | null;
	readonly maxValue: string | null;
	readonly rangeSpanMs: number | null;
	readonly rangeSpanDays: number | null;
}

export function temporalAggregationsFor(column: string): AggregateSpec[] {
	return [
		{ column, function: 'count' },
		{ column, function: 'count_non_null' },
		{ column, function: 'distinct_count' },
		{ column, function: 'min' },
		{ column, function: 'max' },
	];
}

export function buildTemporalProfile(
	target: string,
	column: string,
	values: Readonly<Record<string, number | string | null>>,
): ProfileTemporalOutput {
	const count = numericFromAgg(values[`${column}__count`]);
	const nonNullCount = numericFromAgg(values[`${column}__count_non_null`]);
	const nullCount = (count !== null && nonNullCount !== null) ? count - nonNullCount : null;
	const distinctCount = numericFromAgg(values[`${column}__distinct_count`]);
	const minRaw = values[`${column}__min`] ?? null;
	const maxRaw = values[`${column}__max`] ?? null;
	const minValue = stringValue(minRaw);
	const maxValue = stringValue(maxRaw);

	let rangeSpanMs: number | null = null;
	let rangeSpanDays: number | null = null;
	if (minValue !== null && maxValue !== null) {
		const minMs = Date.parse(minValue);
		const maxMs = Date.parse(maxValue);
		if (Number.isFinite(minMs) && Number.isFinite(maxMs) && maxMs >= minMs) {
			rangeSpanMs = maxMs - minMs;
			rangeSpanDays = rangeSpanMs / (1000 * 60 * 60 * 24);
		}
	}

	return {
		target, column,
		count, nonNullCount, nullCount,
		distinctCount,
		minValue, maxValue,
		rangeSpanMs, rangeSpanDays,
	};
}

export function emptyTemporalProfile(target: string, column: string): ProfileTemporalOutput {
	return {
		target, column,
		count: null, nonNullCount: null, nullCount: null,
		distinctCount: null,
		minValue: null, maxValue: null,
		rangeSpanMs: null, rangeSpanDays: null,
	};
}

function numericFromAgg(v: number | string | null | undefined): number | null {
	if (v === null || v === undefined) return null;
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function stringValue(v: number | string | null | undefined): string | null {
	if (v === null || v === undefined) return null;
	if (typeof v === 'string') return v;
	if (typeof v === 'number' && Number.isFinite(v)) return String(v);
	return null;
}

/** Notes string both wrappers attach when the temporal min / max
 *  came back null (engine couldn't surface them). Kept as a constant
 *  for the 5e.x sensitivity-policy skill that grep's for it. */
export const TEMPORAL_DEFERRED_NOTE = 'temporal min/max not surfaced by this engine; skill returned null for range fields';

export const TEMPORAL_PROFILE_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:        { type: 'string' },
		column:        { type: 'string' },
		count:         { type: ['number', 'null'] },
		nonNullCount:  { type: ['number', 'null'] },
		nullCount:     { type: ['number', 'null'] },
		distinctCount: { type: ['number', 'null'] },
		minValue:      { type: ['string', 'null'] },
		maxValue:      { type: ['string', 'null'] },
		rangeSpanMs:   { type: ['number', 'null'] },
		rangeSpanDays: { type: ['number', 'null'] },
	},
	required: ['target', 'column', 'count', 'nonNullCount', 'nullCount',
	           'distinctCount', 'minValue', 'maxValue', 'rangeSpanMs', 'rangeSpanDays'],
	additionalProperties: false,
};

export interface AggregateResultRaw {
	readonly target: string;
	readonly values: Readonly<Record<string, number | string | null>>;
}

export function isAggregateResult(v: unknown): v is AggregateResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && typeof o['values'] === 'object' && o['values'] !== null;
}
