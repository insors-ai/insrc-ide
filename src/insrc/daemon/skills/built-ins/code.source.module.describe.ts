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
		};
		return {
			value: out,
			confidence: 'high',
			notes: [],
			toolCalls: [],
		};
	},
};

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
