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
import type {
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

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

	async execute(input: RepoDescribeInput, deps: SkillDeps): Promise<SkillResult<RepoDescribeOutput>> {
		// Substrate: cache hit short-circuits the LMDB walk.
		const cached = readCachedDescription(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: 'high',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

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

		const out: Extract<RepoDescribeOutput, { found: true }> = {
			found:        true,
			repoPath:     input.repoPath,
			fileCount,
			entityCount:  all.length - fileCount,
			kindCounts,
			languages,
			modules,
		};
		pinDescription(input, out, deps);
		return {
			value: out,
			confidence: 'high',
			notes: [],
			toolCalls: [],
		};
	},
};

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:code.source.repo.describe';
const NAMESPACE = 'repo-overviews';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['repo-add', 'reindex', 'manual'];

function cacheKey(input: RepoDescribeInput): string {
	return input.repoPath;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-description',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as RepoDescribeInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'RepoDescribeOutput (found:true)',
		autoDistill: 'always-on-success',
		indexing:    { kind: 'never' },
		ttl:         '24h',
	},
];

const substrateExtension: SubstrateSkillExtension = {
	ownerId:            OWNER_ID,
	schemaVersion:      1,
	interestedTriggers: INTERESTED_TRIGGERS,
	contextSlots:       CONTEXT_SLOTS,
	memorySchema:       MEMORY_SCHEMA,
	assertionInterests: [],
};

function readCachedDescription(
	input: RepoDescribeInput,
	deps: SkillDeps,
): Extract<RepoDescribeOutput, { found: true }> | undefined {
	const slot = deps.context?.slots.get('cached-description');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<Extract<RepoDescribeOutput, { found: true }>>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinDescription(
	input: RepoDescribeInput,
	value: Extract<RepoDescribeOutput, { found: true }>,
	deps: SkillDeps,
): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'listEntitiesForRepo' },
		payload: value,
		claims:  [`repo-described:${cacheKey(input)}`],
		confidence: 0.95,
	});
	deps.workingState.pin(ref, {
		owner:     OWNER_ID,
		namespace: NAMESPACE,
		key:       cacheKey(input),
		kind:      'fact',
		ttlMs:     TTL_MS,
	});
}

const skillWithSubstrate = { ...codeSourceRepoDescribeSkill, ...substrateExtension };

export function registerCodeSourceRepoDescribeSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
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
