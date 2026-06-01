/**
 * code.entity.search-by-vector -- semantic vector search over the
 * code knowledge graph.
 *
 * Companion to `code.entity.locate-by-name`: locate-by-name does
 * exact-name LMDB lookup; this skill embeds a free-form query and
 * runs ANN over the LanceDB `entity_vec` table. Used by:
 *   - `code_locate` cross-agent tool (Phase 9.2 shim, alongside
 *     code_trace + code_describe)
 *   - the planner's free-form scope path when a question references
 *     a concept rather than an exact name ("the auth middleware")
 *
 * Output discriminator: returns a flat list (could be empty), no
 * `{ found, nearest }` arms -- vector search results are always
 * approximate by definition; the caller decides what counts as "no
 * match" by the score threshold or hit count.
 *
 * Out of scope:
 *   - cross-repo closure resolution (uses `session.closureRepos`
 *     directly)
 *   - re-ranking by graph centrality (caller can chain
 *     `code.entity.callers/callees` if it wants)
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import { searchEntities, type SearchFilter } from '../../../db/search.js';
import { embedQuery } from '../../../indexer/embedder.js';
import type { Entity, EntityKind, Language } from '../../../shared/types.js';
import type {
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

// ANN top-K is a SEMANTIC parameter, not an output-truncation cap:
// the search returns the K most-similar hits by similarity score and
// no "full" result exists -- there are millions of entities below
// the threshold of relevance. Default raised to 100 (Phase B.1 of
// plans/code-analyzer-interleaved-investigation.md); MAX_LIMIT raised
// proportionally. The renderer can still page the result.
const DEFAULT_LIMIT = 100;
const MAX_LIMIT     = 500;

interface SearchByVectorInput {
	readonly query:        string;
	readonly closureRepos?: readonly string[];
	readonly limit?:       number;
	readonly filter?:      SearchFilter;
}

interface VectorHit {
	readonly id:        string;
	readonly name:      string;
	readonly kind:      EntityKind;
	readonly language:  Language;
	readonly file:      string;
	readonly startLine: number;
	readonly endLine:   number;
	readonly signature?: string;
	readonly repo:      string;
}

interface SearchByVectorOutput {
	readonly query:   string;
	readonly hits:    readonly VectorHit[];
	readonly truncated: boolean;
}

const skill: Skill<SearchByVectorInput, SearchByVectorOutput> = {
	id: 'code.entity.search-by-vector',
	name: 'Code: semantic vector search across the closure',
	description:
		'Embed a free-form query and run ANN over the entity_vec table to find the K most ' +
		'semantically similar entities. Returns hits in Lance-side rank order. `limit` is the ' +
		'top-K (semantic, not a truncation cap -- ANN inherently returns top-K). Default 100, ' +
		'max 500. `closureRepos` defaults to the session\'s active closure when omitted; `filter` ' +
		'narrows to "code" / "artifact" / "all" (default).',
	family: 'source-introspection',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			query:        { type: 'string', description: 'Free-form name / description / phrase.', minLength: 1 },
			closureRepos: { type: 'array',  items: { type: 'string' }, description: 'Repo paths to search. Default: session closure.' },
			limit:        { type: 'number', minimum: 1, maximum: MAX_LIMIT, description: `Max hits. Default ${DEFAULT_LIMIT}.` },
			filter:       { type: 'string', enum: ['all', 'code', 'artifact'], description: 'Narrow to code or artifact entities. Default "all".' },
		},
		required: ['query'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			query:     { type: 'string' },
			hits:      { type: 'array' },
			truncated: { type: 'boolean' },
		},
		required: ['query', 'hits', 'truncated'],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: SearchByVectorInput, deps: SkillDeps): Promise<SkillResult<SearchByVectorOutput>> {
		const limit  = Math.max(1, Math.min(MAX_LIMIT, input.limit ?? DEFAULT_LIMIT));
		const filter = input.filter ?? 'all';

		const closure = input.closureRepos !== undefined && input.closureRepos.length > 0
			? input.closureRepos
			: deps.session.closureRepos;
		if (closure.length === 0) {
			return {
				value: { query: input.query, hits: [], truncated: false },
				confidence: 'low',
				notes: ['no closure repos available; populate session.closureRepos or pass closureRepos explicitly'],
				toolCalls: [],
			};
		}

		// Substrate: cache hit short-circuits the embed + Lance ANN.
		const cached = readCachedHits(input, closure, filter, limit, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.hits.length > 0 ? 'high' : 'medium',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const vec = await embedQuery(input.query);
		if (vec.length === 0) {
			return {
				value: { query: input.query, hits: [], truncated: false },
				confidence: 'low',
				notes: ['embedding service unavailable (ollama down? embedding model missing?)'],
				toolCalls: [],
			};
		}

		// Probe one extra to detect truncation.
		const raw = await searchEntities(null, vec, [...closure], limit + 1, filter);
		const truncated = raw.length > limit;
		const hits = raw.slice(0, limit).map(toHit);

		const value: SearchByVectorOutput = { query: input.query, hits, truncated };
		const confidence: 'high' | 'medium' = hits.length > 0 ? 'high' : 'medium';
		if (confidence === 'high') pinHits(input, closure, filter, limit, value, deps);
		return {
			value,
			confidence,
			notes: hits.length === 0
				? [`no semantic matches for '${input.query}' in [${closure.join(', ')}]`]
				: [],
			toolCalls: [],
		};
	},
};

function toHit(e: Entity): VectorHit {
	const h: VectorHit = {
		id:        e.id,
		name:      e.name,
		kind:      e.kind,
		language:  e.language,
		file:      e.file,
		startLine: e.startLine,
		endLine:   e.endLine,
		repo:      e.repo,
	};
	return e.signature !== undefined && e.signature.length > 0
		? { ...h, signature: e.signature }
		: h;
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// ANN results can shift whenever the vector index is rebuilt
// (reindex / repo-add). 1h TTL is conservative -- shorter than other
// caches because vector freshness matters more than for exact-key
// LMDB reads. Cache key folds together every input that affects the
// hit list: trimmed query text, filter, sorted closure fingerprint,
// and limit.

const OWNER_ID: OwnerId = 'skill:code.entity.search-by-vector';
const NAMESPACE = 'vector-search-hits';
const TTL_MS = 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['repo-add', 'reindex', 'manual'];

function closureFingerprint(closure: readonly string[]): string {
	return [...closure].sort().join('|');
}

function cacheKey(query: string, filter: SearchFilter, closure: readonly string[], limit: number): string {
	return `${query.trim()}::${filter}::${closureFingerprint(closure)}::${limit}`;
}

function inputCacheKey(input: SearchByVectorInput, sessionClosure: readonly string[]): string {
	const limit  = Math.max(1, Math.min(MAX_LIMIT, input.limit ?? DEFAULT_LIMIT));
	const filter = input.filter ?? 'all';
	const closure = input.closureRepos !== undefined && input.closureRepos.length > 0
		? input.closureRepos
		: sessionClosure;
	return cacheKey(input.query, filter, closure, limit);
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-hits',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as SearchByVectorInput;
			const session = (req.session ?? {}) as { closureRepos?: readonly string[] };
			const sessClosure = session.closureRepos ?? [];
			return { kind: 'byKey', key: inputCacheKey(task, sessClosure) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'SearchByVectorOutput',
		autoDistill: 'always-on-success',
		indexing:    { kind: 'never' },
		ttl:         '1h',
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

function readCachedHits(
	input: SearchByVectorInput,
	closure: readonly string[],
	filter: SearchFilter,
	limit: number,
	deps: SkillDeps,
): SearchByVectorOutput | undefined {
	const slot = deps.context?.slots.get('cached-hits');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<SearchByVectorOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input.query, filter, closure, limit)) { return undefined; }
	return hit.value;
}

function pinHits(
	input: SearchByVectorInput,
	closure: readonly string[],
	filter: SearchFilter,
	limit: number,
	value: SearchByVectorOutput,
	deps: SkillDeps,
): void {
	if (deps.workingState === undefined) { return; }
	const key = cacheKey(input.query, filter, closure, limit);
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'searchEntities' },
		payload: value,
		claims:  [`vector-search:${key}`],
		confidence: 0.9,
	});
	deps.workingState.pin(ref, {
		owner:     OWNER_ID,
		namespace: NAMESPACE,
		key,
		kind:      'fact',
		ttlMs:     TTL_MS,
	});
}

const skillWithSubstrate = { ...skill, ...substrateExtension };

export function registerCodeEntitySearchByVectorSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
