/**
 * code.entity.summary -- typed metadata + body excerpt for one
 * entity (code-analyzer-skills.md Phase 2.2).
 *
 * Wraps `getEntity` with an output shape oriented toward a
 * caller-readable summary card: the headline metadata plus a
 * length-capped excerpt of the body. Used by the future planner
 * step that needs to decide whether to drill down into an
 * entity's children before answering.
 *
 * The excerpt is:
 *   - first BODY_HEAD_LINES of the body (default 10), trimmed
 *   - capped at BODY_MAX_CHARS (default 800) with `... <truncated>`
 *     marker when the line slice exceeded the char cap
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import { getEntity } from '../../../db/entities.js';
import type { Entity, EntityKind, Language } from '../../../shared/types.js';
import { tryReadFileForFallback } from './_fallback-file-read.js';

const BODY_HEAD_LINES = 10;
const BODY_MAX_CHARS  = 800;

interface SummaryInput {
	readonly entityId: string;
	/**
	 * Optional cap on the body excerpt's character length. Defaults to
	 * BODY_MAX_CHARS (800). The legacy `code_describe` cross-agent tool
	 * passes a larger cap (4000) so back-compat callers see the same
	 * body slice they used to. Floors the value at 1 char (defensive
	 * against zero / negative); the upper bound is the entity body
	 * length itself.
	 */
	readonly excerptMaxChars?: number;
}

type SummaryOutput =
	| {
		readonly found:     true;
		readonly entityId:  string;
		readonly name:      string;
		readonly kind:      EntityKind;
		readonly language:  Language;
		readonly file:      string;
		readonly startLine: number;
		readonly endLine:   number;
		readonly signature?: string;
		readonly isExported?: boolean;
		readonly isAbstract?: boolean;
		readonly isAsync?:    boolean;
		readonly excerpt:   string;
		readonly excerptTruncated: boolean;
		/**
		 * Where the excerpt came from. 'graph' = the entity's parsed body
		 * (the normal path). 'file-fallback' = the entity's body was empty
		 * in the graph (typical for config-file kinds like Dockerfile /
		 * YAML / shell scripts that aren't parsed by tree-sitter), so we
		 * read the file directly from disk. Callers can use this to know
		 * the excerpt represents raw file contents, not a parsed slice.
		 */
		readonly excerptSource: 'graph' | 'file-fallback';
	}
	| {
		readonly found:  false;
		readonly reason: 'entity-not-found';
	};

const codeEntitySummarySkill: Skill<SummaryInput, SummaryOutput> = {
	id: 'code.entity.summary',
	name: 'Code: summary card for one entity',
	description:
		'Return typed metadata + a capped body excerpt for one entity. Returns ' +
		'`{ found: false, reason: "entity-not-found" }` when the id isn\'t in the graph.',
	family: 'source-introspection',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			entityId: { type: 'string', description: '32-char hex entity id from another lookup skill.', minLength: 32, maxLength: 32 },
			excerptMaxChars: { type: 'number', description: 'Optional cap on body excerpt chars; default 800.', minimum: 1, maximum: 65536 },
		},
		required: ['entityId'],
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
					found:     { type: 'boolean', enum: [true] },
					entityId:  { type: 'string' },
					name:      { type: 'string' },
					kind:      { type: 'string' },
					language:  { type: 'string' },
					file:      { type: 'string' },
					startLine: { type: 'number' },
					endLine:   { type: 'number' },
					signature: { type: 'string' },
					isExported: { type: 'boolean' },
					isAbstract: { type: 'boolean' },
					isAsync:    { type: 'boolean' },
					excerpt:   { type: 'string' },
					excerptTruncated: { type: 'boolean' },
					excerptSource:    { type: 'string', enum: ['graph', 'file-fallback'] },
				},
				required: ['found', 'entityId', 'name', 'kind', 'language', 'file', 'startLine', 'endLine', 'excerpt', 'excerptTruncated', 'excerptSource'],
			},
			{
				type: 'object',
				properties: {
					found:  { type: 'boolean', enum: [false] },
					reason: { type: 'string', enum: ['entity-not-found'] },
				},
				required: ['found', 'reason'],
			},
		],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: SummaryInput, _deps: SkillDeps): Promise<SkillResult<SummaryOutput>> {
		const e = await getEntity(null, input.entityId);
		if (e === null) {
			return {
				value: { found: false, reason: 'entity-not-found' },
				confidence: 'high',
				notes: [`Entity '${input.entityId}' not in the graph.`],
				toolCalls: [],
			};
		}

		const maxChars = typeof input.excerptMaxChars === 'number' && input.excerptMaxChars >= 1
			? input.excerptMaxChars
			: BODY_MAX_CHARS;

		// Normal path: entity's parsed body is non-empty, use it.
		if (e.body.length > 0) {
			const { excerpt, truncated } = buildExcerpt(e.body, maxChars);
			const out = assembleFound(e, excerpt, truncated, 'graph');
			return {
				value: out,
				confidence: 'high',
				notes: [],
				toolCalls: [],
			};
		}

		// Fallback path: body is empty in the graph -- typical for
		// `kind: 'file'` entities of formats tree-sitter doesn't parse
		// (Dockerfile, YAML, shell, TOML, ...). Read the file from disk
		// so the caller gets something to cite instead of an empty
		// excerpt that the writer would render as a content-free
		// citation. See plans/file-read-fallback-for-skills (TBD).
		const fb = await tryReadFileForFallback(e.file, maxChars);
		if (fb.ok) {
			const { excerpt, truncated } = buildExcerpt(fb.content, maxChars);
			const out = assembleFound(e, excerpt, truncated || fb.truncated, 'file-fallback');
			return {
				value: out,
				confidence: 'medium',
				notes: [`graph body empty (${e.language} file); read excerpt from disk (${fb.byteSize} bytes)`],
				toolCalls: [],
			};
		}

		// Even the file-read fallback failed (missing on disk, binary,
		// oversized, etc.). Honest empty result -- callers will see
		// excerpt='' and excerptSource='graph' and degrade as before.
		const out = assembleFound(e, '', false, 'graph');
		return {
			value: out,
			confidence: 'low',
			notes: [`graph body empty AND disk read failed: ${fb.reason}`],
			toolCalls: [],
		};
	},
};

function buildExcerpt(body: string, maxChars: number = BODY_MAX_CHARS): { excerpt: string; truncated: boolean } {
	if (body.length === 0) return { excerpt: '', truncated: false };
	const lines = body.split('\n').slice(0, BODY_HEAD_LINES);
	const head  = lines.join('\n');
	if (head.length <= maxChars && lines.length === body.split('\n').length) {
		return { excerpt: head, truncated: false };
	}
	if (head.length > maxChars) {
		return { excerpt: head.slice(0, maxChars) + '\n... <truncated>', truncated: true };
	}
	return { excerpt: head + '\n... <truncated>', truncated: true };
}

function assembleFound(
	e: Entity,
	excerpt: string,
	excerptTruncated: boolean,
	excerptSource: 'graph' | 'file-fallback',
): SummaryOutput {
	type Found = Extract<SummaryOutput, { found: true }>;
	let out: Found = {
		found:     true,
		entityId:  e.id,
		name:      e.name,
		kind:      e.kind,
		language:  e.language,
		file:      e.file,
		startLine: e.startLine,
		endLine:   e.endLine,
		excerpt,
		excerptTruncated,
		excerptSource,
	};
	if (e.signature !== undefined && e.signature.length > 0) out = { ...out, signature: e.signature };
	if (e.isExported === true) out = { ...out, isExported: true };
	if (e.isAbstract === true) out = { ...out, isAbstract: true };
	if (e.isAsync    === true) out = { ...out, isAsync: true };
	return out;
}

export function registerCodeEntitySummarySkill(): void {
	registerSkill(codeEntitySummarySkill as unknown as Skill);
}

// Test exports.
export const _buildExcerptForTest = buildExcerpt;
