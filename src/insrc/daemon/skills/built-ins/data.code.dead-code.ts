/**
 * data.code.dead-code -- find unreachable code entities in a repo.
 *
 * Phase 8.1 of plans/storage-migration-lmdb-lance.md. The headline
 * value-delivery the LMDB substrate migration was built to unblock:
 * a typed, repo-scoped reachability analysis on top of the
 * `unreachable()` graph primitive (Phase 4.3).
 *
 * Algorithm:
 *
 *   1. Resolve entry-point set:
 *        - If the caller supplied `entryPoints`, use them verbatim.
 *        - Otherwise, scan `listEntitiesForRepo(repo)` for every
 *          entity whose `isExported === true` and whose `kind` is
 *          in `candidateKinds`. These are the roots the analysis
 *          treats as "alive by definition" (exported = part of the
 *          repo's public surface).
 *
 *   2. Compute the reachable closure outward from those roots
 *      across `relationKinds` (default: CALLS / IMPORTS / INHERITS
 *      / IMPLEMENTS / REFERENCES). Anything reachable is alive.
 *
 *   3. Yield entities of `candidateKinds` that are NOT in the
 *      reachable closure -- the dead set. Filter the global result
 *      to the active repo (the underlying primitive is repo-blind
 *      by design; scoping is the domain layer's job, see
 *      Phase 4.3 design notes).
 *
 *   4. Cap output at `limit` (default 200) and surface the full
 *      `deadCount` separately so the caller knows when results are
 *      truncated.
 *
 * Confidence:
 *
 *   - `low`  if no roots could be resolved (no exported entities in
 *            the repo and no entryPoints supplied) -- the answer
 *            "everything is dead" is technically correct but useless.
 *   - `high` otherwise.
 *
 * Does NOT call any registered tool. The skill exposes the typed
 * graph layer directly because reachability is a pure-graph
 * computation; wrapping it in a tool round-trip would just add
 * marshaling overhead without adding capability. Compare
 * data.lineage.read-write-callsites which wraps `data_lineage`
 * because lineage has snippet-extraction nuance the tool layer owns.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import type { Entity, EntityKind, RelationKind } from '../../../shared/types.js';
import { listEntitiesForRepo } from '../../../db/entities.js';
import { unreachableEntities } from '../../../db/search.js';

const DEFAULT_CANDIDATE_KINDS: readonly EntityKind[] = [
	'function', 'method', 'class', 'interface', 'type', 'variable',
];

const DEFAULT_RELATION_KINDS: readonly RelationKind[] = [
	'CALLS', 'IMPORTS', 'INHERITS', 'IMPLEMENTS', 'REFERENCES',
];

// `limit` removed in Phase B.1 of plans/code-analyzer-interleaved-investigation.md.
// Skills return the COMPLETE unreachable set; the renderer projects a first page
// for the LLM and the rest is reachable via skill_load_page over the on-disk spill.

interface DeadCodeInput {
	readonly repo:           string;
	readonly entryPoints?:   readonly string[];
	readonly candidateKinds?: readonly EntityKind[];
	readonly relationKinds?:  readonly RelationKind[];
	readonly maxDepth?:       number;
}

interface DeadEntity {
	readonly id:        string;
	readonly name:      string;
	readonly kind:      EntityKind;
	readonly file:      string;
	readonly startLine: number;
	readonly endLine:   number;
	readonly language:  string;
	readonly signature?: string;
}

interface DeadCodeOutput {
	readonly repo:       string;
	readonly rootCount:  number;
	readonly deadCount:  number;
	readonly dead:       readonly DeadEntity[];
}

const dataCodeDeadCodeSkill: Skill<DeadCodeInput, DeadCodeOutput> = {
	id: 'data.code.dead-code',
	name: 'Code: dead-code reachability analysis',
	description:
		'Find code entities (functions / methods / classes / etc.) in a repo that are not reachable from any entry point. ' +
		'Roots default to all exported entities; pass `entryPoints` to override. Returns a capped list plus the uncapped total count.',
	family: 'code-binding',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			repo:           { type: 'string', description: 'Absolute repo path.' },
			entryPoints:    { type: 'array',  items: { type: 'string' }, description: 'Entity IDs to seed roots. Defaults to all exported candidate-kind entities in the repo.' },
			candidateKinds: { type: 'array',  items: { type: 'string' }, description: 'Entity kinds to consider as candidates. Default: function / method / class / interface / type / variable.' },
			relationKinds:  { type: 'array',  items: { type: 'string' }, description: 'Edge kinds traversed from roots. Default: CALLS / IMPORTS / INHERITS / IMPLEMENTS / REFERENCES.' },
			maxDepth:       { type: 'number', minimum: 0, description: 'BFS depth cap. Default: unbounded.' },
		},
		required: ['repo'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			repo:      { type: 'string' },
			rootCount: { type: 'number' },
			deadCount: { type: 'number' },
			dead: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						id:        { type: 'string' },
						name:      { type: 'string' },
						kind:      { type: 'string' },
						file:      { type: 'string' },
						startLine: { type: 'number' },
						endLine:   { type: 'number' },
						language:  { type: 'string' },
						signature: { type: 'string' },
					},
					required: ['id', 'name', 'kind', 'file', 'startLine', 'endLine', 'language'],
				},
			},
		},
		required: ['repo', 'rootCount', 'deadCount', 'dead'],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: DeadCodeInput, _deps: SkillDeps): Promise<SkillResult<DeadCodeOutput>> {
		const candidateKinds = input.candidateKinds ?? DEFAULT_CANDIDATE_KINDS;
		const relationKinds  = input.relationKinds  ?? DEFAULT_RELATION_KINDS;

		// 1. Resolve roots.
		let roots: readonly string[];
		const notes: string[] = [];
		if (input.entryPoints !== undefined && input.entryPoints.length > 0) {
			roots = input.entryPoints;
		} else {
			const all = await listEntitiesForRepo(null, input.repo);
			const candidateSet = new Set<EntityKind>(candidateKinds);
			roots = all
				.filter(e => candidateSet.has(e.kind) && e.isExported === true)
				.map(e => e.id);
			notes.push(`Auto-detected ${roots.length} exported root(s) of kind ${candidateKinds.join('/')}.`);
		}

		if (roots.length === 0) {
			// Without roots the closure is empty; "everything dead" is
			// noise, not signal. Emit an empty result + low confidence.
			return {
				value: {
					repo:      input.repo,
					rootCount: 0,
					deadCount: 0,
					dead:      [],
				},
				confidence: 'low',
				notes: ['No entry points resolved; refusing to mark every candidate as dead (likely indicates the repo isn\'t indexed yet, or no entities have isExported=true).'],
				toolCalls: [],
			};
		}

		// 2. Compute unreachable + scope to the active repo.
		const opts: Parameters<typeof unreachableEntities>[3] = {
			kindFilter: relationKinds,
			direction:  'out',
		};
		if (input.maxDepth !== undefined) opts.maxDepth = input.maxDepth;

		const allUnreachable = await unreachableEntities(
			null,
			roots,
			candidateKinds,
			opts,
		);
		const scoped = allUnreachable.filter(e => e.repo === input.repo);

		// 3. Return the FULL unreachable set (Phase B.1 -- no truncation).
		//    The renderer pages it for the LLM; the spill carries it whole.
		const dead = scoped.map(toDeadEntity);

		return {
			value: {
				repo:      input.repo,
				rootCount: roots.length,
				deadCount: scoped.length,
				dead,
			},
			confidence: 'high',
			notes,
			toolCalls: [],
		};
	},
};

function toDeadEntity(e: Entity): DeadEntity {
	const out: DeadEntity = {
		id:        e.id,
		name:      e.name,
		kind:      e.kind,
		file:      e.file,
		startLine: e.startLine,
		endLine:   e.endLine,
		language:  e.language,
	};
	return e.signature !== undefined && e.signature.length > 0
		? { ...out, signature: e.signature }
		: out;
}

export function registerDataCodeDeadCodeSkill(): void {
	registerSkill(dataCodeDeadCodeSkill as unknown as Skill);
}
