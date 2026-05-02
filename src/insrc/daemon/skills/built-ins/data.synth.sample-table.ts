/**
 * data.synth.sample-table -- Phase 6.5 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Pure-template skill: renders a sample-rows shape (output of
 * `data.source.rdbms.sample-rows` / `data.source.file.sample-rows`)
 * as a markdown table. Long string values are truncated to 80 chars
 * to keep the markdown legible; nested values are JSON-stringified.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

const VALUE_TRUNCATE = 80;

interface SampleTableInput {
	readonly target: string;
	readonly columns: readonly string[];
	readonly rows: readonly Readonly<Record<string, unknown>>[];
	readonly truncated?: boolean;
	readonly samplingMethod?: string;
}

interface SampleTableOutput {
	readonly markdown: string;
}

const skill: Skill<SampleTableInput, SampleTableOutput> = {
	id: 'data.synth.sample-table',
	name: 'Synth: sample table',
	description:
		'Render a sample-rows result as a markdown table. Long values are truncated to 80 chars; nested ' +
		'values are JSON-stringified. Pair with sample-rows skills for report-ready row excerpts.',
	family: 'synthesis',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			target:         { type: 'string' },
			columns:        { type: 'array', items: { type: 'string' } },
			rows:           { type: 'array' },
			truncated:      { type: 'boolean' },
			samplingMethod: { type: 'string' },
		},
		required: ['target', 'columns', 'rows'],
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

	async execute(input): Promise<SkillResult<SampleTableOutput>> {
		const truncTag = input.truncated === true ? ' (truncated)' : '';
		const methodTag = input.samplingMethod !== undefined ? ` -- sampling: ${input.samplingMethod}` : '';
		const header = [
			`**${input.target}** -- ${input.rows.length} row${input.rows.length === 1 ? '' : 's'}${truncTag}${methodTag}`,
			'',
		];

		if (input.columns.length === 0 || input.rows.length === 0) {
			header.push('_(no rows)_');
			return {
				value: { markdown: header.join('\n') },
				confidence: 'medium',
				toolCalls: [],
			};
		}

		const headerRow = '| ' + input.columns.map(c => `\`${c}\``).join(' | ') + ' |';
		const sepRow    = '|' + input.columns.map(() => '---').join('|') + '|';
		const dataRows: string[] = [];
		for (const row of input.rows) {
			const cells = input.columns.map(c => renderCell(row[c]));
			dataRows.push('| ' + cells.join(' | ') + ' |');
		}
		return {
			value: { markdown: [...header, headerRow, sepRow, ...dataRows].join('\n') },
			confidence: 'high',
			toolCalls: [],
		};
	},
};

/**
 * Render one cell's value. Markdown table cells can't contain raw
 * pipes or newlines; both get escaped / replaced. Long values
 * truncate at VALUE_TRUNCATE.
 */
function renderCell(v: unknown): string {
	if (v === null || v === undefined) return '_null_';
	let s: string;
	if (typeof v === 'string') s = v;
	else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') s = String(v);
	else {
		try { s = JSON.stringify(v); }
		catch { s = String(v); }
	}
	if (s.length > VALUE_TRUNCATE) s = s.slice(0, VALUE_TRUNCATE - 1) + '…';  // U+2026 horizontal ellipsis
	// Escape pipes; collapse newlines / cr to a single space.
	return s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

export function registerDataSynthSampleTableSkill(): void {
	registerSkill(skill as unknown as Skill);
}
