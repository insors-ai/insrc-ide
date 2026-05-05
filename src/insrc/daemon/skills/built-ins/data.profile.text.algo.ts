/**
 * Shared math + IO contract for `data.profile.text.{rdbms,file}`
 * (Phase 5a.4 of plans/analyzers/data-analyzer-skills.md).
 *
 * Both transport wrappers ask `db_*_aggregate` for count + non-null
 * + distinct, and `db_*_sample` for up to N rows so we can compute
 * length statistics + encoding signals client-side. Length is
 * sample-based because the current aggregate tool surface doesn't
 * expose `LENGTH()`; the algo file is the single place that knows.
 *
 * Encoding detection is also sample-based and operates on the
 * already-decoded JS strings -- raw byte access from the driver is
 * not exposed. The signals we surface from JS strings:
 *   - asciiOnly            all chars < 0x80
 *   - nonAsciiCount/Rate   chars >= 0x80 (any non-ASCII)
 *   - astralPresent        surrogate pairs (emoji / supplementary plane)
 *   - controlCharCount     chars \x00-\x1F (excluding \t \n \r); usually
 *                          binary data leaking into a text column
 *   - bomCount             values starting with U+FEFF (UTF-8 BOM
 *                          survived an upstream decode incorrectly)
 *   - mojibakeSuspectCount values with Latin-1-decoded-as-UTF-8 byte
 *                          patterns (`Ã©` `Ã±` `â€™` etc.) -- a
 *                          tell-tale sign of double-decoding.
 *
 * A single `verdict` field rolls those up into the most actionable
 * label: 'ascii' / 'utf8-clean' / 'has-bom' / 'control-chars-present'
 * / 'mojibake-suspect' / 'inconclusive' (empty sample).
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

export type EncodingVerdict =
	| 'ascii'
	| 'utf8-clean'
	| 'has-bom'
	| 'control-chars-present'
	| 'mojibake-suspect'
	| 'inconclusive';

export interface EncodingSignals {
	readonly asciiOnly: boolean;
	readonly nonAsciiCount: number;
	readonly nonAsciiRate: number;
	readonly totalChars: number;
	readonly astralPresent: boolean;
	readonly controlCharCount: number;
	readonly bomCount: number;
	readonly mojibakeSuspectCount: number;
	readonly verdict: EncodingVerdict;
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
	readonly encoding: EncodingSignals;
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
	aggValues: Readonly<Record<string, number | string | null>>,
	sample: { columns: readonly string[]; rows: readonly Readonly<Record<string, unknown>>[] },
): ProfileTextOutput {
	const count = numericFromAgg(aggValues[`${column}__count`]);
	const nonNullCount = numericFromAgg(aggValues[`${column}__count_non_null`]);
	const nullCount = (count !== null && nonNullCount !== null) ? count - nonNullCount : null;
	const distinctCount = numericFromAgg(aggValues[`${column}__distinct_count`]);

	let emptyCount = 0;
	const lengths: number[] = [];
	const sampledStrings: string[] = [];
	const present = sample.columns.includes(column);
	if (present) {
		for (const row of sample.rows) {
			const v = row[column];
			if (v === null || v === undefined) continue;
			const s = typeof v === 'string' ? v : String(v);
			if (s.length === 0) emptyCount++;
			lengths.push(s.length);
			sampledStrings.push(s);
		}
	}
	const length = computeLengthStats(lengths);
	const encoding = computeEncodingSignals(sampledStrings);

	return {
		target, column,
		count, nonNullCount, nullCount, distinctCount,
		emptyCount: present ? emptyCount : null,
		sampleSize: lengths.length,
		length,
		encoding,
	};
}

function numericFromAgg(v: number | string | null | undefined): number | null {
	if (v === null || v === undefined) return null;
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/**
 * Compute encoding signals from a sample of JS strings. By the time
 * values reach JS, they're already decoded -- but several useful
 * signals survive that decode and tell the caller whether the column
 * is plain ASCII, clean UTF-8 with non-Latin chars, or carrying
 * encoding artifacts (BOM, mojibake, control chars).
 */
export function _computeEncodingSignalsForTest(values: readonly string[]): EncodingSignals {
	return computeEncodingSignals(values);
}

function computeEncodingSignals(values: readonly string[]): EncodingSignals {
	if (values.length === 0) {
		return {
			asciiOnly: true, nonAsciiCount: 0, nonAsciiRate: 0,
			totalChars: 0, astralPresent: false,
			controlCharCount: 0, bomCount: 0, mojibakeSuspectCount: 0,
			verdict: 'inconclusive',
		};
	}
	let totalChars = 0;
	let nonAsciiCount = 0;
	let astralPresent = false;
	let controlCharCount = 0;
	let bomCount = 0;
	let mojibakeSuspectCount = 0;
	// Mojibake markers: Latin-1 decoded as UTF-8 produces these byte
	// pairs as JS strings. They're rare in legitimate text, common in
	// columns that round-tripped through a Latin-1 / UTF-8 mismatch.
	// Anchored as a regex; one match per VALUE is enough to flag.
	const mojibakeRe = /Ã[-¿]|â[¦]|Â[-¿]/;
	for (const s of values) {
		if (s.length > 0 && s.charCodeAt(0) === 0xFEFF) bomCount++;
		if (mojibakeRe.test(s)) mojibakeSuspectCount++;
		// Iterate by code point (Array.from handles surrogate pairs).
		for (const ch of s) {
			totalChars++;
			const cp = ch.codePointAt(0)!;
			if (cp >= 0x10000) astralPresent = true;
			if (cp >= 0x80) nonAsciiCount++;
			// Control chars: \x00-\x1F minus \t \n \r, plus DEL (\x7F).
			if ((cp < 0x20 && cp !== 0x09 && cp !== 0x0A && cp !== 0x0D) || cp === 0x7F) {
				controlCharCount++;
			}
		}
	}
	const asciiOnly = nonAsciiCount === 0;
	const nonAsciiRate = totalChars > 0 ? nonAsciiCount / totalChars : 0;

	let verdict: EncodingVerdict;
	if (mojibakeSuspectCount > 0) verdict = 'mojibake-suspect';
	else if (controlCharCount > 0) verdict = 'control-chars-present';
	else if (bomCount > 0) verdict = 'has-bom';
	else if (asciiOnly) verdict = 'ascii';
	else verdict = 'utf8-clean';

	return {
		asciiOnly, nonAsciiCount, nonAsciiRate, totalChars,
		astralPresent, controlCharCount, bomCount, mojibakeSuspectCount,
		verdict,
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
		encoding: {
			asciiOnly: true, nonAsciiCount: 0, nonAsciiRate: 0,
			totalChars: 0, astralPresent: false,
			controlCharCount: 0, bomCount: 0, mojibakeSuspectCount: 0,
			verdict: 'inconclusive',
		},
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
		encoding: {
			type: 'object',
			properties: {
				asciiOnly:            { type: 'boolean' },
				nonAsciiCount:        { type: 'number' },
				nonAsciiRate:         { type: 'number' },
				totalChars:           { type: 'number' },
				astralPresent:        { type: 'boolean' },
				controlCharCount:     { type: 'number' },
				bomCount:             { type: 'number' },
				mojibakeSuspectCount: { type: 'number' },
				verdict: { type: 'string', enum: ['ascii', 'utf8-clean', 'has-bom', 'control-chars-present', 'mojibake-suspect', 'inconclusive'] },
			},
			required: ['asciiOnly', 'nonAsciiCount', 'nonAsciiRate', 'totalChars',
			           'astralPresent', 'controlCharCount', 'bomCount', 'mojibakeSuspectCount', 'verdict'],
			additionalProperties: false,
		},
	},
	required: ['target', 'column', 'count', 'nonNullCount', 'nullCount', 'distinctCount',
	           'emptyCount', 'sampleSize', 'length', 'encoding'],
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
