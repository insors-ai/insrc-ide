/**
 * code.synth.callgraph-mermaid -- callers / callees as a Mermaid
 * graph (code-analyzer-skills.md Phase 6.3).
 *
 * Pairs with `code.entity.callers` / `code.entity.callees`. Takes a
 * focal entity + neighbour lists and emits a fenced ```mermaid```
 * block with `graph LR` (left-to-right; reads better than TD when
 * both directions are present).
 *
 * Pure template; no LLM.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

const NODE_LIMIT = 30;

interface NodeRef {
	readonly id:    string;
	readonly name:  string;
	readonly file?: string;
}

interface CallgraphInput {
	readonly focal:   NodeRef;
	readonly callers?: readonly NodeRef[];
	readonly callees?: readonly NodeRef[];
	readonly title?:   string;
}

interface CallgraphOutput {
	readonly markdown: string;
}

const skill: Skill<CallgraphInput, CallgraphOutput> = {
	id: 'code.synth.callgraph-mermaid',
	name: 'Synth: callgraph as Mermaid',
	description:
		'Render a focal entity + callers + callees as a Mermaid `graph LR` block. Caps at 30 ' +
		'neighbours per direction; oversized inputs surface a "+ N more" annotation. Pure ' +
		'template, no LLM.',
	family: 'synthesis',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			focal: {
				type: 'object',
				properties: {
					id:   { type: 'string' },
					name: { type: 'string' },
					file: { type: 'string' },
				},
				required: ['id', 'name'],
			},
			callers: { type: 'array' },
			callees: { type: 'array' },
			title:   { type: 'string' },
		},
		required: ['focal'],
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

	async execute(input): Promise<SkillResult<CallgraphOutput>> {
		const callers = input.callers ?? [];
		const callees = input.callees ?? [];

		const lines: string[] = [];
		if (input.title !== undefined && input.title.length > 0) {
			lines.push(`### ${input.title}`, '');
		}
		lines.push('```mermaid', 'graph LR');

		const focalNode = nodeFor(input.focal, true);
		lines.push(`  ${focalNode.id}[${focalNode.label}]`);
		lines.push(`  style ${focalNode.id} fill:#fef3c7,stroke:#f59e0b`);

		const callerSlice = callers.slice(0, NODE_LIMIT);
		for (const n of callerSlice) {
			const node = nodeFor(n, false);
			lines.push(`  ${node.id}[${node.label}]`);
			lines.push(`  ${node.id} --> ${focalNode.id}`);
		}
		if (callers.length > NODE_LIMIT) {
			lines.push(`  more_callers[+${callers.length - NODE_LIMIT} more]`);
			lines.push(`  more_callers -.-> ${focalNode.id}`);
		}

		const calleeSlice = callees.slice(0, NODE_LIMIT);
		for (const n of calleeSlice) {
			const node = nodeFor(n, false);
			lines.push(`  ${node.id}[${node.label}]`);
			lines.push(`  ${focalNode.id} --> ${node.id}`);
		}
		if (callees.length > NODE_LIMIT) {
			lines.push(`  more_callees[+${callees.length - NODE_LIMIT} more]`);
			lines.push(`  ${focalNode.id} -.-> more_callees`);
		}

		lines.push('```');

		return {
			value: { markdown: lines.join('\n') },
			confidence: callers.length > 0 || callees.length > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

function nodeFor(n: NodeRef, isFocal: boolean): { id: string; label: string } {
	const id = sanitiseId(n.id);
	const label = isFocal ? `<b>${escapeMermaid(n.name)}</b>` : escapeMermaid(n.name);
	return { id, label };
}

function sanitiseId(raw: string): string {
	// Mermaid node ids must start with a letter and contain only
	// alnum / underscore. Take the first 12 chars of the hex id and
	// prefix `n_` to satisfy both rules.
	return 'n_' + raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
}

function escapeMermaid(s: string): string {
	// Mermaid labels accept `<b>...</b>` HTML but break on backticks
	// + raw quotes. Replace those.
	return s.replace(/[`"]/g, '');
}

export function registerCodeSynthCallgraphMermaidSkill(): void {
	registerSkill(skill as unknown as Skill);
}
