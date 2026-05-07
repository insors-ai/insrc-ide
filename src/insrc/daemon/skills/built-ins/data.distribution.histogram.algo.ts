/**
 * Shared output contract for `data.distribution.histogram.{rdbms,file}`
 * (Phase 5b.1 of plans/analyzers/data-analyzer-skills.md).
 *
 * The math is entirely server-side -- both wrappers call
 * `db_*_histogram` which returns the bounds + bucket counts directly.
 * This module is intentionally thin: it normalises the tool result
 * into the skill's output shape, derives a top-level verdict, and
 * exposes a single output JsonSchema both wrappers cite.
 */

export type HistogramMode = 'equal-width' | 'equal-frequency';

export type HistogramVerdict = 'has-data' | 'empty' | 'inconclusive';

export interface HistogramBucket {
	readonly lower: number;
	readonly upper: number;
	readonly count: number;
}

export interface HistogramOutput {
	readonly target: string;
	readonly column: string;
	readonly mode: HistogramMode;
	readonly bucketsRequested: number;
	readonly bounds: { readonly lower: number | null; readonly upper: number | null };
	readonly nonNullCount: number;
	readonly nullCount: number;
	readonly buckets: readonly HistogramBucket[];
	readonly verdict: HistogramVerdict;
}

export const HISTOGRAM_DEFAULT_BUCKETS = 20;
export const HISTOGRAM_MAX_BUCKETS = 200;

export function clampBuckets(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return HISTOGRAM_DEFAULT_BUCKETS;
	return Math.min(Math.max(2, Math.floor(n)), HISTOGRAM_MAX_BUCKETS);
}

export function normalizeMode(mode: string | undefined): HistogramMode {
	return mode === 'equal-frequency' ? 'equal-frequency' : 'equal-width';
}

export interface HistogramToolResult {
	readonly target: string;
	readonly column: string;
	readonly mode: HistogramMode;
	readonly bounds: { readonly lower: number | null; readonly upper: number | null };
	readonly buckets: readonly HistogramBucket[];
	readonly nonNullCount: number;
	readonly nullCount: number;
}

export function isHistogramToolResult(v: unknown): v is HistogramToolResult {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['column'] === 'string'
		&& (o['mode'] === 'equal-width' || o['mode'] === 'equal-frequency')
		&& typeof o['bounds'] === 'object' && o['bounds'] !== null
		&& Array.isArray(o['buckets'])
		&& typeof o['nonNullCount'] === 'number'
		&& typeof o['nullCount'] === 'number';
}

export function buildHistogramOutput(
	tool: HistogramToolResult,
	bucketsRequested: number,
): HistogramOutput {
	const verdict: HistogramVerdict =
		tool.nonNullCount === 0 ? 'empty'
		: tool.buckets.length === 0 ? 'inconclusive'
		: 'has-data';
	return {
		target:           tool.target,
		column:           tool.column,
		mode:             tool.mode,
		bucketsRequested,
		bounds:           tool.bounds,
		nonNullCount:     tool.nonNullCount,
		nullCount:        tool.nullCount,
		buckets:          tool.buckets,
		verdict,
	};
}

export function emptyHistogram(
	target: string,
	column: string,
	mode: HistogramMode,
	bucketsRequested: number,
): HistogramOutput {
	return {
		target, column, mode, bucketsRequested,
		bounds: { lower: null, upper: null },
		nonNullCount: 0, nullCount: 0,
		buckets: [],
		verdict: 'inconclusive',
	};
}

export const HISTOGRAM_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:           { type: 'string' },
		column:           { type: 'string' },
		mode:             { type: 'string', enum: ['equal-width', 'equal-frequency'] },
		bucketsRequested: { type: 'number' },
		bounds: {
			type: 'object',
			properties: {
				lower: { type: ['number', 'null'] },
				upper: { type: ['number', 'null'] },
			},
			required: ['lower', 'upper'],
			additionalProperties: false,
		},
		nonNullCount:    { type: 'number' },
		nullCount:       { type: 'number' },
		buckets: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					lower: { type: 'number' },
					upper: { type: 'number' },
					count: { type: 'number' },
				},
				required: ['lower', 'upper', 'count'],
				additionalProperties: false,
			},
		},
		verdict: { type: 'string', enum: ['has-data', 'empty', 'inconclusive'] },
	},
	required: ['target', 'column', 'mode', 'bucketsRequested', 'bounds',
	           'nonNullCount', 'nullCount', 'buckets', 'verdict'],
	additionalProperties: false,
};
