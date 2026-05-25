/**
 * code.source.module.describe -- summarise one module's public
 * surface (code-analyzer-skills.md Phase 1.2).
 *
 * A "module" here is a filesystem directory containing source
 * files belonging to the same package -- the convention every
 * supported language uses (TS / JS / Python / Java / Scala / Go).
 * The skill walks `listEntitiesForRepo`, scopes to entities whose
 * `file` lives under `modulePath`, and aggregates:
 *
 *   - `files`       : every source file (kind='file') in the dir
 *   - `entities`    : top-level entities (function / method / class
 *                     / interface / type / variable) defined in
 *                     those files
 *   - `publicSurface`: subset of `entities` with isExported=true
 *
 * Pure-graph computation -- no `runTool` round-trip, no fs walk.
 * The graph already knows what's there; rescanning the filesystem
 * would race with the indexer and double the I/O cost.
 *
 * Output discriminator: `{ found: true, ... }` vs `{ found: false,
 * reason: 'no-files-in-module' }` so callers can refuse cleanly
 * when the directory has no indexed files (not yet indexed, wrong
 * path, or filtered out by the indexer's exclusion rules).
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import { listEntitiesForRepo } from '../../../db/entities.js';
import type { Entity, EntityKind, Language } from '../../../shared/types.js';

interface ModuleDescribeInput {
	readonly modulePath: string;
	readonly repoPath:   string;
}

interface ModuleFile {
	readonly path:      string;
	readonly language:  Language;
	readonly endLine:   number;
	readonly entityId:  string;
}

interface ModuleEntity {
	readonly id:         string;
	readonly name:       string;
	readonly kind:       EntityKind;
	readonly file:       string;
	readonly startLine:  number;
	readonly language:   Language;
	readonly signature?: string;
	readonly isExported?: boolean;
}

type ModuleDescribeOutput =
	| {
		readonly found:         true;
		readonly modulePath:    string;
		readonly fileCount:     number;
		readonly entityCount:   number;
		readonly publicCount:   number;
		readonly languages:     readonly Language[];
		readonly files:         readonly ModuleFile[];
		readonly entities:      readonly ModuleEntity[];
		readonly publicSurface: readonly ModuleEntity[];
		/**
		 * Where the file listing came from. 'graph' = file entities
		 * from the indexed code graph (the normal path, has parsed
		 * entities). 'disk-listing' = the directory had no indexed
		 * files, so we fell back to a filesystem walk; entities[] /
		 * publicSurface[] / languages[] will be empty in this mode,
		 * but `files[]` carries the basenames the planner can probe
		 * via `code.source.file.describe` or `code.source.grep`.
		 */
		readonly source?:      'graph' | 'disk-listing';
		/**
		 * Subdirectory basenames (relative to modulePath). Only set in
		 * 'disk-listing' mode so the planner can probe deeper without
		 * a second tool call.
		 */
		readonly subdirs?:     readonly string[];
	}
	| {
		readonly found:  false;
		readonly reason: 'no-files-in-module';
	};

const TOP_LEVEL_KINDS: ReadonlySet<EntityKind> = new Set([
	'function', 'class', 'interface', 'type', 'variable', 'method',
]);

const codeSourceModuleDescribeSkill: Skill<ModuleDescribeInput, ModuleDescribeOutput> = {
	id: 'code.source.module.describe',
	name: 'Code: describe one module (directory)',
	description:
		'Summarise a module (filesystem directory of source files). Returns `{ files, entities, ' +
		'publicSurface, languages, fileCount, entityCount, publicCount }` on hit, or ' +
		'`{ found: false, reason: "no-files-in-module" }` when the directory has no indexed files.',
	family: 'source-introspection',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			modulePath: { type: 'string', description: 'Absolute directory path of the module.' },
			repoPath:   { type: 'string', description: 'Repo root absolute path the module lives in.' },
		},
		required: ['modulePath', 'repoPath'],
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
					found:         { type: 'boolean', enum: [true] },
					modulePath:    { type: 'string' },
					fileCount:     { type: 'number' },
					entityCount:   { type: 'number' },
					publicCount:   { type: 'number' },
					languages:     { type: 'array' },
					files:         { type: 'array' },
					entities:      { type: 'array' },
					publicSurface: { type: 'array' },
					source:        { type: 'string', enum: ['graph', 'disk-listing'] },
					subdirs:       { type: 'array' },
				},
				required: ['found', 'modulePath', 'fileCount', 'entityCount', 'publicCount', 'languages', 'files', 'entities', 'publicSurface'],
			},
			{
				type: 'object',
				properties: {
					found:  { type: 'boolean', enum: [false] },
					reason: { type: 'string', enum: ['no-files-in-module'] },
				},
				required: ['found', 'reason'],
			},
		],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: ModuleDescribeInput, _deps: SkillDeps): Promise<SkillResult<ModuleDescribeOutput>> {
		const all = await listEntitiesForRepo(null, input.repoPath);

		// Scope to entities whose file lives under modulePath. Use a
		// trailing-separator check so `/repo/srcExtra/foo.ts` doesn't
		// false-match a request for `/repo/src`.
		const prefix = input.modulePath.endsWith('/') ? input.modulePath : input.modulePath + '/';
		const inModule = all.filter(e => e.file === input.modulePath || e.file.startsWith(prefix));

		const files: ModuleFile[] = [];
		const entities: ModuleEntity[] = [];
		const langs = new Set<Language>();

		for (const e of inModule) {
			if (e.kind === 'file') {
				files.push({
					path:     e.file,
					language: e.language,
					endLine:  e.endLine,
					entityId: e.id,
				});
				langs.add(e.language);
			} else if (TOP_LEVEL_KINDS.has(e.kind)) {
				entities.push(toModuleEntity(e));
				langs.add(e.language);
			}
		}

		if (files.length === 0) {
			// Plan 4 Phase 1b: when the graph has nothing indexed under
			// this path, fall back to a filesystem walk. Catches the
			// case of unparsed-language dirs (docker/, deployments/,
			// config/, shell-script dirs) that the planner needs to
			// know about. Mirrors the file-read fallback we shipped
			// for code.source.file.describe.
			const fallback = await tryDiskListingFallback(input.modulePath);
			if (fallback !== null) {
				return {
					value: fallback,
					confidence: 'medium',
					notes: [`No indexed files under '${input.modulePath}'; returned a disk listing (no parsed entities).`],
					toolCalls: [],
				};
			}
			return {
				value: { found: false, reason: 'no-files-in-module' },
				confidence: 'high',
				notes: [`No indexed files under '${input.modulePath}'. Either the directory is wrong, hasn't been indexed yet, or every file is excluded by the indexer's filters.`],
				toolCalls: [],
			};
		}

		const publicSurface = entities.filter(e => e.isExported === true);

		const out: ModuleDescribeOutput = {
			found:         true,
			modulePath:    input.modulePath,
			fileCount:     files.length,
			entityCount:   entities.length,
			publicCount:   publicSurface.length,
			languages:     [...langs].sort(),
			files,
			entities,
			publicSurface,
			source:        'graph',
		};
		return {
			value: out,
			confidence: 'high',
			notes: [],
			toolCalls: [],
		};
	},
};

// ---------------------------------------------------------------------------
// Disk-listing fallback (Plan 4 Phase 1b)
// ---------------------------------------------------------------------------

const FALLBACK_EXCLUDED_DIRS = new Set<string>([
	'node_modules', '.git', '.svn', 'dist', 'build', 'out', 'target',
	'__pycache__', '.venv', 'venv', '.pytest_cache', '.cache',
]);
const FALLBACK_MAX_FILES   = 100;
const FALLBACK_MAX_SUBDIRS = 50;

async function tryDiskListingFallback(
	modulePath: string,
): Promise<Extract<ModuleDescribeOutput, { found: true }> | null> {
	try {
		const s = await stat(modulePath);
		if (!s.isDirectory()) {
			return null;
		}
	} catch {
		return null;
	}
	let entries: import('node:fs').Dirent[];
	try {
		entries = await readdir(modulePath, { withFileTypes: true });
	} catch {
		return null;
	}

	const fileBasenames: string[]   = [];
	const subdirBasenames: string[] = [];
	for (const ent of entries) {
		if (FALLBACK_EXCLUDED_DIRS.has(ent.name)) {
			continue;
		}
		if (ent.isFile()) {
			if (fileBasenames.length < FALLBACK_MAX_FILES) {
				fileBasenames.push(ent.name);
			}
		} else if (ent.isDirectory()) {
			if (subdirBasenames.length < FALLBACK_MAX_SUBDIRS) {
				subdirBasenames.push(ent.name);
			}
		}
	}

	// Build synthetic ModuleFile rows. No entityId (no graph backing),
	// no language detection (cheap fallback), no endLine; we set
	// minimal placeholder values the schema accepts.
	const syntheticFiles: ModuleFile[] = fileBasenames.map(name => ({
		path:     join(modulePath, name),
		language: 'unknown' as Language,
		endLine:  0,
		entityId: '',
	}));

	return {
		found:         true,
		modulePath,
		fileCount:     syntheticFiles.length,
		entityCount:   0,
		publicCount:   0,
		languages:     [],
		files:         syntheticFiles,
		entities:      [],
		publicSurface: [],
		source:        'disk-listing',
		subdirs:       subdirBasenames,
	};
}

function toModuleEntity(e: Entity): ModuleEntity {
	let m: ModuleEntity = {
		id:        e.id,
		name:      e.name,
		kind:      e.kind,
		file:      e.file,
		startLine: e.startLine,
		language:  e.language,
	};
	if (e.signature !== undefined && e.signature.length > 0) m = { ...m, signature: e.signature };
	if (e.isExported === true)                                m = { ...m, isExported: true };
	return m;
}

export function registerCodeSourceModuleDescribeSkill(): void {
	registerSkill(codeSourceModuleDescribeSkill as unknown as Skill);
}
