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
import type {
	AssertionInterest,
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

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

	async execute(input: ModuleDescribeInput, deps: SkillDeps): Promise<SkillResult<ModuleDescribeOutput>> {
		const notes: string[] = [];

		// Substrate: cache hit short-circuits the LMDB walk.
		const cached = readCachedDescription(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: 'high',
				notes: [...notes, 'from cache (substrate)'],
				toolCalls: [],
			};
		}

		// Substrate: recent-miss short-circuits the LMDB walk + disk
		// listing fallback for known-empty modules.
		const missCached = readRecentMiss(input, deps);
		if (missCached !== undefined) {
			return {
				value: { found: false, reason: 'no-files-in-module' },
				confidence: 'high',
				notes: [...notes, 'from miss cache (substrate)'],
				toolCalls: [],
			};
		}

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
			//
			// Substrate: disk-listing is intentionally NOT cached --
			// the filesystem can change in ways the substrate can't
			// track. Only the clean refusal lands in recent-misses.
			const fallback = await tryDiskListingFallback(input.modulePath);
			if (fallback !== null) {
				return {
					value: fallback,
					confidence: 'medium',
					notes: [`No indexed files under '${input.modulePath}'; returned a disk listing (no parsed entities).`],
					toolCalls: [],
				};
			}
			pinRecentMiss(input, deps);
			return {
				value: { found: false, reason: 'no-files-in-module' },
				confidence: 'high',
				notes: [`No indexed files under '${input.modulePath}'. Either the directory is wrong, hasn't been indexed yet, or every file is excluded by the indexer's filters.`],
				toolCalls: [],
			};
		}

		const publicSurface = entities.filter(e => e.isExported === true);

		const out: Extract<ModuleDescribeOutput, { found: true }> = {
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

		pinSuccessfulDescription(input, out, deps);

		return {
			value: out,
			confidence: 'high',
			notes,
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

// ---------------------------------------------------------------------------
// Substrate-facing declarations (per plans/skills/code/code.source.module.describe.md)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:code.source.module.describe';

const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = [
	'repo-add', 'reindex', 'manual',
];

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	// 1. Cache hit path. Key is `<repoPath>::<modulePath>`.
	{
		name:      'cached-description',
		fromOwner: OWNER_ID,
		namespace: 'module-descriptions',
		query: (req) => {
			const task = (req.task ?? {}) as ModuleDescribeInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},

	// 2. Recent-miss negative cache (no indexed files under modulePath).
	{
		name:      'recent-misses',
		fromOwner: OWNER_ID,
		namespace: 'recent-misses',
		query: (req) => {
			const task = (req.task ?? {}) as ModuleDescribeInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   'module-descriptions',
		valueType:   'ModuleDescribeOutput (found:true)',
		autoDistill: 'always-on-success',
		indexing:    { kind: 'never' },
		ttl:         '7d',
	},
	{
		namespace:   'recent-misses',
		valueType:   'MissRecord',
		autoDistill: 'always-on-success',
		indexing:    { kind: 'never' },
		ttl:         '24h',
	},
	{
		// Declared for the eventual L2 distillation path; no writes yet.
		namespace:   'observations',
		valueType:   'WorkspacePatternObservation',
		autoDistill: 'never',
		indexing:    { kind: 'never' },
		ttl:         '30d',
	},
];

const ASSERTION_INTERESTS: readonly AssertionInterest[] = [
	{
		subjectPattern: 'module-boundary',
		description: 'how a workspace defines what counts as a module (treat src/legacy as one, ignore generated dirs, etc.)',
	},
];

const substrateExtension: SubstrateSkillExtension = {
	ownerId:            OWNER_ID,
	schemaVersion:      1,
	interestedTriggers: INTERESTED_TRIGGERS,
	contextSlots:       CONTEXT_SLOTS,
	memorySchema:       MEMORY_SCHEMA,
	assertionInterests: ASSERTION_INTERESTS,
};

// ---------------------------------------------------------------------------
// Substrate helpers
// ---------------------------------------------------------------------------

interface MissValue {
	readonly modulePath:  string;
	readonly repoPath:    string;
	readonly attemptedAt: number;
}

function cacheKey(input: ModuleDescribeInput): string {
	return `${input.repoPath}::${input.modulePath}`;
}

function readCachedDescription(
	input: ModuleDescribeInput,
	deps: SkillDeps,
): Extract<ModuleDescribeOutput, { found: true }> | undefined {
	const slot = deps.context?.slots.get('cached-description');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<Extract<ModuleDescribeOutput, { found: true }>>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function readRecentMiss(input: ModuleDescribeInput, deps: SkillDeps): MissValue | undefined {
	const slot = deps.context?.slots.get('recent-misses');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<MissValue>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinSuccessfulDescription(
	input: ModuleDescribeInput,
	value: Extract<ModuleDescribeOutput, { found: true }>,
	deps: SkillDeps,
): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'listEntitiesForRepo' },
		payload: value,
		claims:  [`module-described:${input.modulePath}`],
		confidence: 0.95,
	});
	deps.workingState.pin(ref, {
		owner:     OWNER_ID,
		namespace: 'module-descriptions',
		key:       cacheKey(input),
		kind:      'fact',
		ttlMs:     7 * 24 * 60 * 60 * 1000,
	});
}

function pinRecentMiss(input: ModuleDescribeInput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const payload: MissValue = {
		modulePath:  input.modulePath,
		repoPath:    input.repoPath,
		attemptedAt: Date.now(),
	};
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'listEntitiesForRepo' },
		payload,
		claims:  [`module-miss:${input.modulePath}`],
		confidence: 0.9,
	});
	deps.workingState.pin(ref, {
		owner:     OWNER_ID,
		namespace: 'recent-misses',
		key:       cacheKey(input),
		kind:      'fact',
		ttlMs:     24 * 60 * 60 * 1000,
	});
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const codeSourceModuleDescribeSkillWithSubstrate = {
	...codeSourceModuleDescribeSkill,
	...substrateExtension,
};

export function registerCodeSourceModuleDescribeSkill(): void {
	registerSkill(codeSourceModuleDescribeSkillWithSubstrate as unknown as Skill);
}

// Test exports.
export const _cacheKeyForTest = cacheKey;
