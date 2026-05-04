/**
 * Shared math + IO contract for `data.drift.volume.{rdbms,file}`
 * (Phase 5f.2 of plans/analyzers/data-analyzer-skills.md).
 *
 * Row-volume drift between two windows. Caller defines windows A / B
 * via WhereClause arrays; the wrapping skill counts rows in each via
 * a `count_non_null` aggregate over a single column. This module
 * holds the verdict math + schema; transport (db_sql_aggregate vs
 * db_file_aggregate) lives in the variants.
 *
 * Verdict ladder (abs(percentChange)):
 *   stable             < 10%
 *   minor-change       10% .. 25%
 *   significant-drop   <= -25%
 *   significant-spike  >= +25%
 *   inconclusive       countA = 0 (no baseline to compare against)
 */

export interface DriftVolumeWhereClauseIn {
	readonly column: string;
	readonly op: '=' | '!=' | 'in' | 'is null';
	readonly value?: unknown;
}

export type DriftVolumeVerdict = 'stable' | 'minor-change' | 'significant-drop' | 'significant-spike' | 'inconclusive';

export interface DriftVolumeOutput {
	readonly target: string;
	readonly countColumn: string;
	readonly windowA: { readonly count: number | null };
	readonly windowB: { readonly count: number | null };
	readonly absoluteChange: number | null;
	readonly relativeChange: number | null;
	readonly percentChange: number | null;
	readonly ratio: number | null;
	readonly verdict: DriftVolumeVerdict;
	readonly interpretation: string;
}

export function emptyDriftVolume(target: string, countColumn: string): DriftVolumeOutput {
	return {
		target,
		countColumn,
		windowA: { count: null },
		windowB: { count: null },
		absoluteChange: null,
		relativeChange: null,
		percentChange:  null,
		ratio:          null,
		verdict: 'inconclusive',
		interpretation: '',
	};
}

export function buildDriftVolume(
	target: string,
	countColumn: string,
	countA: number | null,
	countB: number | null,
): { output: DriftVolumeOutput; degradedConfidence: 'medium' | null } {
	if (countA === null || countB === null) {
		return {
			output: {
				...emptyDriftVolume(target, countColumn),
				windowA: { count: countA },
				windowB: { count: countB },
				interpretation: 'count_non_null returned null for one or both windows; cannot compute drift',
			},
			degradedConfidence: 'medium',
		};
	}

	const absoluteChange = countB - countA;
	let relativeChange: number | null;
	let percentChange:  number | null;
	let ratio:          number | null;
	let verdict: DriftVolumeVerdict;

	if (countA === 0) {
		relativeChange = null;
		percentChange  = null;
		ratio          = null;
		verdict = countB === 0 ? 'stable' : 'inconclusive';
	} else {
		relativeChange = (countB - countA) / countA;
		percentChange  = relativeChange * 100;
		ratio          = countB / countA;
		const absPct = Math.abs(percentChange);
		if (absPct < 10) verdict = 'stable';
		else if (absPct < 25) verdict = 'minor-change';
		else if (percentChange < 0) verdict = 'significant-drop';
		else verdict = 'significant-spike';
	}

	const interpretation = describe(verdict, countA, countB, percentChange);

	return {
		output: {
			target,
			countColumn,
			windowA: { count: countA },
			windowB: { count: countB },
			absoluteChange, relativeChange, percentChange, ratio,
			verdict,
			interpretation,
		},
		degradedConfidence: null,
	};
}

function describe(verdict: DriftVolumeVerdict, a: number, b: number, pct: number | null): string {
	if (verdict === 'stable' && a === 0 && b === 0) {
		return 'both windows empty (0 rows each); no production to compare';
	}
	if (verdict === 'inconclusive') {
		return `window A is empty (0 rows) but window B has ${b}; cannot compute relative change from zero baseline (treat as 'from-zero spike' qualitatively)`;
	}
	const dir = (pct ?? 0) >= 0 ? '+' : '';
	const pctStr = pct === null ? 'n/a' : `${dir}${pct.toFixed(1)}%`;
	switch (verdict) {
		case 'stable':            return `stable: ${a} -> ${b} rows (${pctStr})`;
		case 'minor-change':      return `minor change: ${a} -> ${b} rows (${pctStr})`;
		case 'significant-drop':  return `significant drop: ${a} -> ${b} rows (${pctStr}); investigate for outage / pipeline failure / filter regression`;
		case 'significant-spike': return `significant spike: ${a} -> ${b} rows (${pctStr}); investigate for surge / replay / duplicate ingestion`;
		default:                  return '';
	}
}

export const DRIFT_VOLUME_WHERE_SCHEMA = {
	type: 'array',
	items: {
		type: 'object',
		properties: {
			column: { type: 'string' },
			op:     { type: 'string', enum: ['=', '!=', 'in', 'is null'] },
			value:  {},
		},
		required: ['column', 'op'],
		additionalProperties: false,
	},
} as const;

export const DRIFT_VOLUME_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:      { type: 'string' },
		countColumn: { type: 'string' },
		windowA: {
			type: 'object',
			properties: { count: { type: ['number', 'null'] } },
			required: ['count'],
			additionalProperties: false,
		},
		windowB: {
			type: 'object',
			properties: { count: { type: ['number', 'null'] } },
			required: ['count'],
			additionalProperties: false,
		},
		absoluteChange: { type: ['number', 'null'] },
		relativeChange: { type: ['number', 'null'] },
		percentChange:  { type: ['number', 'null'] },
		ratio:          { type: ['number', 'null'] },
		verdict:        { type: 'string', enum: ['stable', 'minor-change', 'significant-drop', 'significant-spike', 'inconclusive'] },
		interpretation: { type: 'string' },
	},
	required: ['target', 'countColumn', 'windowA', 'windowB',
	           'absoluteChange', 'relativeChange', 'percentChange', 'ratio',
	           'verdict', 'interpretation'],
	additionalProperties: false,
};

interface DescribeColumn {
	readonly name: string;
	readonly nullable?: boolean;
	readonly primaryKey?: boolean;
}

export function pickCountColumn(cols: readonly DescribeColumn[]): string | null {
	const pk = cols.find(c => c.primaryKey === true);
	if (pk) return pk.name;
	const nonNullable = cols.find(c => c.nullable === false);
	if (nonNullable) return nonNullable.name;
	return null;
}
