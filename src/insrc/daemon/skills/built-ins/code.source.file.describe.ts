/**
 * code.source.file.describe -- enumerate one file's entities + imports
 * (code-analyzer-skills.md Phase 1.1).
 *
 * Pure-graph computation -- no `runTool` round-trip. The file
 * entity's id is deterministic (`SHA256(repo + file + 'file' +
 * file)`); resolve it once, walk DEFINES out-edges for the entity
 * children and IMPORTS out-edges for the import targets.
 *
 * Output discriminator: `{ found: true, ... }` vs `{ found: false,
 * reason: 'file-not-indexed' }`. Callers can refuse cleanly when a
 * path isn't in the index without inventing a child list.
 */

import { createHash } from 'node:crypto';
import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import { getEntity } from '../../../db/entities.js';
import { findDefinedIn, findImports } from '../../../db/search.js';
import type { Entity, EntityKind, Language } from '../../../shared/types.js';
import { tryReadFileForFallback } from './_fallback-file-read.js';
import type {
	AssertionInterest,
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

interface FileDescribeInput {
	readonly file:     string;
	readonly repoPath: string;
}

interface ChildEntity {
	readonly id:         string;
	readonly name:       string;
	readonly kind:       EntityKind;
	readonly startLine:  number;
	readonly endLine:    number;
	readonly signature?: string;
	readonly isExported?: boolean;
}

interface ImportRef {
	readonly target:   string;
	readonly resolved: boolean;
}

type FileDescribeOutput =
	| {
		readonly found:        true;
		readonly file:         string;
		readonly language:     Language;
		readonly fileEntityId: string;
		readonly startLine:    number;
		readonly endLine:      number;
		readonly entityCount:  number;
		readonly entities:     readonly ChildEntity[];
		readonly imports:      readonly ImportRef[];
		/**
		 * Head of the file contents, populated when the graph has no
		 * parsed children for this file (typical for config-file kinds
		 * like Dockerfile / YAML / shell / TOML that tree-sitter doesn't
		 * parse). Lets the caller cite something concrete instead of a
		 * 0-entity, 0-import shell. Absent when the graph already has
		 * structural data (the normal path -- the LLM should read the
		 * structured entities, not raw text).
		 */
		readonly bodyExcerpt?:       string;
		readonly bodyExcerptTruncated?: boolean;
		readonly bodyExcerptSource?:   'file-fallback';
	}
	| {
		readonly found:  false;
		readonly reason: 'file-not-indexed';
	};

function makeFileEntityId(repo: string, file: string): string {
	return createHash('sha256')
		.update(`${repo}\x00${file}\x00file\x00${file}`)
		.digest('hex')
		.slice(0, 32);
}

const codeSourceFileDescribeSkill: Skill<FileDescribeInput, FileDescribeOutput> = {
	id: 'code.source.file.describe',
	name: 'Code: describe one file',
	description:
		'Enumerate the entities (functions / classes / methods / ...) defined in one file plus its ' +
		'imports. Returns `{ found: true, language, entities, imports }` on hit, or ' +
		'`{ found: false, reason: "file-not-indexed" }` when the path isn\'t in the graph.',
	family: 'source-introspection',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			file:     { type: 'string', description: 'Absolute file path.' },
			repoPath: { type: 'string', description: 'Repo root absolute path (the workspace the file lives in).' },
		},
		required: ['file', 'repoPath'],
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
					found:        { type: 'boolean', enum: [true] },
					file:         { type: 'string' },
					language:     { type: 'string' },
					fileEntityId: { type: 'string' },
					startLine:    { type: 'number' },
					endLine:      { type: 'number' },
					entityCount:  { type: 'number' },
					entities:     { type: 'array' },
					imports:      { type: 'array' },
					bodyExcerpt:          { type: 'string' },
					bodyExcerptTruncated: { type: 'boolean' },
					bodyExcerptSource:    { type: 'string', enum: ['file-fallback'] },
				},
				required: ['found', 'file', 'language', 'fileEntityId', 'startLine', 'endLine', 'entityCount', 'entities', 'imports'],
			},
			{
				type: 'object',
				properties: {
					found:  { type: 'boolean', enum: [false] },
					reason: { type: 'string', enum: ['file-not-indexed'] },
				},
				required: ['found', 'reason'],
			},
		],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: FileDescribeInput, deps: SkillDeps): Promise<SkillResult<FileDescribeOutput>> {
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

		// Substrate: recent-miss short-circuits for known-not-indexed files.
		const missCached = readRecentMiss(input, deps);
		if (missCached !== undefined) {
			return {
				value: { found: false, reason: 'file-not-indexed' },
				confidence: 'high',
				notes: ['from miss cache (substrate)'],
				toolCalls: [],
			};
		}

		const fileEntityId = makeFileEntityId(input.repoPath, input.file);
		const fileEntity   = await getEntity(null, fileEntityId);

		if (fileEntity === null || fileEntity.kind !== 'file') {
			pinRecentMiss(input, deps);
			return {
				value: { found: false, reason: 'file-not-indexed' },
				confidence: 'high',
				notes: [`File '${input.file}' not found in the graph for repo '${input.repoPath}'. Either the path is wrong or the indexer hasn't seen it yet.`],
				toolCalls: [],
			};
		}

		const [definedIn, imports] = await Promise.all([
			findDefinedIn(null, fileEntityId),
			findImports(null, fileEntityId),
		]);

		// Top-level entities only -- exclude method / variable children
		// of classes (those are reachable via class.describe). The
		// DEFINES walk yields direct children of the file entity, which
		// is what we want; the file entity defines functions / classes /
		// modules at top-level, classes define their methods.
		const entities = definedIn.map(toChildEntity);
		const importRefs = imports.map(e => ({ target: e.name, resolved: e.kind !== 'module' || e.repo !== '' }));

		// Fallback: when the graph has the file row but zero parsed
		// children AND zero imports, the file is almost certainly a
		// format tree-sitter doesn't parse (Dockerfile / YAML / shell /
		// TOML / SQL). Read the file from disk so the caller has
		// something concrete to cite. Without this branch the analyzer
		// emits 0-evidence sections for deployment/config-heavy topics.
		const isStructurallyEmpty = entities.length === 0 && importRefs.length === 0;
		let bodyExcerpt: string | undefined;
		let bodyExcerptTruncated: boolean | undefined;
		let bodyExcerptSource: 'file-fallback' | undefined;
		const fallbackNotes: string[] = [];
		if (isStructurallyEmpty) {
			const fb = await tryReadFileForFallback(input.file);
			if (fb.ok) {
				bodyExcerpt          = fb.content;
				bodyExcerptTruncated = fb.truncated;
				bodyExcerptSource    = 'file-fallback';
				fallbackNotes.push(`graph has no parsed children for ${fileEntity.language} file; read excerpt from disk (${fb.byteSize} bytes)`);
			} else {
				fallbackNotes.push(`graph has no parsed children; disk fallback also failed: ${fb.reason}`);
			}
		}

		const out: Extract<FileDescribeOutput, { found: true }> = {
			found:        true,
			file:         input.file,
			language:     fileEntity.language,
			fileEntityId,
			startLine:    fileEntity.startLine,
			endLine:      fileEntity.endLine,
			entityCount:  entities.length,
			entities,
			imports:      importRefs,
			...(bodyExcerpt          !== undefined ? { bodyExcerpt }          : {}),
			...(bodyExcerptTruncated !== undefined ? { bodyExcerptTruncated } : {}),
			...(bodyExcerptSource    !== undefined ? { bodyExcerptSource }    : {}),
		};
		const confidence: 'high' | 'medium' | 'low' = isStructurallyEmpty
			? (bodyExcerpt !== undefined ? 'medium' : 'low')
			: 'high';

		// Substrate: only cache the high-confidence graph-backed shape.
		// Disk-fallback payloads (bodyExcerpt) intentionally stay fresh --
		// the filesystem mutates outside the substrate's knowledge.
		if (confidence === 'high') {
			pinSuccessfulDescription(input, out, deps);
		}

		return {
			value: out,
			confidence,
			notes: fallbackNotes,
			toolCalls: [],
		};
	},
};

function toChildEntity(e: Entity): ChildEntity {
	let c: ChildEntity = {
		id:        e.id,
		name:      e.name,
		kind:      e.kind,
		startLine: e.startLine,
		endLine:   e.endLine,
	};
	if (e.signature !== undefined && e.signature.length > 0) c = { ...c, signature: e.signature };
	if (e.isExported === true)                                c = { ...c, isExported: true };
	return c;
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (per plans/skills/code/code.source.file.describe.md)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:code.source.file.describe';

const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = [
	'repo-add', 'reindex', 'manual',
];

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-description',
		fromOwner: OWNER_ID,
		namespace: 'file-descriptions',
		query: (req) => {
			const task = (req.task ?? {}) as FileDescribeInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
	{
		name:      'recent-misses',
		fromOwner: OWNER_ID,
		namespace: 'recent-misses',
		query: (req) => {
			const task = (req.task ?? {}) as FileDescribeInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   'file-descriptions',
		valueType:   'FileDescribeOutput (found:true, confidence:high)',
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
		namespace:   'observations',
		valueType:   'WorkspacePatternObservation',
		autoDistill: 'never',
		indexing:    { kind: 'never' },
		ttl:         '30d',
	},
];

const ASSERTION_INTERESTS: readonly AssertionInterest[] = [];

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
	readonly file:        string;
	readonly repoPath:    string;
	readonly attemptedAt: number;
}

function cacheKey(input: FileDescribeInput): string {
	return `${input.repoPath}::${input.file}`;
}

function readCachedDescription(
	input: FileDescribeInput,
	deps: SkillDeps,
): Extract<FileDescribeOutput, { found: true }> | undefined {
	const slot = deps.context?.slots.get('cached-description');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<Extract<FileDescribeOutput, { found: true }>>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function readRecentMiss(input: FileDescribeInput, deps: SkillDeps): MissValue | undefined {
	const slot = deps.context?.slots.get('recent-misses');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<MissValue>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinSuccessfulDescription(
	input: FileDescribeInput,
	value: Extract<FileDescribeOutput, { found: true }>,
	deps: SkillDeps,
): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'getEntity+findDefinedIn+findImports' },
		payload: value,
		claims:  [`file-described:${input.file}`],
		confidence: 0.95,
	});
	deps.workingState.pin(ref, {
		owner:     OWNER_ID,
		namespace: 'file-descriptions',
		key:       cacheKey(input),
		kind:      'fact',
		ttlMs:     7 * 24 * 60 * 60 * 1000,
	});
}

function pinRecentMiss(input: FileDescribeInput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const payload: MissValue = { file: input.file, repoPath: input.repoPath, attemptedAt: Date.now() };
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'getEntity' },
		payload,
		claims:  [`file-miss:${input.file}`],
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

const codeSourceFileDescribeSkillWithSubstrate = {
	...codeSourceFileDescribeSkill,
	...substrateExtension,
};

export function registerCodeSourceFileDescribeSkill(): void {
	registerSkill(codeSourceFileDescribeSkillWithSubstrate as unknown as Skill);
}

// Test exports.
export const _makeFileEntityIdForTest = makeFileEntityId;
export const _cacheKeyForTest         = cacheKey;
