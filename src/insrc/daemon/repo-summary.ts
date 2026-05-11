/**
 * Lightweight repo size + shape summary for the code-analyzer's
 * scope classifier (Phase E.1a) and planner context (Phase E.1b).
 *
 * Computed by walking the graph once and aggregating -- mirrors
 * the `code.source.repo.describe` skill's logic but exposed as a
 * plain async function so the chat-handler can call it BEFORE the
 * orchestrator boots (i.e. before the full skill pipeline is up).
 *
 * The same `RepoSizeSummary` value is reused for:
 *   1. The scope classifier's `context` parameter -- gives the
 *      sizer real signal ("3153 files, 12 top modules") instead of
 *      just `closure size: 1`. Pre-E.1a the LLM picked M for
 *      "describe what this repo does" because it had no idea this
 *      was a 3K-file repo.
 *   2. The orchestrator's `buildSummaryContext` -- the planner's
 *      user prompt was a single line ("Active repo: <path>") which
 *      starved the planner of any signal to write repo-specific
 *      section titles.
 *
 * One graph walk per chat turn. Cached on the active chat-session
 * pool entry so multiple consumers in the same turn share the
 * cost.
 */

import type { Entity, EntityKind, Language } from '../shared/types.js';
import { listEntitiesForRepo } from '../db/entities.js';
import { dirname } from 'node:path';
import { getLogger } from '../shared/logger.js';

const log = getLogger('repo-summary');

/** One language bucket. */
export interface LanguageRow {
	readonly language:    Language;
	readonly fileCount:   number;
	readonly entityCount: number;
}

/** One top-module bucket. */
export interface ModuleRow {
	readonly path:        string;
	readonly fileCount:   number;
	readonly entityCount: number;
}

export interface RepoSizeSummary {
	readonly repoPath:    string;
	readonly fileCount:   number;
	readonly entityCount: number;
	readonly kindCounts:  Readonly<Partial<Record<EntityKind, number>>>;
	readonly languages:   readonly LanguageRow[];
	/** Top modules by file count, capped (default 12). */
	readonly topModules:  readonly ModuleRow[];
	/** True when the repo is empty / not indexed; everything else is zeroes. */
	readonly empty:       boolean;
}

const TOP_MODULES_K = 12;

export async function getRepoSizeSummary(repoPath: string): Promise<RepoSizeSummary> {
	const empty: RepoSizeSummary = {
		repoPath,
		fileCount:   0,
		entityCount: 0,
		kindCounts:  {},
		languages:   [],
		topModules:  [],
		empty:       true,
	};

	if (repoPath.length === 0) return empty;

	let entities: Entity[];
	try {
		entities = await listEntitiesForRepo(null, repoPath);
	} catch (err) {
		log.warn({ err: (err as Error).message, repoPath }, 'getRepoSizeSummary: graph walk failed');
		return empty;
	}

	if (entities.length === 0) return empty;

	const kindCounts: Partial<Record<EntityKind, number>> = {};
	const langStats = new Map<Language, { files: number; entities: number }>();
	const moduleFileCount   = new Map<string, number>();
	const moduleEntityCount = new Map<string, number>();
	let fileCount = 0;

	for (const e of entities) {
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

	const languages: LanguageRow[] = [...langStats.entries()]
		.map(([language, s]) => ({ language, fileCount: s.files, entityCount: s.entities }))
		.sort((a, b) => b.fileCount - a.fileCount);

	const topModules: ModuleRow[] = [...moduleFileCount.entries()]
		.map(([path, files]) => ({
			path,
			fileCount:   files,
			entityCount: moduleEntityCount.get(path) ?? 0,
		}))
		.sort((a, b) => b.fileCount - a.fileCount)
		.slice(0, TOP_MODULES_K);

	return {
		repoPath,
		fileCount,
		entityCount: entities.length,
		kindCounts,
		languages,
		topModules,
		empty:       false,
	};
}

/**
 * Format the summary as a compact context block for LLM prompts.
 *
 * Two output flavours:
 *   - `'compact'` -- 3-5 lines, used for the scope classifier where
 *     latency budget is tight. Surfaces file count, top language,
 *     top modules (paths only), and a "big repo" flag.
 *   - `'detailed'` -- multi-line markdown, used for the planner
 *     where we want the model to write subsystem-specific section
 *     titles. Includes language breakdown and per-module file
 *     counts.
 */
export function formatRepoSizeSummary(
	s: RepoSizeSummary,
	flavour: 'compact' | 'detailed',
): string {
	if (s.empty) return `repo: ${s.repoPath} (no entities indexed yet)`;

	if (flavour === 'compact') {
		const topLang  = s.languages[0];
		const topMods  = s.topModules.slice(0, 6).map(m => shortPath(m.path, s.repoPath)).join(', ');
		const sizeTag  = s.fileCount >= 1000 ? ' (LARGE repo)'
			: s.fileCount >= 200  ? ' (mid-size repo)'
				: '';
		const lines: string[] = [
			`repo: ${s.repoPath}`,
			`size: ${s.fileCount} files, ${s.entityCount} entities${sizeTag}`,
		];
		if (topLang) {
			lines.push(`primary language: ${topLang.language} (${topLang.fileCount} files)`);
		}
		if (s.topModules.length > 0) {
			lines.push(`top modules: ${topMods}`);
		}
		return lines.join('\n');
	}

	// Detailed
	const langLines = s.languages
		.slice(0, 10)
		.map(l => `  ${l.language.padEnd(10)} ${String(l.fileCount).padStart(5)} files, ${l.entityCount} entities`);

	const modLines = s.topModules
		.map(m => `  ${shortPath(m.path, s.repoPath).padEnd(45)} ${String(m.fileCount).padStart(4)} files, ${m.entityCount} entities`);

	const kindEntries = Object.entries(s.kindCounts)
		.sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
		.map(([k, n]) => `${k}=${n}`)
		.join(', ');

	return [
		`Repo: ${s.repoPath}`,
		`Totals: ${s.fileCount} files, ${s.entityCount} entities`,
		`Entity kinds: ${kindEntries}`,
		'',
		'Languages (top 10 by file count):',
		...langLines,
		'',
		`Top modules by file count (max ${TOP_MODULES_K}):`,
		...modLines,
	].join('\n');
}

function shortPath(absPath: string, repoPath: string): string {
	if (repoPath.length > 0 && absPath.startsWith(repoPath)) {
		const rel = absPath.slice(repoPath.length);
		return rel.startsWith('/') ? rel.slice(1) : rel;
	}
	return absPath;
}
