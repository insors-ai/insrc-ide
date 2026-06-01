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
import type {
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

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
		// Substrate: cache hit short-circuits the gate + LMDB walk.
		const cached = readCachedCallers(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.found && cached.neighbors.length > 0 ? 'high' : 'medium',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const gate = await gateSourceEntity(input.entityId, input.scope ?? 'closure', deps);
		if (gate.kind === 'refusal') return gate.result;

		const all = await findCallers(null, input.entityId);
		const neighbors = all.map(toEntry);
		const value: NeighborOutput = { found: true, entityId: input.entityId, neighbors, direction: 'callers' };
		const confidence: 'high' | 'medium' = neighbors.length > 0 ? 'high' : 'medium';
		if (confidence === 'high') pinCallers(input, value, deps);
		return {
			value,
			confidence,
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
		// Substrate: cache hit short-circuits the gate + LMDB walk.
		const cached = readCachedCallees(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.found && cached.neighbors.length > 0 ? 'high' : 'medium',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const gate = await gateSourceEntity(input.entityId, input.scope ?? 'closure', deps);
		if (gate.kind === 'refusal') return gate.result;

		const all = await findCallees(null, input.entityId);
		const neighbors = all.map(toEntry);
		const value: NeighborOutput = { found: true, entityId: input.entityId, neighbors, direction: 'callees' };
		const confidence: 'high' | 'medium' = neighbors.length > 0 ? 'high' : 'medium';
		if (confidence === 'high') pinCallees(input, value, deps);
		return {
			value,
			confidence,
			notes: [],
			toolCalls: [],
		};
	},
};

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// 1-hop CALLS edges are stable per source entity until the indexer
// rewrites the graph (repo-add / reindex). 24h TTL keeps the cache
// fresh against edit drift; consumers can force-refresh via reindex.

const CALLERS_OWNER_ID: OwnerId = 'skill:code.entity.callers';
const CALLERS_NAMESPACE = 'callers';
const CALLEES_OWNER_ID: OwnerId = 'skill:code.entity.callees';
const CALLEES_NAMESPACE = 'callees';
const NEIGHBORS_TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['repo-add', 'reindex', 'manual'];

function callersCacheKey(input: NeighborInput): string {
	return input.entityId;
}

function calleesCacheKey(input: NeighborInput): string {
	return input.entityId;
}

const CALLERS_CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-callers',
		fromOwner: CALLERS_OWNER_ID,
		namespace: CALLERS_NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as NeighborInput;
			return { kind: 'byKey', key: callersCacheKey(task) };
		},
		limit: 1,
	},
];

const CALLEES_CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-callees',
		fromOwner: CALLEES_OWNER_ID,
		namespace: CALLEES_NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as NeighborInput;
			return { kind: 'byKey', key: calleesCacheKey(task) };
		},
		limit: 1,
	},
];

const CALLERS_MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   CALLERS_NAMESPACE,
		valueType:   'NeighborOutput (found:true, direction:callers)',
		autoDistill: 'always-on-success',
		indexing:    { kind: 'never' },
		ttl:         '24h',
	},
];

const CALLEES_MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   CALLEES_NAMESPACE,
		valueType:   'NeighborOutput (found:true, direction:callees)',
		autoDistill: 'always-on-success',
		indexing:    { kind: 'never' },
		ttl:         '24h',
	},
];

const callersSubstrateExtension: SubstrateSkillExtension = {
	ownerId:            CALLERS_OWNER_ID,
	schemaVersion:      1,
	interestedTriggers: INTERESTED_TRIGGERS,
	contextSlots:       CALLERS_CONTEXT_SLOTS,
	memorySchema:       CALLERS_MEMORY_SCHEMA,
	assertionInterests: [],
};

const calleesSubstrateExtension: SubstrateSkillExtension = {
	ownerId:            CALLEES_OWNER_ID,
	schemaVersion:      1,
	interestedTriggers: INTERESTED_TRIGGERS,
	contextSlots:       CALLEES_CONTEXT_SLOTS,
	memorySchema:       CALLEES_MEMORY_SCHEMA,
	assertionInterests: [],
};

function readCachedCallers(input: NeighborInput, deps: SkillDeps): NeighborOutput | undefined {
	const slot = deps.context?.slots.get('cached-callers');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<NeighborOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== callersCacheKey(input)) { return undefined; }
	return hit.value;
}

function readCachedCallees(input: NeighborInput, deps: SkillDeps): NeighborOutput | undefined {
	const slot = deps.context?.slots.get('cached-callees');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<NeighborOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== calleesCacheKey(input)) { return undefined; }
	return hit.value;
}

function pinCallers(input: NeighborInput, value: NeighborOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'findCallers' },
		payload: value,
		claims:  [`callers:${input.entityId}`],
		confidence: 0.95,
	});
	deps.workingState.pin(ref, {
		owner:     CALLERS_OWNER_ID,
		namespace: CALLERS_NAMESPACE,
		key:       callersCacheKey(input),
		kind:      'fact',
		ttlMs:     NEIGHBORS_TTL_MS,
	});
}

function pinCallees(input: NeighborInput, value: NeighborOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'findCallees' },
		payload: value,
		claims:  [`callees:${input.entityId}`],
		confidence: 0.95,
	});
	deps.workingState.pin(ref, {
		owner:     CALLEES_OWNER_ID,
		namespace: CALLEES_NAMESPACE,
		key:       calleesCacheKey(input),
		kind:      'fact',
		ttlMs:     NEIGHBORS_TTL_MS,
	});
}

const callersSkillWithSubstrate = { ...callersSkill, ...callersSubstrateExtension };
const calleesSkillWithSubstrate = { ...calleesSkill, ...calleesSubstrateExtension };

export function registerCodeEntityCallersSkill(): void {
	registerSkill(callersSkillWithSubstrate as unknown as Skill);
}

export function registerCodeEntityCalleesSkill(): void {
	registerSkill(calleesSkillWithSubstrate as unknown as Skill);
}
