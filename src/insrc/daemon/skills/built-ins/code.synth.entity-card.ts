/**
 * code.synth.entity-card -- render one entity's signature + body
 * excerpt + neighbours as a markdown card
 * (code-analyzer-skills.md Phase 6.1).
 *
 * Pure-template skill: takes the typed output of
 * `code.entity.summary` (or a compatible shape) plus optional
 * caller / callee neighbour lists, returns
 * `{ markdown }`. No LLM, no tool calls.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

interface NeighbourRef {
	readonly id?:        string;
	readonly name:       string;
	readonly file?:      string;
	readonly startLine?: number;
}

interface EntityCardInput {
	readonly entityId:    string;
	readonly name:        string;
	readonly kind:        string;
	readonly language:    string;
	readonly file:        string;
	readonly startLine:   number;
	readonly endLine:     number;
	readonly signature?:  string;
	readonly isExported?: boolean;
	readonly isAbstract?: boolean;
	readonly isAsync?:    boolean;
	readonly excerpt?:    string;
	readonly excerptTruncated?: boolean;
	readonly callers?:    readonly NeighbourRef[];
	readonly callees?:    readonly NeighbourRef[];
}

interface EntityCardOutput {
	readonly markdown: string;
}

const skill: Skill<EntityCardInput, EntityCardOutput> = {
	id: 'code.synth.entity-card',
	name: 'Synth: entity card',
	description:
		'Render an entity\'s metadata + signature + body excerpt + caller/callee summary as a ' +
		'markdown card. Input shape pairs with code.entity.summary + optional code.entity.callers ' +
		'/ code.entity.callees outputs. Pure template, no LLM.',
	family: 'synthesis',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			entityId:  { type: 'string' },
			name:      { type: 'string' },
			kind:      { type: 'string' },
			language:  { type: 'string' },
			file:      { type: 'string' },
			startLine: { type: 'number' },
			endLine:   { type: 'number' },
			signature: { type: 'string' },
			isExported: { type: 'boolean' },
			isAbstract: { type: 'boolean' },
			isAsync:    { type: 'boolean' },
			excerpt:    { type: 'string' },
			excerptTruncated: { type: 'boolean' },
			callers:    { type: 'array' },
			callees:    { type: 'array' },
		},
		required: ['entityId', 'name', 'kind', 'language', 'file', 'startLine', 'endLine'],
	},
	outputs: {
		type: 'object',
		properties: { markdown: { type: 'string' } },
		required: ['markdown'],
		additionalProperties: false,
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input): Promise<SkillResult<EntityCardOutput>> {
		const tags = collectTags(input);
		const lines: string[] = [
			`### \`${input.name}\` (${input.kind})${tags.length > 0 ? ` -- ${tags.join(', ')}` : ''}`,
			'',
			`**Location:** [${input.file}:${input.startLine}](${input.file}#L${input.startLine}-L${input.endLine})`,
			`**Language:** ${input.language}`,
		];
		if (input.signature !== undefined && input.signature.length > 0) {
			lines.push(`**Signature:** \`${input.signature}\``);
		}

		if (input.excerpt !== undefined && input.excerpt.length > 0) {
			lines.push('', '```' + langTag(input.language));
			lines.push(input.excerpt);
			if (input.excerptTruncated === true) lines.push('// ... <truncated>');
			lines.push('```');
		}

		if (input.callers !== undefined && input.callers.length > 0) {
			lines.push('', `**Callers (${input.callers.length}):**`);
			for (const n of input.callers.slice(0, 10)) lines.push(`- ${formatNeighbour(n)}`);
			if (input.callers.length > 10) lines.push(`- ... ${input.callers.length - 10} more`);
		}
		if (input.callees !== undefined && input.callees.length > 0) {
			lines.push('', `**Callees (${input.callees.length}):**`);
			for (const n of input.callees.slice(0, 10)) lines.push(`- ${formatNeighbour(n)}`);
			if (input.callees.length > 10) lines.push(`- ... ${input.callees.length - 10} more`);
		}

		return {
			value: { markdown: lines.join('\n') },
			confidence: 'high',
			toolCalls: [],
		};
	},
};

function collectTags(input: EntityCardInput): string[] {
	const tags: string[] = [];
	if (input.isExported === true) tags.push('exported');
	if (input.isAbstract === true) tags.push('abstract');
	if (input.isAsync    === true) tags.push('async');
	return tags;
}

function formatNeighbour(n: NeighbourRef): string {
	if (n.file !== undefined && n.startLine !== undefined) {
		return `\`${n.name}\` ([${n.file}:${n.startLine}](${n.file}#L${n.startLine}))`;
	}
	return `\`${n.name}\``;
}

function langTag(lang: string): string {
	switch (lang) {
		case 'typescript': return 'ts';
		case 'javascript': return 'js';
		case 'python':     return 'py';
		default:           return lang;
	}
}

export function registerCodeSynthEntityCardSkill(): void {
	registerSkill(skill as unknown as Skill);
}
