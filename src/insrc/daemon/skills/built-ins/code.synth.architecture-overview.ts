/**
 * code.synth.architecture-overview -- repo-level architecture
 * summary (code-analyzer-skills.md Phase 6.5).
 *
 * Pairs with `code.source.repo.describe`. Takes the typed repo
 * summary + optional ORM / migration / quality-signal extras and
 * emits a multi-section markdown overview. The plan calls this the
 * "XXL-tier sub-system prose" renderer; v1 keeps the prose
 * deliberately deterministic (no LLM-generated narrative). The
 * future Phase 7-routed pipeline can layer LLM polish on top by
 * consuming this skill's output as scaffolding.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

interface LanguageSummary {
	readonly language:    string;
	readonly fileCount:   number;
	readonly entityCount: number;
}

interface ModuleSummary {
	readonly path:        string;
	readonly fileCount:   number;
	readonly entityCount: number;
}

interface ArchitectureOverviewInput {
	readonly repoPath:     string;
	readonly fileCount:    number;
	readonly entityCount:  number;
	readonly kindCounts:   Readonly<Record<string, number>>;
	readonly languages:    readonly LanguageSummary[];
	readonly topModules:   readonly ModuleSummary[];
	readonly orms?:        readonly string[];
	readonly migrationTool?: string;
	readonly cycleCount?:  number;
	readonly title?:       string;
}

interface ArchitectureOverviewOutput {
	readonly markdown: string;
}

const skill: Skill<ArchitectureOverviewInput, ArchitectureOverviewOutput> = {
	id: 'code.synth.architecture-overview',
	name: 'Synth: architecture overview',
	description:
		'Render a deterministic multi-section repo overview: scale, language mix, top modules, ' +
		'ORM / migration tooling (if known), and cycle-count flag. Pairs with ' +
		'code.source.repo.describe + optional code_orm_scan / code_migration_walk / ' +
		'code.quality.cyclic-deps inputs. Pure template, no LLM.',
	family: 'synthesis',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			repoPath:    { type: 'string' },
			fileCount:   { type: 'number' },
			entityCount: { type: 'number' },
			kindCounts:  { type: 'object' },
			languages:   { type: 'array' },
			topModules:  { type: 'array' },
			orms:        { type: 'array', items: { type: 'string' } },
			migrationTool: { type: 'string' },
			cycleCount:  { type: 'number' },
			title:       { type: 'string' },
		},
		required: ['repoPath', 'fileCount', 'entityCount', 'kindCounts', 'languages', 'topModules'],
	},
	outputs: {
		type: 'object',
		properties: { markdown: { type: 'string' } },
		required: ['markdown'],
		additionalProperties: false,
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input): Promise<SkillResult<ArchitectureOverviewOutput>> {
		const lines: string[] = [];
		const title = input.title ?? `Architecture overview: \`${input.repoPath}\``;
		lines.push(`# ${title}`, '');

		// Scale section.
		lines.push('## Scale', '');
		lines.push(`- **${input.fileCount.toLocaleString()}** indexed files`);
		lines.push(`- **${input.entityCount.toLocaleString()}** entities`);
		const kindLine = formatKindCounts(input.kindCounts);
		if (kindLine.length > 0) lines.push(`- ${kindLine}`);

		// Language section.
		if (input.languages.length > 0) {
			lines.push('', '## Languages', '');
			for (const l of input.languages) {
				const share = input.fileCount > 0
					? Math.round(100 * l.fileCount / input.fileCount)
					: 0;
				lines.push(`- **${l.language}** -- ${l.fileCount} files (${share}%), ${l.entityCount} entities`);
			}
		}

		// Top modules section.
		if (input.topModules.length > 0) {
			lines.push('', '## Top modules by file count', '');
			for (const m of input.topModules.slice(0, 10)) {
				const rel = m.path.startsWith(input.repoPath + '/')
					? m.path.slice(input.repoPath.length + 1)
					: m.path;
				lines.push(`- \`${rel}\` -- ${m.fileCount} files, ${m.entityCount} entities`);
			}
		}

		// Tooling section.
		const toolingLines: string[] = [];
		if (input.orms !== undefined && input.orms.length > 0) {
			toolingLines.push(`- **ORM:** ${input.orms.join(', ')}`);
		}
		if (input.migrationTool !== undefined && input.migrationTool.length > 0) {
			toolingLines.push(`- **Migrations:** ${input.migrationTool}`);
		}
		if (toolingLines.length > 0) {
			lines.push('', '## Data tooling', '', ...toolingLines);
		}

		// Health flag.
		if (input.cycleCount !== undefined) {
			lines.push('', '## Health', '');
			if (input.cycleCount === 0) {
				lines.push('- No file-level import cycles detected.');
			} else {
				lines.push(`- ⚠️ **${input.cycleCount}** file-level import cycle(s) detected -- run \`code.quality.cyclic-deps\` for details.`);
			}
		}

		return {
			value: { markdown: lines.join('\n').trimEnd() },
			confidence: 'high',
			toolCalls: [],
		};
	},
};

function formatKindCounts(kc: Readonly<Record<string, number>>): string {
	const interesting = ['function', 'method', 'class', 'interface', 'type'];
	const parts: string[] = [];
	for (const k of interesting) {
		const n = kc[k] ?? 0;
		if (n > 0) parts.push(`${n.toLocaleString()} ${k}${n === 1 ? '' : 's'}`);
	}
	return parts.length > 0 ? `Includes ${parts.join(', ')}` : '';
}

export function registerCodeSynthArchitectureOverviewSkill(): void {
	registerSkill(skill as unknown as Skill);
}
