/**
 * data.synth.histogram-block -- Phase 6.9 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Pure-template skill: renders the output of
 * `data.distribution.histogram.{rdbms,file}` as a markdown block --
 * header line, summary counts, and an ASCII bar chart inside a
 * fenced code block (monospace-friendly so the bar widths align in
 * any markdown renderer). Verdict-aware: empty / inconclusive
 * histograms render a one-line note instead of an empty chart.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

interface HistogramBucketIn {
	readonly lower: number;
	readonly upper: number;
	readonly count: number;
}

interface HistogramBlockInput {
	readonly target: string;
	readonly column: string;
	readonly mode: 'equal-width' | 'equal-frequency';
	readonly bucketsRequested?: number;
	readonly bounds: { readonly lower: number | null; readonly upper: number | null };
	readonly nonNullCount: number;
	readonly nullCount: number;
	readonly buckets: readonly HistogramBucketIn[];
	readonly verdict: 'has-data' | 'empty' | 'inconclusive';
}

interface HistogramBlockOutput {
	readonly markdown: string;
}

const MAX_BAR_WIDTH = 40;

const skill: Skill<HistogramBlockInput, HistogramBlockOutput> = {
	id: 'data.synth.histogram-block',
	name: 'Synth: histogram block',
	description:
		'Render a histogram (output of data.distribution.histogram.rdbms / .file) as a markdown block: ' +
		'header, summary counts, ASCII bar chart with proportional widths inside a fenced code block. ' +
		'Empty / inconclusive verdicts render a one-line note instead of a chart.',
	family: 'synthesis',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
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
			nonNullCount: { type: 'number' },
			nullCount:    { type: 'number' },
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
		required: ['target', 'column', 'mode', 'bounds', 'nonNullCount', 'nullCount', 'buckets', 'verdict'],
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

	async execute(input): Promise<SkillResult<HistogramBlockOutput>> {
		const lines: string[] = [];
		lines.push(`**${input.target}** \`${input.column}\` -- histogram (${input.mode})`);
		lines.push('');
		lines.push(
			`non-null: **${fmtCount(input.nonNullCount)}**, ` +
			`null: **${fmtCount(input.nullCount)}**, ` +
			`buckets: **${input.buckets.length}**` +
			(input.bounds.lower !== null && input.bounds.upper !== null
				? `, range: **[${fmtNum(input.bounds.lower)}, ${fmtNum(input.bounds.upper)}]**`
				: ''),
		);

		if (input.verdict === 'empty') {
			lines.push('', '_no non-null values in this column_');
			return ok(lines);
		}
		if (input.verdict === 'inconclusive' || input.buckets.length === 0) {
			lines.push('', '_histogram inconclusive (no buckets returned)_');
			return ok(lines);
		}

		const maxCount = input.buckets.reduce((m, b) => (b.count > m ? b.count : m), 0);
		const labelWidth = Math.max(
			...input.buckets.map(b => `[${fmtNum(b.lower)}, ${fmtNum(b.upper)})`.length),
		);
		const countWidth = Math.max(...input.buckets.map(b => fmtCount(b.count).length));

		lines.push('', '```');
		for (const b of input.buckets) {
			const range = `[${fmtNum(b.lower)}, ${fmtNum(b.upper)})`.padEnd(labelWidth);
			const count = fmtCount(b.count).padStart(countWidth);
			const barLen = maxCount > 0 ? Math.round((b.count / maxCount) * MAX_BAR_WIDTH) : 0;
			const bar = '█'.repeat(barLen);
			lines.push(`${range}  ${count}  ${bar}`);
		}
		lines.push('```');
		return ok(lines);
	},
};

function ok(lines: readonly string[]): SkillResult<HistogramBlockOutput> {
	return { value: { markdown: lines.join('\n') }, confidence: 'high', toolCalls: [] };
}

function fmtCount(n: number): string {
	if (!Number.isFinite(n)) return '?';
	return Math.round(n).toLocaleString('en-US');
}

function fmtNum(n: number): string {
	if (!Number.isFinite(n)) return '?';
	if (Number.isInteger(n)) return n.toLocaleString('en-US');
	const abs = Math.abs(n);
	if (abs >= 1000)   return n.toFixed(0);
	if (abs >= 10)     return n.toFixed(2);
	return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

export function registerDataSynthHistogramBlockSkill(): void {
	registerSkill(skill as unknown as Skill);
}
