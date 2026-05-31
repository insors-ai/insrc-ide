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
import { isRepoInScope, SCOPE_SCHEMA_FRAGMENT, type SearchScope } from '../scope-helpers.js';
import type { Entity, EntityKind, Language } from '../../../shared/types.js';
import { tryReadFileForFallback } from './_fallback-file-read.js';
import type {
	AssertionInterest,
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

const BODY_HEAD_LINES = 10;
const BODY_MAX_CHARS  = 800;

interface SummaryInput {
	readonly entityId: string;
	/**
	 * Optional cap on the body excerpt's character length. Defaults to
	 * BODY_MAX_CHARS (800). The legacy `code_describe` cross-agent tool
	 * passes a larger cap (4000) so back-compat callers see the same
	 * body slice they used to. Floors the value at 1 char (defensive
	 * against zero / negative); the upper bound is the entity body
	 * length itself.
	 */
	readonly excerptMaxChars?: number;
	/**
	 * Plan SCS Phase 5: scope check on the resolved entity's repo.
	 * Defaults to 'closure' -- if the entityId resolves to an entity
	 * whose repo isn't in the active session's DEPENDS_ON closure
	 * (e.g. a stale id pasted from a prior session, or an id that
	 * leaked through a global-scope locate-by-name), the skill
	 * refuses with `{ found: false, reason: 'entity-out-of-scope' }`.
	 * Pass 'global' to bypass the check.
	 */
	readonly scope?: SearchScope;
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
		/**
		 * Where the excerpt came from. 'graph' = the entity's parsed body
		 * (the normal path). 'file-fallback' = the entity's body was empty
		 * in the graph (typical for config-file kinds like Dockerfile /
		 * YAML / shell scripts that aren't parsed by tree-sitter), so we
		 * read the file directly from disk. Callers can use this to know
		 * the excerpt represents raw file contents, not a parsed slice.
		 */
		readonly excerptSource: 'graph' | 'file-fallback';
	}
	| {
		readonly found:  false;
		readonly reason: 'entity-not-found' | 'entity-out-of-scope';
	};

const codeEntitySummarySkill: Skill<SummaryInput, SummaryOutput> = {
	id: 'code.entity.summary',
	name: 'Code: summary card for one entity',
	description:
		'Return typed metadata + a capped body excerpt for one entity. Scoped to the active ' +
		"repo's dependency closure by default (`scope: 'closure'`). Returns " +
		'`{ found: false, reason: "entity-not-found" }` when the id isn\'t in the graph, ' +
		'or `{ found: false, reason: "entity-out-of-scope" }` when it resolves to a repo ' +
		"outside the closure. Pass `scope: 'global'` to bypass the closure check.",
	family: 'source-introspection',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			entityId: { type: 'string', description: '32-char hex entity id from another lookup skill.', minLength: 32, maxLength: 32 },
			excerptMaxChars: { type: 'number', description: 'Optional cap on body excerpt chars; default 800.', minimum: 1, maximum: 65536 },
			scope:    SCOPE_SCHEMA_FRAGMENT,
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
					excerptSource:    { type: 'string', enum: ['graph', 'file-fallback'] },
				},
				required: ['found', 'entityId', 'name', 'kind', 'language', 'file', 'startLine', 'endLine', 'excerpt', 'excerptTruncated', 'excerptSource'],
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
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: SummaryInput, deps: SkillDeps): Promise<SkillResult<SummaryOutput>> {
		// Substrate: cache hit short-circuits the LMDB read + excerpt build.
		const cached = readCachedSummary(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: 'high',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		// Substrate: recent-miss short-circuits for known-not-found ids.
		const missCached = readRecentMiss(input.entityId, deps);
		if (missCached !== undefined) {
			return {
				value: { found: false, reason: 'entity-not-found' },
				confidence: 'high',
				notes: ['from miss cache (substrate)'],
				toolCalls: [],
			};
		}

		const e = await getEntity(null, input.entityId);
		if (e === null) {
			pinRecentMiss(input.entityId, deps);
			return {
				value: { found: false, reason: 'entity-not-found' },
				confidence: 'high',
				notes: [`Entity '${input.entityId}' not in the graph.`],
				toolCalls: [],
			};
		}

		// Plan SCS Phase 5: defensive scope check. Refuses entityIds
		// resolving outside the active session's DEPENDS_ON closure --
		// catches stale ids and cross-repo leaks from a prior
		// global-scope lookup.
		const scope = input.scope ?? 'closure';
		if (!isRepoInScope(deps, e.repo, scope)) {
			return {
				value: { found: false, reason: 'entity-out-of-scope' },
				confidence: 'high',
				notes: [
					`Entity '${input.entityId}' resolves to repo '${e.repo}', which is not in the ` +
					"active session's dependency closure. Re-run with `scope: 'global'` if you " +
					'really want cross-project resolution.',
				],
				toolCalls: [],
			};
		}

		const maxChars = typeof input.excerptMaxChars === 'number' && input.excerptMaxChars >= 1
			? input.excerptMaxChars
			: BODY_MAX_CHARS;

		// Normal path: entity's parsed body is non-empty, use it.
		if (e.body.length > 0) {
			const { excerpt, truncated } = buildExcerpt(e.body, maxChars);
			const out = assembleFound(e, excerpt, truncated, 'graph');
			pinSuccessfulSummary(input, out as Extract<SummaryOutput, { found: true }>, deps);
			return {
				value: out,
				confidence: 'high',
				notes: [],
				toolCalls: [],
			};
		}

		// Fallback path: body is empty in the graph -- typical for
		// `kind: 'file'` entities of formats tree-sitter doesn't parse
		// (Dockerfile, YAML, shell, TOML, ...). Read the file from disk
		// so the caller gets something to cite instead of an empty
		// excerpt that the writer would render as a content-free
		// citation. See plans/file-read-fallback-for-skills (TBD).
		const fb = await tryReadFileForFallback(e.file, maxChars);
		if (fb.ok) {
			const { excerpt, truncated } = buildExcerpt(fb.content, maxChars);
			const out = assembleFound(e, excerpt, truncated || fb.truncated, 'file-fallback');
			return {
				value: out,
				confidence: 'medium',
				notes: [`graph body empty (${e.language} file); read excerpt from disk (${fb.byteSize} bytes)`],
				toolCalls: [],
			};
		}

		// Even the file-read fallback failed (missing on disk, binary,
		// oversized, etc.). Honest empty result -- callers will see
		// excerpt='' and excerptSource='graph' and degrade as before.
		const out = assembleFound(e, '', false, 'graph');
		return {
			value: out,
			confidence: 'low',
			notes: [`graph body empty AND disk read failed: ${fb.reason}`],
			toolCalls: [],
		};
	},
};

function buildExcerpt(body: string, maxChars: number = BODY_MAX_CHARS): { excerpt: string; truncated: boolean } {
	if (body.length === 0) return { excerpt: '', truncated: false };
	const lines = body.split('\n').slice(0, BODY_HEAD_LINES);
	const head  = lines.join('\n');
	if (head.length <= maxChars && lines.length === body.split('\n').length) {
		return { excerpt: head, truncated: false };
	}
	if (head.length > maxChars) {
		return { excerpt: head.slice(0, maxChars) + '\n... <truncated>', truncated: true };
	}
	return { excerpt: head + '\n... <truncated>', truncated: true };
}

function assembleFound(
	e: Entity,
	excerpt: string,
	excerptTruncated: boolean,
	excerptSource: 'graph' | 'file-fallback',
): SummaryOutput {
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
		excerptSource,
	};
	if (e.signature !== undefined && e.signature.length > 0) out = { ...out, signature: e.signature };
	if (e.isExported === true) out = { ...out, isExported: true };
	if (e.isAbstract === true) out = { ...out, isAbstract: true };
	if (e.isAsync    === true) out = { ...out, isAsync: true };
	return out;
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (per plans/skills/code/code.entity.summary.md)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:code.entity.summary';

const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = [
	'repo-add', 'reindex', 'manual',
];

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-summary',
		fromOwner: OWNER_ID,
		namespace: 'entity-summaries',
		query: (req) => {
			const task = (req.task ?? {}) as SummaryInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
	{
		name:      'recent-misses',
		fromOwner: OWNER_ID,
		namespace: 'recent-misses',
		query: (req) => {
			const task = (req.task ?? {}) as SummaryInput;
			return { kind: 'byKey', key: task.entityId };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   'entity-summaries',
		valueType:   'SummaryOutput (found:true, confidence:high)',
		autoDistill: 'always-on-success',
		indexing:    { kind: 'never' },
		ttl:         '7d',
	},
	{
		namespace:   'recent-misses',
		valueType:   'MissRecord',
		autoDistill: 'always-on-success',
		indexing:    { kind: 'never' },
		ttl:         '24h',
	},
];

const ASSERTION_INTERESTS: readonly AssertionInterest[] = [];

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

interface MissValue {
	readonly entityId:    string;
	readonly attemptedAt: number;
}

function cacheKey(input: SummaryInput): string {
	const max   = input.excerptMaxChars ?? BODY_MAX_CHARS;
	const scope = input.scope ?? 'closure';
	return `${input.entityId}::${max}::${scope}`;
}

function readCachedSummary(
	input: SummaryInput,
	deps: SkillDeps,
): Extract<SummaryOutput, { found: true }> | undefined {
	const slot = deps.context?.slots.get('cached-summary');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<Extract<SummaryOutput, { found: true }>>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function readRecentMiss(entityId: string, deps: SkillDeps): MissValue | undefined {
	const slot = deps.context?.slots.get('recent-misses');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<MissValue>;
	if (hit.value === undefined || hit.value.entityId !== entityId) { return undefined; }
	return hit.value;
}

function pinSuccessfulSummary(
	input: SummaryInput,
	value: Extract<SummaryOutput, { found: true }>,
	deps: SkillDeps,
): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'getEntity' },
		payload: value,
		claims:  [`summary:${input.entityId}`],
		confidence: 0.95,
	});
	deps.workingState.pin(ref, {
		owner:     OWNER_ID,
		namespace: 'entity-summaries',
		key:       cacheKey(input),
		kind:      'fact',
		ttlMs:     7 * 24 * 60 * 60 * 1000,
	});
}

function pinRecentMiss(entityId: string, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const payload: MissValue = { entityId, attemptedAt: Date.now() };
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'getEntity' },
		payload,
		claims:  [`summary-miss:${entityId}`],
		confidence: 0.9,
	});
	deps.workingState.pin(ref, {
		owner:     OWNER_ID,
		namespace: 'recent-misses',
		key:       entityId,
		kind:      'fact',
		ttlMs:     24 * 60 * 60 * 1000,
	});
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const codeEntitySummarySkillWithSubstrate = {
	...codeEntitySummarySkill,
	...substrateExtension,
};

export function registerCodeEntitySummarySkill(): void {
	registerSkill(codeEntitySummarySkillWithSubstrate as unknown as Skill);
}

// Test exports.
export const _buildExcerptForTest = buildExcerpt;
export const _cacheKeyForTest     = cacheKey;
