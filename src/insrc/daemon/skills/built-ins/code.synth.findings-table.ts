/**
 * code.synth.findings-table -- per-severity finding table
 * (code-analyzer-skills.md Phase 6.2).
 *
 * Generic renderer for any quality / metric skill output. Takes
 * `findings: [{ severity, message, file?, line?, entityId? }]`
 * and groups by severity (critical -> high -> medium -> low ->
 * info), one table per group.
 *
 * Pure template, no LLM, no tool calls.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

interface Finding {
	readonly severity: Severity;
	readonly message:  string;
	readonly file?:    string;
	readonly line?:    number;
	readonly entityId?: string;
	readonly category?: string;
}

interface FindingsTableInput {
	readonly title?:    string;
	readonly findings:  readonly Finding[];
}

interface FindingsTableOutput {
	readonly markdown: string;
}

const skill: Skill<FindingsTableInput, FindingsTableOutput> = {
	id: 'code.synth.findings-table',
	name: 'Synth: findings table',
	description:
		'Group an array of findings by severity (critical -> info) and render each as a markdown ' +
		'table with file:line links. Pure template; no LLM. Pair with any quality skill output ' +
		'or assemble cross-skill findings before rendering.',
	family: 'synthesis',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			title: { type: 'string' },
			findings: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						severity: { type: 'string', enum: SEVERITY_ORDER as readonly string[] },
						message:  { type: 'string' },
						file:     { type: 'string' },
						line:     { type: 'number' },
						entityId: { type: 'string' },
						category: { type: 'string' },
					},
					required: ['severity', 'message'],
				},
			},
		},
		required: ['findings'],
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

	async execute(input): Promise<SkillResult<FindingsTableOutput>> {
		const lines: string[] = [];
		if (input.title !== undefined && input.title.length > 0) {
			lines.push(`## ${input.title}`, '');
		}

		if (input.findings.length === 0) {
			lines.push('_No findings._');
			return { value: { markdown: lines.join('\n') }, confidence: 'high', toolCalls: [] };
		}

		// Group by severity preserving SEVERITY_ORDER.
		const groups = new Map<Severity, Finding[]>();
		for (const f of input.findings) {
			const arr = groups.get(f.severity) ?? [];
			arr.push(f);
			groups.set(f.severity, arr);
		}

		const totals = SEVERITY_ORDER
			.filter(s => (groups.get(s)?.length ?? 0) > 0)
			.map(s => `${groups.get(s)!.length} ${s}`)
			.join(', ');
		lines.push(`**Total: ${input.findings.length}** (${totals})`, '');

		for (const sev of SEVERITY_ORDER) {
			const items = groups.get(sev);
			if (items === undefined || items.length === 0) continue;
			lines.push(`### ${labelFor(sev)} (${items.length})`, '');
			lines.push('| location | category | message |');
			lines.push('|---|---|---|');
			for (const f of items) {
				lines.push(`| ${formatLocation(f)} | ${f.category ?? '-'} | ${escapePipe(f.message)} |`);
			}
			lines.push('');
		}

		return {
			value: { markdown: lines.join('\n').trimEnd() },
			confidence: 'high',
			toolCalls: [],
		};
	},
};

function labelFor(s: Severity): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatLocation(f: Finding): string {
	if (f.file === undefined) return '-';
	if (f.line !== undefined) {
		return `[${shortPath(f.file)}:${f.line}](${f.file}#L${f.line})`;
	}
	return `[${shortPath(f.file)}](${f.file})`;
}

function shortPath(p: string): string {
	const i = p.lastIndexOf('/');
	return i === -1 ? p : p.slice(i + 1);
}

function escapePipe(s: string): string {
	return s.replace(/\|/g, '\\|');
}

export function registerCodeSynthFindingsTableSkill(): void {
	registerSkill(skill as unknown as Skill);
}
