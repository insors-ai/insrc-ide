/**
 * data.synth.lineage-fold -- Phase 6.6 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Pure-template skill: renders the output of
 * `data.lineage.read-write-callsites` as a markdown fragment grouped
 * by source-file path. Within each file, hits are listed in line-
 * number order with their classification (reader / writer /
 * ambiguous) and a code snippet.
 *
 * The "fold" name comes from the rendering shape: hits collapse into
 * per-file blocks rather than a flat list, so a long list of
 * call-sites stays scannable. Snippets are rendered in fenced code
 * blocks; long snippets truncate at 200 chars.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

const SNIPPET_TRUNCATE = 200;

interface LineageHit {
	readonly entityId: string;
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly entityName: string;
	readonly entityKind: string;
	readonly classification: 'reader' | 'writer' | 'ambiguous';
	readonly snippet: string;
}

interface LineageFoldInput {
	readonly target: string;
	readonly connectionId: string;
	readonly hits: readonly LineageHit[];
	readonly truncated?: boolean;
	readonly counts?: { readonly readers: number; readonly writers: number; readonly ambiguous: number };
}

interface LineageFoldOutput {
	readonly markdown: string;
}

const skill: Skill<LineageFoldInput, LineageFoldOutput> = {
	id: 'data.synth.lineage-fold',
	name: 'Synth: lineage fold',
	description:
		'Render lineage call-sites grouped by source-file path. Each file gets a block listing the hits ' +
		'with line numbers + classification (reader / writer / ambiguous) + a code snippet. Pair with ' +
		'data.lineage.read-write-callsites for report-ready lineage output.',
	family: 'synthesis',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			target:       { type: 'string' },
			connectionId: { type: 'string' },
			hits: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						entityId:       { type: 'string' },
						path:           { type: 'string' },
						startLine:      { type: 'number' },
						endLine:        { type: 'number' },
						entityName:     { type: 'string' },
						entityKind:     { type: 'string' },
						classification: { type: 'string', enum: ['reader', 'writer', 'ambiguous'] },
						snippet:        { type: 'string' },
					},
					required: ['entityId', 'path', 'startLine', 'endLine', 'entityName', 'entityKind', 'classification', 'snippet'],
					additionalProperties: false,
				},
			},
			truncated: { type: 'boolean' },
			counts: {
				type: 'object',
				properties: {
					readers:   { type: 'number' },
					writers:   { type: 'number' },
					ambiguous: { type: 'number' },
				},
				required: ['readers', 'writers', 'ambiguous'],
				additionalProperties: false,
			},
		},
		required: ['target', 'connectionId', 'hits'],
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

	async execute(input): Promise<SkillResult<LineageFoldOutput>> {
		const truncTag = input.truncated === true ? ' (truncated)' : '';
		const counts = input.counts;
		const summary = counts !== undefined
			? `${counts.readers} reader${counts.readers === 1 ? '' : 's'}, ` +
			  `${counts.writers} writer${counts.writers === 1 ? '' : 's'}, ` +
			  `${counts.ambiguous} ambiguous`
			: `${input.hits.length} hit${input.hits.length === 1 ? '' : 's'}`;

		const lines: string[] = [
			`**${input.target}** on \`${input.connectionId}\`${truncTag}`,
			'',
			`lineage: ${summary}`,
			'',
		];

		if (input.hits.length === 0) {
			lines.push('_(no call-sites found)_');
			return {
				value: { markdown: lines.join('\n') },
				confidence: 'medium',
				toolCalls: [],
			};
		}

		// Group by path; within each path, sort by startLine. Path
		// order is alphabetical for deterministic output.
		const byPath = new Map<string, LineageHit[]>();
		for (const h of input.hits) {
			const arr = byPath.get(h.path);
			if (arr === undefined) byPath.set(h.path, [h]);
			else arr.push(h);
		}
		const paths = [...byPath.keys()].sort();
		for (const path of paths) {
			const hits = byPath.get(path)!.sort((a, b) => a.startLine - b.startLine);
			lines.push(`### \`${path}\` (${hits.length} hit${hits.length === 1 ? '' : 's'})`, '');
			for (const h of hits) {
				const range = h.startLine === h.endLine ? `L${h.startLine}` : `L${h.startLine}-${h.endLine}`;
				lines.push(`- **${range}** \`${h.entityKind}\` \`${h.entityName}\` _(${h.classification})_`);
				const snippet = h.snippet.length > SNIPPET_TRUNCATE
					? h.snippet.slice(0, SNIPPET_TRUNCATE) + '…'
					: h.snippet;
				lines.push('', '  ```', '  ' + snippet.replace(/\n/g, '\n  '), '  ```', '');
			}
		}

		return {
			value: { markdown: lines.join('\n') },
			confidence: 'high',
			toolCalls: [],
		};
	},
};

export function registerDataSynthLineageFoldSkill(): void {
	registerSkill(skill as unknown as Skill);
}
