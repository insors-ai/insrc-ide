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

const BODY_HEAD_LINES = 10;
const BODY_MAX_CHARS  = 800;

interface SummaryInput {
	readonly entityId: string;
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
				},
				required: ['found', 'entityId', 'name', 'kind', 'language', 'file', 'startLine', 'endLine', 'excerpt', 'excerptTruncated'],
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

		const { excerpt, truncated } = buildExcerpt(e.body);
		const out = assembleFound(e, excerpt, truncated);
		return {
			value: out,
			confidence: 'high',
			notes: [],
			toolCalls: [],
		};
	},
};

function buildExcerpt(body: string): { excerpt: string; truncated: boolean } {
	if (body.length === 0) return { excerpt: '', truncated: false };
	const lines = body.split('\n').slice(0, BODY_HEAD_LINES);
	const head  = lines.join('\n');
	if (head.length <= BODY_MAX_CHARS && lines.length === body.split('\n').length) {
		return { excerpt: head, truncated: false };
	}
	if (head.length > BODY_MAX_CHARS) {
		return { excerpt: head.slice(0, BODY_MAX_CHARS) + '\n... <truncated>', truncated: true };
	}
	return { excerpt: head + '\n... <truncated>', truncated: true };
}

function assembleFound(e: Entity, excerpt: string, excerptTruncated: boolean): SummaryOutput {
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
