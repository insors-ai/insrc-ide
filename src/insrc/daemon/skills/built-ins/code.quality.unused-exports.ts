/**
 * code.quality.unused-exports -- find exported entities with no
 * incoming references (code-analyzer-skills.md Phase 5.4).
 *
 * Pure-graph computation:
 *   1. Enumerate every entity in the repo with isExported === true
 *      and a kind in CANDIDATE_KINDS.
 *   2. For each, check the in-edge sets {IMPORTS, CALLS, REFERENCES}.
 *      Empty intersection = unused export.
 *
 * Cap at LIMIT (200) and surface the full unusedCount so callers
 * know when they've been truncated.
 *
 * No-tool skill; the graph is the source of truth and rescanning
 * the filesystem would race with the indexer.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import { listEntitiesForRepo, entityU64ForId } from '../../../db/entities.js';
import { inNeighbors } from '../../../db/graph/edges.js';
import type { Entity, EntityKind } from '../../../shared/types.js';
import type {
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

const CANDIDATE_KINDS: ReadonlySet<EntityKind> = new Set([
	'function', 'method', 'class', 'interface', 'type', 'variable',
]);

const REFERENCE_EDGES = ['IMPORTS', 'CALLS', 'REFERENCES'] as const;

// Phase B.1: removed limit. Returns the complete set.

interface UnusedExportsInput {
	readonly repoPath: string;
	readonly kinds?:   readonly EntityKind[];
}

interface UnusedEntry {
	readonly id:        string;
	readonly name:      string;
	readonly kind:      EntityKind;
	readonly file:      string;
	readonly startLine: number;
	readonly language:  string;
	readonly signature?: string;
}

interface UnusedExportsOutput {
	readonly repoPath:    string;
	readonly candidateCount: number;
	readonly unusedCount: number;
	readonly unused:      readonly UnusedEntry[];
}

const codeQualityUnusedExportsSkill: Skill<UnusedExportsInput, UnusedExportsOutput> = {
	id: 'code.quality.unused-exports',
	name: 'Code: find exported entities with no incoming references',
	description:
		'Find exported entities (function / method / class / interface / type / variable) ' +
		'whose in-edges across IMPORTS / CALLS / REFERENCES are empty -- candidates for removal ' +
		'or downgrade to non-exported. Returns the capped list plus the full unusedCount.',
	family: 'quality-profile',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			repoPath: { type: 'string', description: 'Repo root absolute path.' },
			kinds: {
				type: 'array',
				items: { type: 'string' },
				description: 'Candidate kinds. Default: function / method / class / interface / type / variable.',
				uniqueItems: true,
				minItems: 1,
			},
		},
		required: ['repoPath'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			repoPath:       { type: 'string' },
			candidateCount: { type: 'number' },
			unusedCount:    { type: 'number' },
			unused:         { type: 'array' },
		},
		required: ['repoPath', 'candidateCount', 'unusedCount', 'unused'],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: UnusedExportsInput, deps: SkillDeps): Promise<SkillResult<UnusedExportsOutput>> {
		// Substrate: cache hit short-circuits the per-candidate in-edge walks.
		const cached = readCachedReport(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.candidateCount > 0 ? 'high' : 'low',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const kinds = input.kinds !== undefined && input.kinds.length > 0
			? new Set<EntityKind>(input.kinds)
			: CANDIDATE_KINDS;

		const all = await listEntitiesForRepo(null, input.repoPath);
		const candidates = all.filter(e => e.isExported === true && kinds.has(e.kind));

		const unused: UnusedEntry[] = [];
		for (const e of candidates) {
			const u64 = await entityU64ForId(e.id);
			if (u64 === undefined) continue;
			const refs = await inNeighbors(u64, { kindFilter: REFERENCE_EDGES });
			if (refs.length === 0) {
				unused.push(toEntry(e));
			}
		}

		const out: UnusedExportsOutput = {
			repoPath:       input.repoPath,
			candidateCount: candidates.length,
			unusedCount:    unused.length,
			unused,
		};
		pinReport(input, out, deps);
		return {
			value: out,
			confidence: candidates.length > 0 ? 'high' : 'low',
			notes: candidates.length === 0
				? [`No exported entities found in '${input.repoPath}' for kinds [${[...kinds].join(', ')}].`]
				: [],
			toolCalls: [],
		};
	},
};

function toEntry(e: Entity): UnusedEntry {
	let x: UnusedEntry = {
		id:        e.id,
		name:      e.name,
		kind:      e.kind,
		file:      e.file,
		startLine: e.startLine,
		language:  e.language,
	};
	if (e.signature !== undefined && e.signature.length > 0) x = { ...x, signature: e.signature };
	return x;
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (per plans/skills/code/code.quality.suite.md)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:code.quality.unused-exports';
const NAMESPACE = 'unused-exports-reports';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['repo-add', 'reindex', 'manual'];

function cacheKey(input: UnusedExportsInput): string {
	const kinds = input.kinds === undefined || input.kinds.length === 0
		? '*'
		: [...input.kinds].sort().join(',');
	return `${input.repoPath}::${kinds}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-report',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as UnusedExportsInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'UnusedExportsOutput',
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

function readCachedReport(input: UnusedExportsInput, deps: SkillDeps): UnusedExportsOutput | undefined {
	const slot = deps.context?.slots.get('cached-report');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<UnusedExportsOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinReport(input: UnusedExportsInput, value: UnusedExportsOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'inNeighbors' },
		payload: value,
		claims:  [`unused-exports:${cacheKey(input)}`],
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

const codeQualityUnusedExportsSkillWithSubstrate = {
	...codeQualityUnusedExportsSkill,
	...substrateExtension,
};

export function registerCodeQualityUnusedExportsSkill(): void {
	registerSkill(codeQualityUnusedExportsSkillWithSubstrate as unknown as Skill);
}
