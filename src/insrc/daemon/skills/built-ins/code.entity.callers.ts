/**
 * code.entity.callers -- 1-hop CALLS in-edges for an entity
 * (code-analyzer-skills.md Phase 2.3).
 *
 * Phase B.1 of plans/code-analyzer-interleaved-investigation.md
 * removed the LIMIT cap -- returns the full set; the renderer pages
 * for the LLM.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import { findCallers, findCallees } from '../../../db/search.js';
import type { Entity, EntityKind, Language } from '../../../shared/types.js';

interface NeighborInput {
	readonly entityId: string;
}

interface NeighborEntry {
	readonly id:        string;
	readonly name:      string;
	readonly kind:      EntityKind;
	readonly language:  Language;
	readonly file:      string;
	readonly startLine: number;
	readonly endLine:   number;
	readonly signature?: string;
}

interface NeighborOutput {
	readonly entityId:   string;
	readonly neighbors:  readonly NeighborEntry[];
	readonly direction:  'callers' | 'callees';
}

function toEntry(e: Entity): NeighborEntry {
	const x: NeighborEntry = {
		id:        e.id,
		name:      e.name,
		kind:      e.kind,
		language:  e.language,
		file:      e.file,
		startLine: e.startLine,
		endLine:   e.endLine,
	};
	return e.signature !== undefined && e.signature.length > 0
		? { ...x, signature: e.signature }
		: x;
}

const callersSkill: Skill<NeighborInput, NeighborOutput> = {
	id: 'code.entity.callers',
	name: 'Code: 1-hop callers (incoming CALLS)',
	description: 'Return entities that call the given target via 1-hop CALLS in-edges. Returns the COMPLETE set; renderer pages for the LLM.',
	family: 'source-introspection',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: { entityId: { type: 'string', minLength: 32, maxLength: 32 } },
		required: ['entityId'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			entityId:   { type: 'string' },
			neighbors:  { type: 'array' },
			direction:  { type: 'string', enum: ['callers', 'callees'] },
		},
		required: ['entityId', 'neighbors', 'direction'],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: NeighborInput, _deps: SkillDeps): Promise<SkillResult<NeighborOutput>> {
		const all = await findCallers(null, input.entityId);
		const neighbors = all.map(toEntry);
		return {
			value: { entityId: input.entityId, neighbors, direction: 'callers' },
			confidence: neighbors.length > 0 ? 'high' : 'medium',
			notes: [],
			toolCalls: [],
		};
	},
};

const calleesSkill: Skill<NeighborInput, NeighborOutput> = {
	id: 'code.entity.callees',
	name: 'Code: 1-hop callees (outgoing CALLS)',
	description: 'Return entities that the given source calls via 1-hop CALLS out-edges. Returns the COMPLETE set; renderer pages for the LLM.',
	family: 'source-introspection',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: { entityId: { type: 'string', minLength: 32, maxLength: 32 } },
		required: ['entityId'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			entityId:   { type: 'string' },
			neighbors:  { type: 'array' },
			direction:  { type: 'string', enum: ['callers', 'callees'] },
		},
		required: ['entityId', 'neighbors', 'direction'],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: NeighborInput, _deps: SkillDeps): Promise<SkillResult<NeighborOutput>> {
		const all = await findCallees(null, input.entityId);
		const neighbors = all.map(toEntry);
		return {
			value: { entityId: input.entityId, neighbors, direction: 'callees' },
			confidence: neighbors.length > 0 ? 'high' : 'medium',
			notes: [],
			toolCalls: [],
		};
	},
};

export function registerCodeEntityCallersSkill(): void {
	registerSkill(callersSkill as unknown as Skill);
}

export function registerCodeEntityCalleesSkill(): void {
	registerSkill(calleesSkill as unknown as Skill);
}
