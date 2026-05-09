/**
 * code.synth.module-tree -- module hierarchy as an ASCII tree
 * (code-analyzer-skills.md Phase 6.4).
 *
 * Pairs with `code.source.repo.describe`'s `topModules`. Takes a
 * list of `{ path, fileCount, entityCount }` and renders a
 * directory tree. "Tier-aware" means the top-N largest modules are
 * shown verbatim; deeper modules collapse into a `... <K more>`
 * marker so the tree stays readable for big monorepos.
 *
 * Pure template; no LLM.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

const TIER_TOP    = 10;   // verbatim
const TIER_BUDGET = 30;   // total leaves rendered before the +more marker

interface ModuleNode {
	readonly path:        string;
	readonly fileCount:   number;
	readonly entityCount: number;
}

interface ModuleTreeInput {
	readonly repoPath:    string;
	readonly modules:     readonly ModuleNode[];
	readonly title?:      string;
}

interface ModuleTreeOutput {
	readonly markdown: string;
}

const skill: Skill<ModuleTreeInput, ModuleTreeOutput> = {
	id: 'code.synth.module-tree',
	name: 'Synth: module tree',
	description:
		'Render a list of modules (directories with file/entity counts) as an indented tree, ' +
		'sorted by file count. The top-10 modules are verbatim; the next 20 collapse into a ' +
		'+ more marker so the rendering stays readable for monorepos. Pure template, no LLM.',
	family: 'synthesis',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			repoPath: { type: 'string' },
			modules: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						path:        { type: 'string' },
						fileCount:   { type: 'number' },
						entityCount: { type: 'number' },
					},
					required: ['path', 'fileCount', 'entityCount'],
				},
			},
			title: { type: 'string' },
		},
		required: ['repoPath', 'modules'],
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

	async execute(input): Promise<SkillResult<ModuleTreeOutput>> {
		const lines: string[] = [];
		if (input.title !== undefined && input.title.length > 0) {
			lines.push(`### ${input.title}`, '');
		}
		if (input.modules.length === 0) {
			lines.push('_No modules._');
			return { value: { markdown: lines.join('\n') }, confidence: 'medium', toolCalls: [] };
		}

		// Sort modules by fileCount desc; render relative to repoPath.
		const sorted = [...input.modules].sort((a, b) =>
			b.fileCount - a.fileCount || b.entityCount - a.entityCount,
		);

		lines.push('```text');
		lines.push(`${input.repoPath}/`);

		const visible = sorted.slice(0, TIER_BUDGET);
		const verbatim = visible.slice(0, TIER_TOP);
		const collapsed = visible.slice(TIER_TOP);

		for (const m of verbatim) {
			lines.push(formatRow(m, input.repoPath));
		}
		if (collapsed.length > 0) {
			const collapsedFiles = collapsed.reduce((acc, m) => acc + m.fileCount, 0);
			const collapsedEntities = collapsed.reduce((acc, m) => acc + m.entityCount, 0);
			lines.push(`├── ... ${collapsed.length} more modules (${collapsedFiles} files, ${collapsedEntities} entities)`);
		}
		const trailingHidden = sorted.length - visible.length;
		if (trailingHidden > 0) {
			lines.push(`└── + ${trailingHidden} additional small modules omitted`);
		}
		lines.push('```');

		return {
			value: { markdown: lines.join('\n') },
			confidence: 'high',
			toolCalls: [],
		};
	},
};

function formatRow(m: ModuleNode, repoPath: string): string {
	const rel = m.path.startsWith(repoPath + '/')
		? m.path.slice(repoPath.length + 1)
		: m.path === repoPath
			? '.'
			: m.path;
	return `├── ${rel}/  -- ${m.fileCount} file${m.fileCount === 1 ? '' : 's'}, ${m.entityCount} ${m.entityCount === 1 ? 'entity' : 'entities'}`;
}

export function registerCodeSynthModuleTreeSkill(): void {
	registerSkill(skill as unknown as Skill);
}
