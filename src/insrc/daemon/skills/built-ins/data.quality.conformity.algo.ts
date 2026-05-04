/**
 * Shared math + IO contract for `data.quality.conformity.{rdbms,file}`
 * (Phase 5d.4 of plans/analyzers/data-analyzer-skills.md).
 *
 * Built-in format catalog + per-format match rate scoring +
 * conformant / mostly-conformant / mixed / unrecognized / inconclusive
 * verdict. Each catalog regex is anchored so a column mixing formats
 * doesn't double-match -- tight rather than permissive.
 */

export interface FormatMatch {
	readonly format: string;
	readonly hitCount: number;
	readonly hitRate: number;
	readonly examples: readonly string[];
}

export type ConformityVerdict = 'conformant' | 'mostly-conformant' | 'mixed' | 'unrecognized' | 'inconclusive';

export interface QualityConformityOutput {
	readonly target: string;
	readonly column: string;
	readonly sampleSize: number;
	readonly matches: readonly FormatMatch[];
	readonly bestFormat: string | null;
	readonly conformityScore: number | null;
	readonly verdict: ConformityVerdict;
	readonly interpretation: string;
}

export const FORMAT_CATALOG: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
	{ name: 'iso-date',       re: /^\d{4}-\d{2}-\d{2}$/ },
	{ name: 'iso-datetime',   re: /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/ },
	{ name: 'us-date',        re: /^\d{1,2}\/\d{1,2}\/\d{4}$/ },
	{ name: 'eu-date',        re: /^\d{1,2}\.\d{1,2}\.\d{4}$/ },
	{ name: 'usd-currency',   re: /^\$?-?\d{1,3}(,\d{3})*(\.\d{2})?$/ },
	{ name: 'eur-currency',   re: /^€?-?\d{1,3}(\.\d{3})*(,\d{2})?$/ },
	{ name: 'iso-currency',   re: /^[A-Z]{3} ?-?\d+(\.\d{2})?$/ },
	{ name: 'iso-country-2',  re: /^[A-Z]{2}$/ },
	{ name: 'iso-country-3',  re: /^[A-Z]{3}$/ },
	{ name: 'us-zip',         re: /^\d{5}(-\d{4})?$/ },
	{ name: 'uk-postal',      re: /^[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}$/ },
	{ name: 'ca-postal',      re: /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/ },
	{ name: 'e164-phone',     re: /^\+\d{7,15}$/ },
];

export function clampConformitySample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 50;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

export function resolveFormats(requested: readonly string[] | undefined): typeof FORMAT_CATALOG | { error: string } {
	if (requested === undefined || requested.length === 0) return FORMAT_CATALOG;
	const filtered = FORMAT_CATALOG.filter(e => requested.includes(e.name));
	if (filtered.length === 0) {
		return { error: `no built-in format matches ${requested.join(', ')}; known: ${FORMAT_CATALOG.map(f => f.name).join(', ')}` };
	}
	return filtered;
}

export function buildConformity(
	target: string,
	column: string,
	formats: typeof FORMAT_CATALOG,
	sample: { columns: readonly string[]; rows: readonly Readonly<Record<string, unknown>>[] },
): { output: QualityConformityOutput; missingColumn: boolean } {
	if (!sample.columns.includes(column)) {
		return { output: emptyConformity(target, column), missingColumn: true };
	}

	const values: string[] = [];
	for (const row of sample.rows) {
		const v = row[column];
		if (v === null || v === undefined) continue;
		values.push(typeof v === 'string' ? v : String(v));
	}
	const n = values.length;

	const matches: FormatMatch[] = [];
	for (const { name, re } of formats) {
		let hits = 0;
		const examples: string[] = [];
		for (const v of values) {
			if (re.test(v)) {
				hits++;
				if (examples.length < 3) examples.push(v);
			}
		}
		if (hits === 0) continue;
		matches.push({
			format: name,
			hitCount: hits,
			hitRate: n > 0 ? hits / n : 0,
			examples,
		});
	}
	matches.sort((a, b) => b.hitRate - a.hitRate || a.format.localeCompare(b.format));

	const best = matches[0];
	const bestFormat = best?.format ?? null;
	const conformityScore = best?.hitRate ?? null;

	let verdict: ConformityVerdict;
	let interpretation: string;
	if (n === 0) {
		verdict = 'inconclusive';
		interpretation = 'sample produced no non-null values; cannot assess conformity';
	} else if (best === undefined) {
		verdict = 'unrecognized';
		interpretation = `none of the ${formats.length} formats matched any sampled value; the column may be free-text or use a non-canonical format`;
	} else if (best.hitRate >= 0.95) {
		verdict = 'conformant';
		interpretation = `${(best.hitRate * 100).toFixed(0)}% of sampled values match '${best.format}'`;
	} else if (best.hitRate >= 0.7) {
		verdict = 'mostly-conformant';
		interpretation = `${(best.hitRate * 100).toFixed(0)}% of sampled values match '${best.format}'; remainder may be malformed or use a different format`;
	} else {
		verdict = 'mixed';
		const others = matches.slice(1, 3).map(m => `${m.format} ${(m.hitRate * 100).toFixed(0)}%`).join(', ');
		interpretation = `top format '${best.format}' only at ${(best.hitRate * 100).toFixed(0)}%${others ? `; also: ${others}` : ''}; column likely mixes formats`;
	}

	return {
		output: {
			target,
			column,
			sampleSize: n,
			matches,
			bestFormat,
			conformityScore,
			verdict,
			interpretation,
		},
		missingColumn: false,
	};
}

export function emptyConformity(target: string, column: string): QualityConformityOutput {
	return {
		target, column,
		sampleSize: 0,
		matches: [],
		bestFormat: null,
		conformityScore: null,
		verdict: 'inconclusive',
		interpretation: '',
	};
}

const FORMAT_SCHEMA = {
	type: 'object',
	properties: {
		format:   { type: 'string' },
		hitCount: { type: 'number' },
		hitRate:  { type: 'number' },
		examples: { type: 'array', items: { type: 'string' } },
	},
	required: ['format', 'hitCount', 'hitRate', 'examples'],
	additionalProperties: false,
} as const;

export const CONFORMITY_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:           { type: 'string' },
		column:           { type: 'string' },
		sampleSize:       { type: 'number' },
		matches:          { type: 'array', items: FORMAT_SCHEMA },
		bestFormat:       { type: ['string', 'null'] },
		conformityScore:  { type: ['number', 'null'] },
		verdict:          { type: 'string', enum: ['conformant', 'mostly-conformant', 'mixed', 'unrecognized', 'inconclusive'] },
		interpretation:   { type: 'string' },
	},
	required: ['target', 'column', 'sampleSize', 'matches',
	           'bestFormat', 'conformityScore', 'verdict', 'interpretation'],
	additionalProperties: false,
};
