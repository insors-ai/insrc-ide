/**
 * code.source.repo.describe -- whole-repo summary
 * (code-analyzer-skills.md Phase 1.3).
 *
 * Aggregates `listEntitiesForRepo` into a high-level shape:
 *
 *   - entityCount per kind
 *   - language breakdown (file + entity counts per language)
 *   - top modules (directories) by file count, capped at TOP_K
 *
 * Pure-graph computation -- no `runTool`, no fs walk. The graph is
 * the source of truth for what's been indexed; rescanning the
 * filesystem would race with the indexer.
 *
 * Output discriminator: `{ found: true, ... }` vs `{ found: false,
 * reason: 'repo-not-indexed' }`. The repo is "not indexed" when
 * `listEntitiesForRepo` returns zero rows -- could mean the path
 * isn't registered, the indexer hasn't run yet, or every file was
 * filtered out.
 */

import { dirname } from 'node:path';
import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import { listEntitiesForRepo } from '../../../db/entities.js';
import type { Entity, EntityKind, Language } from '../../../shared/types.js';

// Phase B.1: removed TOP_K_MODULES cap. `modules` returns the COMPLETE
// list of modules sorted by file count; renderer pages for the LLM.

interface RepoDescribeInput {
	readonly repoPath: string;
}

interface ModuleSummary {
	readonly path:        string;
	readonly fileCount:   number;
	readonly entityCount: number;
}

interface LanguageSummary {
	readonly language:    Language;
	readonly fileCount:   number;
	readonly entityCount: number;
}

type RepoDescribeOutput =
	| {
		readonly found:        true;
		readonly repoPath:     string;
		readonly fileCount:    number;
		readonly entityCount:  number;
		readonly kindCounts:   Readonly<Partial<Record<EntityKind, number>>>;
		readonly languages:    readonly LanguageSummary[];
		readonly modules:      readonly ModuleSummary[];
	}
	| {
		readonly found:  false;
		readonly reason: 'repo-not-indexed';
	};

const codeSourceRepoDescribeSkill: Skill<RepoDescribeInput, RepoDescribeOutput> = {
	id: 'code.source.repo.describe',
	name: 'Code: describe a repo',
	description:
		'High-level repo summary: file / entity counts, kind breakdown, language breakdown, ' +
		'and the COMPLETE list of modules (directories) sorted by file count. Returns ' +
		'`{ found: false, reason: "repo-not-indexed" }` when nothing has been indexed yet.',
	family: 'source-introspection',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			repoPath: { type: 'string', description: 'Repo root absolute path.' },
		},
		required: ['repoPath'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: { found: { type: 'boolean' } },
		required: ['found'],
		oneOf: [
			{
				type: 'object',
				properties: {
					found:       { type: 'boolean', enum: [true] },
					repoPath:    { type: 'string' },
					fileCount:   { type: 'number' },
					entityCount: { type: 'number' },
					kindCounts:  { type: 'object' },
					languages:   { type: 'array' },
					modules:     { type: 'array' },
				},
				required: ['found', 'repoPath', 'fileCount', 'entityCount', 'kindCounts', 'languages', 'modules'],
			},
			{
				type: 'object',
				properties: {
					found:  { type: 'boolean', enum: [false] },
					reason: { type: 'string', enum: ['repo-not-indexed'] },
				},
				required: ['found', 'reason'],
			},
		],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: RepoDescribeInput, _deps: SkillDeps): Promise<SkillResult<RepoDescribeOutput>> {
		const all = await listEntitiesForRepo(null, input.repoPath);
		if (all.length === 0) {
			return {
				value: { found: false, reason: 'repo-not-indexed' },
				confidence: 'high',
				notes: [`Repo '${input.repoPath}' has no entities in the graph. Either the path isn't registered (use repo.add) or the indexer hasn't completed yet.`],
				toolCalls: [],
			};
		}

		const kindCounts: Partial<Record<EntityKind, number>> = {};
		const langStats = new Map<Language, { files: number; entities: number }>();
		const moduleFileCount  = new Map<string, number>();
		const moduleEntityCount = new Map<string, number>();
		let fileCount = 0;

		for (const e of all) {
			kindCounts[e.kind] = (kindCounts[e.kind] ?? 0) + 1;
			const stats = langStats.get(e.language) ?? { files: 0, entities: 0 };
			if (e.kind === 'file') {
				fileCount++;
				stats.files++;
				const dir = dirname(e.file);
				moduleFileCount.set(dir, (moduleFileCount.get(dir) ?? 0) + 1);
			} else {
				stats.entities++;
				if (e.file.length > 0) {
					const dir = dirname(e.file);
					moduleEntityCount.set(dir, (moduleEntityCount.get(dir) ?? 0) + 1);
				}
			}
			langStats.set(e.language, stats);
		}

		const languages: LanguageSummary[] = [...langStats.entries()]
			.map(([language, s]) => ({ language, fileCount: s.files, entityCount: s.entities }))
			.sort((a, b) => b.fileCount - a.fileCount);

		const modules: ModuleSummary[] = [...moduleFileCount.entries()]
			.map(([path, c]) => ({
				path,
				fileCount:   c,
				entityCount: moduleEntityCount.get(path) ?? 0,
			}))
			.sort((a, b) => b.fileCount - a.fileCount || b.entityCount - a.entityCount);

		const out: RepoDescribeOutput = {
			found:        true,
			repoPath:     input.repoPath,
			fileCount,
			entityCount:  all.length - fileCount,
			kindCounts,
			languages,
			modules,
		};
		return {
			value: out,
			confidence: 'high',
			notes: [],
			toolCalls: [],
		};
	},
};

export function registerCodeSourceRepoDescribeSkill(): void {
	registerSkill(codeSourceRepoDescribeSkill as unknown as Skill);
}

// Test exports.
export const _aggregateForTest = (entities: Entity[]): { files: number; langs: Set<Language> } => {
	const langs = new Set<Language>();
	let files = 0;
	for (const e of entities) {
		langs.add(e.language);
		if (e.kind === 'file') files++;
	}
	return { files, langs };
};
