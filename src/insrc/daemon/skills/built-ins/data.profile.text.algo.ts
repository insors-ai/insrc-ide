/**
 * Shared math + IO contract for `data.profile.text.{rdbms,file}`
 * (Phase 5a.4 of plans/analyzers/data-analyzer-skills.md).
 *
 * Both transport wrappers ask `db_*_aggregate` for count + non-null
 * + distinct, and `db_*_sample` for up to N rows so we can compute
 * length statistics (min / max / avg / median) client-side. Length
 * is sample-based because the current aggregate tool surface
 * doesn't expose `LENGTH()`; the algo file is the single place that
 * knows.
 */

interface AggregateSpec {
	readonly column: string;
	readonly function: string;
}

export interface LengthStats {
	readonly min: number | null;
	readonly max: number | null;
	readonly avg: number | null;
	readonly median: number | null;
}

export interface ProfileTextOutput {
	readonly target: string;
	readonly column: string;
	readonly count: number | null;
	readonly nonNullCount: number | null;
	readonly nullCount: number | null;
	readonly distinctCount: number | null;
	readonly emptyCount: number | null;
	readonly sampleSize: number;
	readonly length: LengthStats;
}

export const TEXT_DEFAULT_SAMPLE_SIZE = 50;

export function textAggregationsFor(column: string): AggregateSpec[] {
	return [
		{ column, function: 'count' },
		{ column, function: 'count_non_null' },
		{ column, function: 'distinct_count' },
	];
}

export function clampTextSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return TEXT_DEFAULT_SAMPLE_SIZE;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

export function buildTextProfile(
	target: string,
	column: string,
	aggValues: Readonly<Record<string, number | null>>,
	sample: { columns: readonly string[]; rows: readonly Readonly<Record<string, unknown>>[] },
): ProfileTextOutput {
	const count = aggValues[`${column}__count`] ?? null;
	const nonNullCount = aggValues[`${column}__count_non_null`] ?? null;
	const nullCount = (count !== null && nonNullCount !== null) ? count - nonNullCount : null;
	const distinctCount = aggValues[`${column}__distinct_count`] ?? null;

	let emptyCount = 0;
	const lengths: number[] = [];
	const present = sample.columns.includes(column);
	if (present) {
		for (const row of sample.rows) {
			const v = row[column];
			if (v === null || v === undefined) continue;
			const s = typeof v === 'string' ? v : String(v);
			if (s.length === 0) emptyCount++;
			lengths.push(s.length);
		}
	}
	const length = computeLengthStats(lengths);

	return {
		target, column,
		count, nonNullCount, nullCount, distinctCount,
		emptyCount: present ? emptyCount : null,
		sampleSize: lengths.length,
		length,
	};
}

function computeLengthStats(lengths: readonly number[]): LengthStats {
	if (lengths.length === 0) return { min: null, max: null, avg: null, median: null };
	let min = lengths[0]!;
	let max = lengths[0]!;
	let sum = 0;
	for (const l of lengths) {
		if (l < min) min = l;
		if (l > max) max = l;
		sum += l;
	}
	const sorted = [...lengths].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 0
		? (sorted[mid - 1]! + sorted[mid]!) / 2
		: sorted[mid]!;
	return { min, max, avg: sum / lengths.length, median };
}

export function emptyTextProfile(target: string, column: string): ProfileTextOutput {
	return {
		target, column,
		count: null, nonNullCount: null, nullCount: null, distinctCount: null,
		emptyCount: null, sampleSize: 0,
		length: { min: null, max: null, avg: null, median: null },
	};
}

export const TEXT_PROFILE_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:        { type: 'string' },
		column:        { type: 'string' },
		count:         { type: ['number', 'null'] },
		nonNullCount:  { type: ['number', 'null'] },
		nullCount:     { type: ['number', 'null'] },
		distinctCount: { type: ['number', 'null'] },
		emptyCount:    { type: ['number', 'null'] },
		sampleSize:    { type: 'number' },
		length: {
			type: 'object',
			properties: {
				min:    { type: ['number', 'null'] },
				max:    { type: ['number', 'null'] },
				avg:    { type: ['number', 'null'] },
				median: { type: ['number', 'null'] },
			},
			required: ['min', 'max', 'avg', 'median'],
			additionalProperties: false,
		},
	},
	required: ['target', 'column', 'count', 'nonNullCount', 'nullCount', 'distinctCount',
	           'emptyCount', 'sampleSize', 'length'],
	additionalProperties: false,
};

export interface AggregateResultRaw {
	readonly target: string;
	readonly values: Readonly<Record<string, number | null>>;
}

export interface SampleResultRaw {
	readonly target: string;
	readonly columns: readonly string[];
	readonly rows: readonly Readonly<Record<string, unknown>>[];
}

export function isAggregateResult(v: unknown): v is AggregateResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && typeof o['values'] === 'object' && o['values'] !== null;
}

export function isSampleResult(v: unknown): v is SampleResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& Array.isArray(o['columns'])
		&& Array.isArray(o['rows']);
}
