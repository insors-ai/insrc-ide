/**
 * data.quality.conformity.rdbms -- Phase 5d.4 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic quality skill: checks one column's sampled values against
 * a built-in catalog of canonical formats (dates, currencies,
 * country codes, postal codes, phone numbers). Returns the per-
 * format match rate, the best-fitting format, and a conformity
 * verdict.
 *
 * Companion to `data.quality.validity.rdbms`:
 *   - validity.rdbms takes a caller-supplied regex (free-form
 *     domain check)
 *   - conformity.rdbms uses a built-in format catalog (matches
 *     known real-world shapes without the caller knowing the regex)
 *
 * The catalog is intentionally tight: each entry is anchored
 * (`^...$`) so a column mixing multiple formats produces partial
 * matches rather than spurious 100% hit rates. Formats the caller
 * doesn't recognise as relevant can be filtered via `formats:
 * string[]` to narrow the scan.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

interface ConformityInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly sampleSize?: number;
	/** Optional allowlist of format names; default = all built-in formats. */
	readonly formats?: readonly string[];
}

interface FormatMatch {
	readonly format: string;
	readonly hitCount: number;
	readonly hitRate: number;
	readonly examples: readonly string[];
}

type Verdict = 'conformant' | 'mostly-conformant' | 'mixed' | 'unrecognized' | 'inconclusive';

interface ConformityOutput {
	readonly target: string;
	readonly column: string;
	readonly sampleSize: number;
	readonly matches: readonly FormatMatch[];
	readonly bestFormat: string | null;
	readonly conformityScore: number | null;
	readonly verdict: Verdict;
	readonly interpretation: string;
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

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

/**
 * Built-in format catalog. Each entry is anchored so a column
 * mixing formats doesn't double-match. Tight rather than permissive
 * -- we tolerate false negatives over false positives.
 */
const FORMAT_CATALOG: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
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

const skill: Skill<ConformityInput, ConformityOutput> = {
	id: 'data.quality.conformity.rdbms',
	name: 'Quality: format conformity (RDBMS)',
	description:
		'Checks one column against a catalog of canonical formats: iso-date, iso-datetime, us-date, ' +
		'eu-date, usd-currency, eur-currency, iso-currency, iso-country-2/3, us-zip, uk-postal, ca-postal, ' +
		'e164-phone. Returns per-format hit rates + the best-fitting format + a conformity verdict ' +
		'(conformant / mostly-conformant / mixed / unrecognized / inconclusive). Pairs with ' +
		'`data.quality.validity.rdbms` -- this skill picks a known format; validity validates a custom regex.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
			formats:      { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Optional allowlist of format names; default = all 13 built-ins.' },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: {
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
	},
	toolDeps: ['db_sql_sample'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_sample'],
			reason: 'sole tool that supplies the value sample we regex over',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<ConformityOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampSample(input.sampleSize);

		// Filter the catalog to caller-requested formats (or use all
		// when omitted). Unknown names get a clear error rather than
		// silently doing nothing.
		const requested = input.formats !== undefined && input.formats.length > 0
			? FORMAT_CATALOG.filter(e => input.formats!.includes(e.name))
			: FORMAT_CATALOG;
		if (input.formats !== undefined && requested.length === 0) {
			return {
				value: empty(input.target, input.column),
				confidence: 'low',
				notes: [`no built-in format matches ${input.formats.join(', ')}; known: ${FORMAT_CATALOG.map(f => f.name).join(', ')}`],
				toolCalls: [],
			};
		}

		const tool = await deps.runTool({
			id: callId,
			name: 'db_sql_sample',
			input: {
				connectionId: input.connectionId,
				target: input.target,
				limit: sampleSize,
			},
		});

		if (tool.isError) {
			return {
				value: empty(input.target, input.column),
				confidence: 'low',
				notes: [`db_sql_sample error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		const data = tool.data;
		if (!isSampleResult(data)) {
			return {
				value: empty(input.target, input.column),
				confidence: 'low',
				notes: ['db_sql_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}
		if (!data.columns.includes(input.column)) {
			return {
				value: empty(input.target, input.column),
				confidence: 'low',
				notes: [`column '${input.column}' not present in sample (available: ${data.columns.join(', ')})`],
				toolCalls: [],
			};
		}

		const values: string[] = [];
		for (const row of data.rows) {
			const v = row[input.column];
			if (v === null || v === undefined) continue;
			values.push(typeof v === 'string' ? v : String(v));
		}
		const n = values.length;

		const matches: FormatMatch[] = [];
		for (const { name, re } of requested) {
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

		let verdict: Verdict;
		let interpretation: string;
		if (n === 0) {
			verdict = 'inconclusive';
			interpretation = 'sample produced no non-null values; cannot assess conformity';
		} else if (best === undefined) {
			verdict = 'unrecognized';
			interpretation = `none of the ${requested.length} formats matched any sampled value; the column may be free-text or use a non-canonical format`;
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
			value: {
				target: data.target,
				column: input.column,
				sampleSize: n,
				matches,
				bestFormat,
				conformityScore,
				verdict,
				interpretation,
			},
			// `high` when the verdict is decisive (conformant, mostly-,
			// or unrecognized -- all are clear signals); `medium` for
			// mixed (we have data but no clear winner) and inconclusive.
			confidence: verdict === 'mixed' || verdict === 'inconclusive' ? 'medium' : 'high',
			toolCalls: [],
		};
	},
};

function clampSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 50;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

function empty(target: string, column: string): ConformityOutput {
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

interface SampleResultRaw {
	readonly target: string;
	readonly columns: readonly string[];
	readonly rows: readonly Readonly<Record<string, unknown>>[];
}

function isSampleResult(v: unknown): v is SampleResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& Array.isArray(o['columns'])
		&& Array.isArray(o['rows']);
}

export function registerDataQualityConformityRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
