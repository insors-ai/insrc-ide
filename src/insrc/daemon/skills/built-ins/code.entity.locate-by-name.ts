/**
 * code.entity.locate-by-name -- find entities by exact name across
 * any kind (code-analyzer-skills.md Phase 2.1).
 *
 * Generalisation of `code.class.extract-fields`'s locate step:
 * walks the LMDB name_index without the class-kind filter, so
 * functions / methods / variables / interfaces / etc. all
 * resolve.
 *
 * Output: `{ matches: [...] }` -- always a list (could be empty,
 * could be many). The richer typed-refusal contract lives on the
 * domain skills (extract-fields, locate-references, resolve-model);
 * the entity lookup is plain by design so a downstream skill can
 * decide what counts as ambiguous.
 *
 * Substrate migration (per plans/skills/code/code.entity.locate-by-name.md):
 * this is the highest-frequency skill in the code-analyzer pipeline,
 * so the substrate cache buys the biggest aggregate latency win.
 * Cache slots: `located-entities` (hits), `name-aliases` (user-asserted
 * renames), `recent-misses` (negative cache), `preferred-repo-for-name`
 * (assertion-driven re-rank). All slots are wired live; the substrate
 * has all phases (P0-P5) done.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import { findEntitiesByName } from '../../../db/entities.js';
import { resolveSearchScope, SCOPE_SCHEMA_FRAGMENT, type SearchScope } from '../scope-helpers.js';
import type { Entity, EntityKind, Language } from '../../../shared/types.js';
import type {
	AssertionInterest,
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

// Phase B.1: removed DEFAULT_LIMIT / MAX_LIMIT / `limit` parameter.
// Skill returns ALL matches; the renderer pages for the LLM.

const ALL_KINDS: readonly EntityKind[] = [
	'function', 'method', 'class', 'interface', 'type', 'variable',
	'module', 'document', 'section', 'config', 'file', 'repo',
];

interface LocateInput {
	readonly name:     string;
	readonly kinds?:   readonly EntityKind[];
	readonly repoPath?: string;
	/**
	 * Plan SCS Phase 2: search scope. Defaults to `'closure'` so a
	 * call like `locate-by-name({ name: 'X' })` automatically scopes
	 * to the active session repo + its transitive DEPENDS_ON
	 * closure, instead of leaking into every indexed workspace repo
	 * (the pre-Plan-SCS behaviour). `'global'` is opt-in for the
	 * rare case where cross-project name resolution is wanted.
	 *
	 * Ignored when `repoPath` is set -- a single-repo override is
	 * more specific and wins.
	 */
	readonly scope?:   SearchScope;
	readonly language?: Language;
}

interface MatchEntity {
	readonly id:         string;
	readonly name:       string;
	readonly kind:       EntityKind;
	readonly language:   Language;
	readonly file:       string;
	/**
	 * Repo root absolute path of the entity. Added in Plan SCS
	 * Phase 2 so callers using `scope: 'global'` can disambiguate
	 * matches across projects. For default-`closure` callers, every
	 * `repo` is by construction inside the session's closure.
	 */
	readonly repo:       string;
	readonly startLine:  number;
	readonly endLine:    number;
	readonly signature?: string;
	readonly isExported?: boolean;
}

interface LocateOutput {
	readonly name:    string;
	readonly matches: readonly MatchEntity[];
}

const codeEntityLocateByNameSkill: Skill<LocateInput, LocateOutput> = {
	id: 'code.entity.locate-by-name',
	name: 'Code: locate entities by exact name',
	description:
		'Find every entity matching an exact name across the requested kinds. Scoped to the ' +
		"active repo's dependency closure by default (`scope: 'closure'`); pass `scope: 'global'` " +
		'to search every indexed repo. A single-repo override is also available via `repoPath`. ' +
		'Returns the COMPLETE set of matches.',
	family: 'source-introspection',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			name:     { type: 'string', description: 'Exact name to match.' },
			kinds: {
				type: 'array',
				items: { type: 'string' },
				description: 'Subset of EntityKinds to consider. Default: all kinds.',
				uniqueItems: true,
				minItems: 1,
			},
			repoPath: { type: 'string', description: 'Optional repo root absolute path. When set, overrides `scope`.' },
			scope:    SCOPE_SCHEMA_FRAGMENT,
			language: {
				type: 'string',
				enum: ['typescript', 'javascript', 'python', 'go', 'java', 'scala'],
				description: 'Optional language filter.',
			},
		},
		required: ['name'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			name:    { type: 'string' },
			matches: { type: 'array' },
		},
		required: ['name', 'matches'],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: LocateInput, deps: SkillDeps): Promise<SkillResult<LocateOutput>> {
		const notes: string[] = [];

		// Substrate: apply user-asserted aliases (e.g., user said `User`,
		// the workspace canonicalised to `UserModel`). Falls through to
		// the literal name when no alias matches or context is absent.
		const resolvedName = resolveAlias(input.name, input.repoPath, deps);
		if (resolvedName !== input.name) {
			notes.push(`alias: '${input.name}' -> '${resolvedName}'`);
		}

		// Substrate: cache hit short-circuit. Cache key includes kinds +
		// scope + language so different requests for the same name don't
		// collide.
		const requestForCache: LocateInput = { ...input, name: resolvedName };
		const cached = readCachedLocate(requestForCache, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.matches.length > 0 ? 'high' : 'medium',
				notes: [...notes, 'from cache (substrate)'],
				toolCalls: [],
			};
		}

		// Substrate: recent-miss short-circuit. Only honoured when the
		// caller didn't narrow by kinds -- a kinds filter changes the
		// semantic of "miss" enough that a generic miss-cache shouldn't
		// answer for it.
		const kindsNarrowed = input.kinds !== undefined && input.kinds.length > 0;
		if (!kindsNarrowed) {
			const missed = readRecentMiss(resolvedName, deps);
			if (missed !== undefined) {
				return {
					value: { name: input.name, matches: [] },
					confidence: 'medium',
					notes: [...notes, 'from miss cache (substrate)'],
					toolCalls: [],
				};
			}
		}

		// Closure resolution: prefer provider:active-session when wired,
		// else fall back to deps.session via resolveSearchScope.
		const kinds = kindsNarrowed ? input.kinds! : ALL_KINDS;
		const baseOpts = { kinds, limit: Number.MAX_SAFE_INTEGER };

		let opts: Parameters<typeof findEntitiesByName>[2];
		if (input.repoPath !== undefined) {
			opts = { ...baseOpts, repo: input.repoPath };
		} else {
			const scope = input.scope ?? 'closure';
			const repos = activeClosureFromProvider(deps) ?? resolveSearchScope(deps, scope);
			if (repos === null) {
				opts = baseOpts;
				notes.push("scope='global': searched every indexed repo");
			} else {
				opts = { ...baseOpts, repos };
			}
		}

		const raw = await findEntitiesByName(null, [resolvedName], opts);
		const filtered = input.language !== undefined
			? raw.filter(e => e.language === input.language)
			: raw;

		let matches: readonly MatchEntity[] = filtered.map(toMatch);

		// Substrate: assertion-driven re-rank. Float matches whose `repo`
		// is the preferred one to the front of the list. The relative
		// order among non-preferred matches is preserved.
		const preferredRepo = readPreferredRepoForName(resolvedName, deps);
		if (preferredRepo !== undefined && matches.length > 1) {
			const before = matches;
			matches = rerankPreferredRepoFirst(matches, preferredRepo);
			if (matches !== before) {
				notes.push(`re-ranked: preferred-repo='${preferredRepo}'`);
			}
		}

		const value: LocateOutput = { name: input.name, matches };

		if (matches.length === 0) {
			notes.push(`No entity named '${resolvedName}' found in the index.`);
			pinRecentMiss(resolvedName, input.scope ?? 'closure', deps);
		} else {
			pinSuccessfulLocate(requestForCache, value, deps);
		}

		return {
			value,
			confidence: matches.length > 0 ? 'high' : 'medium',
			notes,
			toolCalls: [],
		};
	},
};

function toMatch(e: Entity): MatchEntity {
	let m: MatchEntity = {
		id:        e.id,
		name:      e.name,
		kind:      e.kind,
		language:  e.language,
		file:      e.file,
		repo:      e.repo,
		startLine: e.startLine,
		endLine:   e.endLine,
	};
	if (e.signature !== undefined && e.signature.length > 0) m = { ...m, signature: e.signature };
	if (e.isExported === true) m = { ...m, isExported: true };
	return m;
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (per plans/skills/code/code.entity.locate-by-name.md)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:code.entity.locate-by-name';

const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = [
	'repo-add', 'reindex', 'connection-add', 'manual',
];

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	// 1. Cache hit path. Key is the canonical request fingerprint --
	//    (name, kinds, scope|repo, language).
	{
		name:      'cached-locate',
		fromOwner: OWNER_ID,
		namespace: 'located-entities',
		query: (req) => {
			const task = (req.task ?? {}) as LocateInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},

	// 2. User-asserted aliases. Prefix scan -- entries are keyed by
	//    (repoPath::userTerm) so we can scope per workspace. When the
	//    input has no repoPath, fall back to the active session's
	//    repoPath; only if neither is set do we scan everything (the
	//    resolver will filter again by repo per entry).
	{
		name:      'name-aliases',
		fromOwner: OWNER_ID,
		namespace: 'name-aliases',
		query: (req) => {
			const task    = (req.task    ?? {}) as LocateInput;
			const session = (req.session ?? {}) as { repoPath?: string };
			const repo    = task.repoPath ?? session.repoPath;
			return repo === undefined
				? { kind: 'prefix', prefix: '' }
				: { kind: 'prefix', prefix: `${repo}::` };
		},
	},

	// 3. Recent-miss negative cache.
	{
		name:      'recent-misses',
		fromOwner: OWNER_ID,
		namespace: 'recent-misses',
		query: (req) => {
			const task = (req.task ?? {}) as LocateInput;
			return { kind: 'byKey', key: task.name };
		},
		limit: 1,
	},

	// 4. Active closure via provider:active-session (substrate P4).
	//    When available, we prefer it over the deps.session walk.
	{
		name:      'active-closure',
		fromOwner: 'provider:active-session',
		namespace: '_',
		query:     { kind: 'byKey', key: 'closureRepos' },
		limit:     1,
	},

	// 5. Preferred repo for an ambiguous name (assertion-driven).
	{
		name:      'preferred-repo-for-name',
		fromOwner: OWNER_ID,
		namespace: 'preferred-repo-for-name',
		query: (req) => {
			const task = (req.task ?? {}) as LocateInput;
			return { kind: 'byKey', key: task.name };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   'located-entities',
		valueType:   'LocateOutput',
		autoDistill: 'always-on-success',
		indexing:    { kind: 'never' },
		ttl:         '7d',
	},
	{
		namespace:   'name-aliases',
		valueType:   'NameAlias',
		autoDistill: 'on-pin',
		indexing:    { kind: 'never' },
		ttl:         'until-contradicted',
	},
	{
		namespace:   'recent-misses',
		valueType:   'MissRecord',
		autoDistill: 'always-on-success',
		indexing:    { kind: 'never' },
		ttl:         '24h',
	},
	{
		namespace:   'preferred-repo-for-name',
		valueType:   'PreferredRepo',
		autoDistill: 'on-pin',
		indexing:    { kind: 'never' },
		ttl:         'until-contradicted',
	},
	{
		// Declared so the skill's owner identity covers L2-distilled
		// observations later (e.g. "NameNode is always a class").
		// No writes from this L1 today.
		namespace:   'observations',
		valueType:   'WorkspacePatternObservation',
		autoDistill: 'never',
		indexing:    { kind: 'never' },
		ttl:         '30d',
	},
];

const ASSERTION_INTERESTS: readonly AssertionInterest[] = [
	{
		subjectPattern: 'name-alias',
		description: 'workspace-level alias from a user-stated entity name to its canonical form',
	},
	{
		subjectPattern: 'preferred-repo-for-name',
		description: 'when multiple repos contain the same entity name, prefer this one',
	},
];

const substrateExtension: SubstrateSkillExtension = {
	ownerId:            OWNER_ID,
	schemaVersion:      1,
	interestedTriggers: INTERESTED_TRIGGERS,
	contextSlots:       CONTEXT_SLOTS,
	memorySchema:       MEMORY_SCHEMA,
	assertionInterests: ASSERTION_INTERESTS,
};

// ---------------------------------------------------------------------------
// Substrate helpers
// ---------------------------------------------------------------------------

interface AliasValue {
	readonly userTerm:  string;
	readonly canonical: string;
	readonly repoPath?: string | null;
}

interface PreferredRepoValue {
	readonly name:           string;
	readonly preferredRepo:  string;
	readonly reason?:        string;
}

interface MissValue {
	readonly name:         string;
	readonly attemptedAt:  number;
	readonly scope:        string;
}

/**
 * Canonical request fingerprint -- the cache key. Closure-repos isn't
 * included; the cache is per-workspace by substrate construction, and
 * stale entries fall off via the 7d TTL.
 */
function cacheKey(input: LocateInput): string {
	const kinds = input.kinds === undefined || input.kinds.length === 0
		? '*'
		: [...input.kinds].sort().join(',');
	const scope = input.repoPath !== undefined
		? `repo:${input.repoPath}`
		: `scope:${input.scope ?? 'closure'}`;
	const lang  = input.language ?? '*';
	return `${input.name}::${kinds}::${scope}::${lang}`;
}

function readCachedLocate(input: LocateInput, deps: SkillDeps): LocateOutput | undefined {
	const slot = deps.context?.slots.get('cached-locate');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<LocateOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function resolveAlias(name: string, repoPath: string | undefined, deps: SkillDeps): string {
	const slot = deps.context?.slots.get('name-aliases');
	if (slot === undefined || slot.length === 0) { return name; }
	for (const entry of slot) {
		const v = (entry as MemoryEntry<AliasValue>).value;
		if (v === undefined) continue;
		if (v.userTerm !== name) continue;
		// Repo scoping: '*' / null / matching repoPath wins.
		if (v.repoPath != null && repoPath !== undefined && v.repoPath !== repoPath) { continue; }
		return v.canonical;
	}
	return name;
}

function readRecentMiss(name: string, deps: SkillDeps): MissValue | undefined {
	const slot = deps.context?.slots.get('recent-misses');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<MissValue>;
	if (hit.value === undefined || hit.value.name !== name) { return undefined; }
	return hit.value;
}

function readPreferredRepoForName(name: string, deps: SkillDeps): string | undefined {
	const slot = deps.context?.slots.get('preferred-repo-for-name');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<PreferredRepoValue>;
	if (hit.value === undefined || hit.value.name !== name) { return undefined; }
	return hit.value.preferredRepo;
}

function activeClosureFromProvider(deps: SkillDeps): string[] | undefined {
	const slot = deps.context?.slots.get('active-closure');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const v = (slot[0] as MemoryEntry<unknown>).value;
	if (!Array.isArray(v)) { return undefined; }
	const out: string[] = [];
	for (const e of v) { if (typeof e === 'string') { out.push(e); } }
	return out.length > 0 ? out : undefined;
}

function rerankPreferredRepoFirst(matches: readonly MatchEntity[], repo: string): readonly MatchEntity[] {
	const preferred: MatchEntity[] = [];
	const rest:      MatchEntity[] = [];
	for (const m of matches) {
		if (m.repo === repo) { preferred.push(m); } else { rest.push(m); }
	}
	if (preferred.length === 0) { return matches; }
	return [...preferred, ...rest];
}

function pinSuccessfulLocate(input: LocateInput, value: LocateOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'findEntitiesByName' },
		payload: value,
		claims:  [`locate:${input.name}`],
		confidence: 0.95,
	});
	deps.workingState.pin(ref, {
		owner:     OWNER_ID,
		namespace: 'located-entities',
		key:       cacheKey(input),
		kind:      'fact',
		ttlMs:     7 * 24 * 60 * 60 * 1000,
	});
}

function pinRecentMiss(name: string, scope: string, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const payload: MissValue = { name, attemptedAt: Date.now(), scope };
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'findEntitiesByName' },
		payload,
		claims:  [`miss:${name}`],
		confidence: 0.9,
	});
	deps.workingState.pin(ref, {
		owner:     OWNER_ID,
		namespace: 'recent-misses',
		key:       name,
		kind:      'fact',
		ttlMs:     24 * 60 * 60 * 1000,
	});
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const codeEntityLocateByNameSkillWithSubstrate = {
	...codeEntityLocateByNameSkill,
	...substrateExtension,
};

export function registerCodeEntityLocateByNameSkill(): void {
	registerSkill(codeEntityLocateByNameSkillWithSubstrate as unknown as Skill);
}

// Test exports.
export const _codeEntityLocateByNameSkillForTest = codeEntityLocateByNameSkill;
export const _cacheKeyForTest                    = cacheKey;
