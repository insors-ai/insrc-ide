/**
 * code.entity.callers -- 1-hop CALLS in-edges for an entity
 * (code-analyzer-skills.md Phase 2.3).
 *
 * Phase B.1 of plans/code-analyzer-interleaved-investigation.md
 * removed the LIMIT cap -- returns the full set; the renderer pages
 * for the LLM.
 *
 * Plan SCS Phase 5: the source entityId is now scope-checked against
 * the active session's DEPENDS_ON closure before neighbor traversal.
 * Stale / cross-repo entityIds get a typed refusal instead of a
 * silent cross-project resolution.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import { findCallers, findCallees } from '../../../db/search.js';
import { getEntity } from '../../../db/entities.js';
import { isRepoInScope, SCOPE_SCHEMA_FRAGMENT, type SearchScope } from '../scope-helpers.js';
import type { Entity, EntityKind, Language } from '../../../shared/types.js';

interface NeighborInput {
	readonly entityId: string;
	readonly scope?:   SearchScope;
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

type NeighborOutput =
	| {
		readonly found:     true;
		readonly entityId:  string;
		readonly neighbors: readonly NeighborEntry[];
		readonly direction: 'callers' | 'callees';
	}
	| {
		readonly found:  false;
		readonly reason: 'entity-not-found' | 'entity-out-of-scope';
	};

const OUTPUT_SCHEMA = {
	type: 'object',
	properties: { found: { type: 'boolean' } },
	required: ['found'],
	oneOf: [
		{
			type: 'object',
			properties: {
				found:     { type: 'boolean', enum: [true] },
				entityId:  { type: 'string' },
				neighbors: { type: 'array' },
				direction: { type: 'string', enum: ['callers', 'callees'] },
			},
			required: ['found', 'entityId', 'neighbors', 'direction'],
		},
		{
			type: 'object',
			properties: {
				found:  { type: 'boolean', enum: [false] },
				reason: { type: 'string', enum: ['entity-not-found', 'entity-out-of-scope'] },
			},
			required: ['found', 'reason'],
		},
	],
};

const INPUT_SCHEMA = {
	type: 'object',
	properties: {
		entityId: { type: 'string', minLength: 32, maxLength: 32 },
		scope:    SCOPE_SCHEMA_FRAGMENT,
	},
	required: ['entityId'],
	additionalProperties: false,
};

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

/**
 * Source-entity scope gate shared by callers + callees. Returns
 * either the resolved source (when in-scope) or a refusal-shaped
 * SkillResult ready to return verbatim. Avoids duplicating the
 * getEntity + isRepoInScope dance in each skill.
 */
async function gateSourceEntity(
	entityId: string,
	scope: SearchScope,
	deps: SkillDeps,
): Promise<{ kind: 'ok'; entity: Entity } | { kind: 'refusal'; result: SkillResult<NeighborOutput> }> {
	const src = await getEntity(null, entityId);
	if (src === null) {
		return {
			kind: 'refusal',
			result: {
				value: { found: false, reason: 'entity-not-found' },
				confidence: 'high',
				notes: [`Entity '${entityId}' not in the graph.`],
				toolCalls: [],
			},
		};
	}
	if (!isRepoInScope(deps, src.repo, scope)) {
		return {
			kind: 'refusal',
			result: {
				value: { found: false, reason: 'entity-out-of-scope' },
				confidence: 'high',
				notes: [
					`Entity '${entityId}' resolves to repo '${src.repo}', which is not in the ` +
					"active session's dependency closure. Re-run with `scope: 'global'` if you " +
					'really want cross-project resolution.',
				],
				toolCalls: [],
			},
		};
	}
	return { kind: 'ok', entity: src };
}

const callersSkill: Skill<NeighborInput, NeighborOutput> = {
	id: 'code.entity.callers',
	name: 'Code: 1-hop callers (incoming CALLS)',
	description:
		'Return entities that call the given target via 1-hop CALLS in-edges. Scoped to the ' +
		"active repo's dependency closure by default. Returns `{ found: false, reason: " +
		'"entity-not-found" | "entity-out-of-scope" }` when the source id is unknown or ' +
		'resolves outside the closure.',
	family: 'source-introspection',
	owner: 'code-analyzer',
	version: 1,
	inputs:  INPUT_SCHEMA,
	outputs: OUTPUT_SCHEMA,
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: NeighborInput, deps: SkillDeps): Promise<SkillResult<NeighborOutput>> {
		const gate = await gateSourceEntity(input.entityId, input.scope ?? 'closure', deps);
		if (gate.kind === 'refusal') return gate.result;

		const all = await findCallers(null, input.entityId);
		const neighbors = all.map(toEntry);
		return {
			value: { found: true, entityId: input.entityId, neighbors, direction: 'callers' },
			confidence: neighbors.length > 0 ? 'high' : 'medium',
			notes: [],
			toolCalls: [],
		};
	},
};

const calleesSkill: Skill<NeighborInput, NeighborOutput> = {
	id: 'code.entity.callees',
	name: 'Code: 1-hop callees (outgoing CALLS)',
	description:
		'Return entities that the given source calls via 1-hop CALLS out-edges. Scoped to the ' +
		"active repo's dependency closure by default. Returns `{ found: false, reason: " +
		'"entity-not-found" | "entity-out-of-scope" }` when the source id is unknown or ' +
		'resolves outside the closure.',
	family: 'source-introspection',
	owner: 'code-analyzer',
	version: 1,
	inputs:  INPUT_SCHEMA,
	outputs: OUTPUT_SCHEMA,
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: NeighborInput, deps: SkillDeps): Promise<SkillResult<NeighborOutput>> {
		const gate = await gateSourceEntity(input.entityId, input.scope ?? 'closure', deps);
		if (gate.kind === 'refusal') return gate.result;

		const all = await findCallees(null, input.entityId);
		const neighbors = all.map(toEntry);
		return {
			value: { found: true, entityId: input.entityId, neighbors, direction: 'callees' },
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
