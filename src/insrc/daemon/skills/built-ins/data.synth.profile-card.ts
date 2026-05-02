/**
 * data.synth.profile-card -- Phase 6.7 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Pure-template skill: renders any of the five univariate profile
 * shapes (numeric / categorical / boolean / temporal / text) as a
 * markdown card. Branches on the `kind` discriminator. The input
 * shape mirrors `data.profile.auto.rdbms`'s output -- callers with
 * a raw atomic profile result wrap it as `{ kind, profile }`
 * before calling this renderer.
 *
 * Each card layout:
 *
 *   numeric     header + 2-col metric/value table
 *   categorical header + count summary + top-N values table
 *   boolean     header + true/false/null/other counts + true ratio
 *   temporal    header + cardinality + the "min/max deferred" note
 *   text        header + cardinality + length stats
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

type ProfileKind = 'numeric' | 'text' | 'boolean' | 'temporal' | 'categorical';

interface ProfileCardInput {
	readonly kind: ProfileKind;
	readonly profile: Readonly<Record<string, unknown>>;
	/** Optional override; if omitted, taken from the inner profile. */
	readonly column?: string;
	readonly target?: string;
}

interface ProfileCardOutput {
	readonly markdown: string;
}

const skill: Skill<ProfileCardInput, ProfileCardOutput> = {
	id: 'data.synth.profile-card',
	name: 'Synth: profile card',
	description:
		'Render a univariate column profile (numeric / categorical / boolean / temporal / text) as a markdown ' +
		'card. Branches on the `kind` discriminator -- mirrors profile.auto.rdbms\'s output shape. Pair with ' +
		'profile.auto or wrap a raw atomic profile as { kind, profile }.',
	family: 'synthesis',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			kind:    { type: 'string', enum: ['numeric', 'text', 'boolean', 'temporal', 'categorical'] },
			profile: { type: 'object' },
			column:  { type: 'string' },
			target:  { type: 'string' },
		},
		required: ['kind', 'profile'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: { markdown: { type: 'string' } },
		required: ['markdown'],
		additionalProperties: false,
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input): Promise<SkillResult<ProfileCardOutput>> {
		const p = input.profile;
		const target = input.target ?? readString(p, 'target') ?? '?';
		const column = input.column ?? readString(p, 'column') ?? '?';
		const header = `**${target}** \`${column}\` -- profile (${input.kind})`;

		let body: string;
		switch (input.kind) {
			case 'numeric':     body = renderNumeric(p);     break;
			case 'categorical': body = renderCategorical(p); break;
			case 'boolean':     body = renderBoolean(p);     break;
			case 'temporal':    body = renderTemporal(p);    break;
			case 'text':        body = renderText(p);        break;
		}

		return {
			value: { markdown: `${header}\n\n${body}` },
			confidence: 'high',
			toolCalls: [],
		};
	},
};

function renderNumeric(p: Readonly<Record<string, unknown>>): string {
	const rows: [string, string][] = [
		['count',         fmtNum(p['count'])],
		['non-null',      fmtNum(p['nonNullCount'])],
		['null',          fmtNum(p['nullCount'])],
		['distinct',      fmtNum(p['distinctCount'])],
		['min',           fmtNum(p['min'])],
		['max',           fmtNum(p['max'])],
		['avg',           fmtNum(p['avg'])],
		['stddev',        fmtNum(p['stddev'])],
		['variance',      fmtNum(p['variance'])],
		['p50 (median)',  fmtNum(p['p50'])],
		['p95',           fmtNum(p['p95'])],
	];
	return ['| metric | value |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
}

function renderCategorical(p: Readonly<Record<string, unknown>>): string {
	const lines: string[] = [
		`count: **${fmtNum(p['count'])}**, ` +
		`non-null: **${fmtNum(p['nonNullCount'])}**, ` +
		`null: **${fmtNum(p['nullCount'])}**, ` +
		`distinct: **${fmtNum(p['distinctCount'])}**`,
	];
	const top = readArray(p, 'topValues');
	if (top.length === 0) {
		lines.push('', '_(no top values)_');
		return lines.join('\n');
	}
	lines.push('', '| value | count | frequency |', '|---|---|---|');
	for (const v of top) {
		const obj = v as Record<string, unknown>;
		const value = obj['value'];
		const count = obj['count'];
		const freq  = obj['frequency'];
		const valueStr = value === null || value === undefined ? '_null_' : String(value);
		const freqStr  = typeof freq === 'number' ? `${(freq * 100).toFixed(1)}%` : '-';
		lines.push(`| ${valueStr} | ${fmtNum(count)} | ${freqStr} |`);
	}
	return lines.join('\n');
}

function renderBoolean(p: Readonly<Record<string, unknown>>): string {
	const rows: [string, string][] = [
		['true',        fmtNum(p['trueCount'])],
		['false',       fmtNum(p['falseCount'])],
		['null',        fmtNum(p['nullCount'])],
		['other',       fmtNum(p['otherCount'])],
		['true ratio',  formatRatio(p['trueRatio'])],
	];
	return ['| metric | value |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
}

function renderTemporal(p: Readonly<Record<string, unknown>>): string {
	const rows: [string, string][] = [
		['count',     fmtNum(p['count'])],
		['non-null',  fmtNum(p['nonNullCount'])],
		['null',      fmtNum(p['nullCount'])],
		['distinct',  fmtNum(p['distinctCount'])],
	];
	const note = '_min / max range + gap / period inference deferred until a type-aware aggregation surface lands_';
	return [
		'| metric | value |', '|---|---|',
		...rows.map(([k, v]) => `| ${k} | ${v} |`),
		'', note,
	].join('\n');
}

function renderText(p: Readonly<Record<string, unknown>>): string {
	const length = (p['length'] ?? {}) as Record<string, unknown>;
	const sampleSize = readNumber(p, 'sampleSize');
	const rows: [string, string][] = [
		['count',         fmtNum(p['count'])],
		['non-null',      fmtNum(p['nonNullCount'])],
		['null',          fmtNum(p['nullCount'])],
		['distinct',      fmtNum(p['distinctCount'])],
		['empty (sample)', fmtNum(p['emptyCount'])],
		[`length min (n=${sampleSize ?? 0})`,    fmtNum(length['min'])],
		[`length max (n=${sampleSize ?? 0})`,    fmtNum(length['max'])],
		[`length avg (n=${sampleSize ?? 0})`,    fmtNum(length['avg'])],
		[`length median (n=${sampleSize ?? 0})`, fmtNum(length['median'])],
	];
	return ['| metric | value |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
}

// -- helpers --

function fmtNum(v: unknown): string {
	if (v === null || v === undefined) return '_null_';
	if (typeof v === 'number') {
		if (!Number.isFinite(v)) return '_NaN_';
		if (Number.isInteger(v)) return v.toLocaleString('en-US');
		return v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
	}
	if (typeof v === 'bigint') return v.toString();
	return String(v);
}

function formatRatio(v: unknown): string {
	if (v === null || v === undefined) return '_null_';
	if (typeof v !== 'number' || !Number.isFinite(v)) return '_NaN_';
	return `${(v * 100).toFixed(1)}%`;
}

function readString(o: Readonly<Record<string, unknown>>, key: string): string | undefined {
	const v = o[key];
	return typeof v === 'string' ? v : undefined;
}

function readNumber(o: Readonly<Record<string, unknown>>, key: string): number | undefined {
	const v = o[key];
	return typeof v === 'number' ? v : undefined;
}

function readArray(o: Readonly<Record<string, unknown>>, key: string): readonly unknown[] {
	const v = o[key];
	return Array.isArray(v) ? v : [];
}

export function registerDataSynthProfileCardSkill(): void {
	registerSkill(skill as unknown as Skill);
}
