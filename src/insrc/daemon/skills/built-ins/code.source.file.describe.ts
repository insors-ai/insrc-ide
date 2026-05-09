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

	async execute(input: FileDescribeInput, _deps: SkillDeps): Promise<SkillResult<FileDescribeOutput>> {
		const fileEntityId = makeFileEntityId(input.repoPath, input.file);
		const fileEntity   = await getEntity(null, fileEntityId);

		if (fileEntity === null || fileEntity.kind !== 'file') {
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

		const out: FileDescribeOutput = {
			found:        true,
			file:         input.file,
			language:     fileEntity.language,
			fileEntityId,
			startLine:    fileEntity.startLine,
			endLine:      fileEntity.endLine,
			entityCount:  entities.length,
			entities,
			imports:      importRefs,
		};
		return {
			value: out,
			confidence: 'high',
			notes: [],
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

export function registerCodeSourceFileDescribeSkill(): void {
	registerSkill(codeSourceFileDescribeSkill as unknown as Skill);
}

// Test exports.
export const _makeFileEntityIdForTest = makeFileEntityId;
