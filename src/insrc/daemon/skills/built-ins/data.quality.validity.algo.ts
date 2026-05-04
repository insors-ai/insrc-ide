/**
 * Shared math + IO contract for `data.quality.validity.{rdbms,file}`
 * (Phase 5d.3 of plans/analyzers/data-analyzer-skills.md).
 */

export interface QualityValidityOutput {
	readonly target: string;
	readonly column: string;
	readonly pattern: string;
	readonly sampleSize: number;
	readonly matchCount: number;
	readonly mismatchCount: number;
	readonly matchRate: number | null;
	readonly score: number | null;
	readonly examples: { readonly matched: readonly string[]; readonly mismatched: readonly string[] };
}

export function clampValiditySample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 50;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

export function buildValidity(
	target: string,
	column: string,
	pattern: string,
	re: RegExp,
	sample: { columns: readonly string[]; rows: readonly Readonly<Record<string, unknown>>[] },
): { output: QualityValidityOutput; missingColumn: boolean } {
	if (!sample.columns.includes(column)) {
		return { output: emptyValidity(target, column, pattern), missingColumn: true };
	}
	let matchCount = 0;
	let mismatchCount = 0;
	const matched: string[] = [];
	const mismatched: string[] = [];
	for (const row of sample.rows) {
		const v = row[column];
		if (v === null || v === undefined) continue;
		const s = typeof v === 'string' ? v : String(v);
		if (re.test(s)) {
			matchCount++;
			if (matched.length < 3) matched.push(s);
		} else {
			mismatchCount++;
			if (mismatched.length < 3) mismatched.push(s);
		}
	}
	const total = matchCount + mismatchCount;
	const matchRate = total > 0 ? matchCount / total : null;
	return {
		output: {
			target, column, pattern,
			sampleSize: total, matchCount, mismatchCount,
			matchRate, score: matchRate,
			examples: { matched, mismatched },
		},
		missingColumn: false,
	};
}

export function emptyValidity(target: string, column: string, pattern: string): QualityValidityOutput {
	return {
		target, column, pattern,
		sampleSize: 0, matchCount: 0, mismatchCount: 0,
		matchRate: null, score: null,
		examples: { matched: [], mismatched: [] },
	};
}

export const VALIDITY_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:        { type: 'string' },
		column:        { type: 'string' },
		pattern:       { type: 'string' },
		sampleSize:    { type: 'number' },
		matchCount:    { type: 'number' },
		mismatchCount: { type: 'number' },
		matchRate:     { type: ['number', 'null'] },
		score:         { type: ['number', 'null'] },
		examples: {
			type: 'object',
			properties: {
				matched:    { type: 'array', items: { type: 'string' } },
				mismatched: { type: 'array', items: { type: 'string' } },
			},
			required: ['matched', 'mismatched'],
			additionalProperties: false,
		},
	},
	required: ['target', 'column', 'pattern', 'sampleSize', 'matchCount', 'mismatchCount',
	           'matchRate', 'score', 'examples'],
	additionalProperties: false,
};
