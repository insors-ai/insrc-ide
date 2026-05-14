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

	async execute(input: UnusedExportsInput, _deps: SkillDeps): Promise<SkillResult<UnusedExportsOutput>> {
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

export function registerCodeQualityUnusedExportsSkill(): void {
	registerSkill(codeQualityUnusedExportsSkill as unknown as Skill);
}
