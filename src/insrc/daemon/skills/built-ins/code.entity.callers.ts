/**
 * code.entity.callers -- 1-hop CALLS in-edges for an entity
 * (code-analyzer-skills.md Phase 2.3).
 *
 * Wraps `findCallers` with a typed envelope: caps at LIMIT (200)
 * and surfaces `truncated` on overflow. Mirror of
 * `code.entity.callees` (§2.4) flipped to the in direction.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import { findCallers, findCallees } from '../../../db/search.js';
import type { Entity, EntityKind, Language } from '../../../shared/types.js';

const LIMIT = 200;

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
	readonly truncated:  boolean;
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
	description: 'Return entities that call the given target via 1-hop CALLS in-edges. Caps at 200; truncated:true on overflow.',
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
			truncated:  { type: 'boolean' },
			direction:  { type: 'string', enum: ['callers', 'callees'] },
		},
		required: ['entityId', 'neighbors', 'truncated', 'direction'],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: NeighborInput, _deps: SkillDeps): Promise<SkillResult<NeighborOutput>> {
		const all = await findCallers(null, input.entityId);
		const truncated = all.length > LIMIT;
		const neighbors = all.slice(0, LIMIT).map(toEntry);
		const result: SkillResult<NeighborOutput> = {
			value: { entityId: input.entityId, neighbors, truncated, direction: 'callers' },
			confidence: neighbors.length > 0 ? 'high' : 'medium',
			notes: [],
			toolCalls: [],
		};
		return truncated ? { ...result, truncated: true } : result;
	},
};

const calleesSkill: Skill<NeighborInput, NeighborOutput> = {
	id: 'code.entity.callees',
	name: 'Code: 1-hop callees (outgoing CALLS)',
	description: 'Return entities that the given source calls via 1-hop CALLS out-edges. Caps at 200; truncated:true on overflow.',
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
			truncated:  { type: 'boolean' },
			direction:  { type: 'string', enum: ['callers', 'callees'] },
		},
		required: ['entityId', 'neighbors', 'truncated', 'direction'],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: NeighborInput, _deps: SkillDeps): Promise<SkillResult<NeighborOutput>> {
		const all = await findCallees(null, input.entityId);
		const truncated = all.length > LIMIT;
		const neighbors = all.slice(0, LIMIT).map(toEntry);
		const result: SkillResult<NeighborOutput> = {
			value: { entityId: input.entityId, neighbors, truncated, direction: 'callees' },
			confidence: neighbors.length > 0 ? 'high' : 'medium',
			notes: [],
			toolCalls: [],
		};
		return truncated ? { ...result, truncated: true } : result;
	},
};

export function registerCodeEntityCallersSkill(): void {
	registerSkill(callersSkill as unknown as Skill);
}

export function registerCodeEntityCalleesSkill(): void {
	registerSkill(calleesSkill as unknown as Skill);
}
