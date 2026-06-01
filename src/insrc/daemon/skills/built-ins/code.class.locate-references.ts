/**
 * code.class.locate-references -- locate a class by name, then walk
 * its in-edges to surface who references it (code-analyzer-skills.md
 * Phase 3.2). The second cross-owner code-binding skill -- the
 * prerequisite the data-analyzer §3.2 wrapper rides.
 *
 * Composition:
 *
 *   1. `code_class_locate({ className, repoPath? })`
 *        - exact-match across class / interface / type kinds
 *        - on miss, returns `{ found: false, nearest }` with the
 *          three closest names by Levenshtein + prefix overlap
 *
 *   2. If found, `code_class_references({ entityId, kinds? })`
 *        - in-edge walk filtered to CALLS / INHERITS / IMPLEMENTS
 *          / REFERENCES; caps at 200 with `truncated` flag
 *        - returns per-reference `{ kind, fromEntityId, fromPath,
 *          fromLine, snippet? }` plus per-kind counts
 *
 * Output discriminator pattern -- `{ found: true, ... }` vs
 * `{ found: false, nearest }` -- mirrors §3.1 (extract-fields).
 * Cross-owner callers see the typed `false` arm and refuse cleanly
 * (offers the user the top-3 candidates) instead of returning a
 * fabricated reference list.
 *
 * Skill id: `code.class.locate-references`. Family: `code-binding`.
 * Owner: `code-analyzer`. Provider affinity: `auto` -- pure tool
 * round-trips, no LLM call.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import { resolveSearchScope, SCOPE_SCHEMA_FRAGMENT, type SearchScope } from '../scope-helpers.js';
import type {
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

type RefKind = 'CALLS' | 'INHERITS' | 'IMPLEMENTS' | 'REFERENCES';

interface LocateReferencesInput {
	readonly className: string;
	readonly repoPath?: string;
	/**
	 * Plan SCS Phase 3 scope override. Defaults to 'closure' -- the
	 * lookup respects the active session's DEPENDS_ON closure.
	 * Ignored when `repoPath` is set (explicit single-repo wins).
	 */
	readonly scope?:    SearchScope;
	readonly language?: 'typescript' | 'javascript' | 'python' | 'go' | 'java' | 'scala';
	readonly kinds?:    readonly RefKind[];
}

interface NearestCandidate {
	readonly className: string;
	readonly score:     number;
	readonly entityId:  string;
}

interface ReferenceEntry {
	readonly kind:         RefKind;
	readonly fromEntityId: string;
	readonly fromPath:     string;
	readonly fromLine:     number;
	readonly snippet?:     string;
}

type LocateReferencesOutput =
	| {
		readonly found:      true;
		readonly entityId:   string;
		readonly className:  string;
		readonly path:       string;
		readonly line:       number;
		readonly language:   string;
		readonly kind:       string;
		readonly references: readonly ReferenceEntry[];
		readonly truncated:  boolean;
		readonly counts:     Readonly<Record<RefKind, number>>;
	}
	| {
		readonly found:   false;
		readonly nearest: readonly NearestCandidate[];
	};

const codeClassLocateReferencesSkill: Skill<LocateReferencesInput, LocateReferencesOutput> = {
	id: 'code.class.locate-references',
	name: 'Code: locate a class and list its references',
	description:
		'Resolve a class name to a graph entity, then walk its in-edges to surface who ' +
		'references it (CALLS / INHERITS / IMPLEMENTS / REFERENCES). Returns `{ found: true, ' +
		'references: [...] }` on hit, or `{ found: false, nearest: [...] }` on miss -- the ' +
		'typed-refusal contract that lets cross-owner callers refuse cleanly.',
	family: 'code-binding',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			className: { type: 'string', description: 'Unqualified class name as referenced in source.' },
			repoPath:  { type: 'string', description: 'Optional repo root absolute path. Overrides `scope`.' },
			scope:     SCOPE_SCHEMA_FRAGMENT,
			language: {
				type: 'string',
				enum: ['typescript', 'javascript', 'python', 'go', 'java', 'scala'],
				description: 'Optional language filter.',
			},
			kinds: {
				type: 'array',
				items: { type: 'string', enum: ['CALLS', 'INHERITS', 'IMPLEMENTS', 'REFERENCES'] },
				uniqueItems: true,
				minItems: 1,
				description: 'Subset of relation kinds to walk. Default: all four.',
			},
		},
		required: ['className'],
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
					className: { type: 'string' },
					path:      { type: 'string' },
					line:      { type: 'number' },
					language:  { type: 'string' },
					kind:      { type: 'string' },
					references: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								kind:         { type: 'string', enum: ['CALLS', 'INHERITS', 'IMPLEMENTS', 'REFERENCES'] },
								fromEntityId: { type: 'string' },
								fromPath:     { type: 'string' },
								fromLine:     { type: 'number' },
								snippet:      { type: 'string' },
							},
							required: ['kind', 'fromEntityId', 'fromPath', 'fromLine'],
						},
					},
					truncated: { type: 'boolean' },
					counts: {
						type: 'object',
						properties: {
							CALLS:      { type: 'number' },
							INHERITS:   { type: 'number' },
							IMPLEMENTS: { type: 'number' },
							REFERENCES: { type: 'number' },
						},
						required: ['CALLS', 'INHERITS', 'IMPLEMENTS', 'REFERENCES'],
					},
				},
				required: ['found', 'entityId', 'className', 'path', 'line', 'language', 'kind', 'references', 'truncated', 'counts'],
			},
			{
				type: 'object',
				properties: {
					found: { type: 'boolean', enum: [false] },
					nearest: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								className: { type: 'string' },
								score:     { type: 'number' },
								entityId:  { type: 'string' },
							},
							required: ['className', 'score', 'entityId'],
						},
					},
				},
				required: ['found', 'nearest'],
			},
		],
	},
	toolDeps: ['code_class_locate', 'code_class_references'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['code_class_locate', 'code_class_references'],
			reason: 'class lookup + in-edge walk both ride typed graph tools; without them the skill cannot produce structured output',
		},
	],

	async execute(input: LocateReferencesInput, deps: SkillDeps): Promise<SkillResult<LocateReferencesOutput>> {
		// Substrate: cache hit short-circuits both tool round-trips.
		const cached = readCachedReferences(input, deps);
		if (cached !== undefined) {
			const conf = cached.found && cached.references.length > 0 ? 'high' : 'medium';
			return {
				value: cached,
				confidence: conf,
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		// Step 1: locate.
		// Plan SCS Phase 3: route scope into the tool's repos[] filter
		// when no single-repo override is given. An explicit `repoPath`
		// wins (most specific); 'global' opts out of the closure filter.
		const locateInput: Record<string, unknown> = { className: input.className };
		if (input.repoPath !== undefined) {
			locateInput['repoPath'] = input.repoPath;
		} else {
			const repos = resolveSearchScope(deps, input.scope ?? 'closure');
			if (repos !== null) locateInput['repos'] = [...repos];
		}
		if (input.language !== undefined) locateInput['language'] = input.language;

		const locateResult = await deps.runTool({
			id: makeCallId('locate'),
			name: 'code_class_locate',
			input: locateInput,
		});

		if (locateResult.isError) {
			return {
				value: { found: false, nearest: [] },
				confidence: 'low',
				notes: [`code_class_locate returned error: ${locateResult.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}

		if (!isLocateData(locateResult.data)) {
			return {
				value: { found: false, nearest: [] },
				confidence: 'low',
				notes: ['code_class_locate returned a payload without the expected `found` discriminator'],
				toolCalls: [],
			};
		}

		const locateData = locateResult.data;

		if (locateData.found === false) {
			return {
				value: { found: false, nearest: locateData.nearest },
				confidence: 'high',
				notes: locateData.nearest.length > 0
					? [`class '${input.className}' not found; nearest candidates: ${locateData.nearest.map(n => n.className).join(', ')}`]
					: [`class '${input.className}' not found; no nearby candidates in the index`],
				toolCalls: [],
			};
		}

		// Step 2: reference walk.
		const refsInput: Record<string, unknown> = { entityId: locateData.entityId };
		if (input.kinds !== undefined && input.kinds.length > 0) refsInput['kinds'] = [...input.kinds];

		const refsResult = await deps.runTool({
			id: makeCallId('refs'),
			name: 'code_class_references',
			input: refsInput,
		});

		if (refsResult.isError) {
			return {
				value: { found: false, nearest: [] },
				confidence: 'low',
				notes: [
					`code_class_references returned error: ${refsResult.content.slice(0, 200)}`,
					`(class '${input.className}' was located at ${locateData.path}:${locateData.line} but the in-edge walk failed)`,
				],
				toolCalls: [],
			};
		}

		if (!isRefsData(refsResult.data)) {
			return {
				value: { found: false, nearest: [] },
				confidence: 'low',
				notes: ['code_class_references returned a payload without the expected shape'],
				toolCalls: [],
			};
		}

		const refsData = refsResult.data;

		const value: LocateReferencesOutput = {
			found:      true,
			entityId:   locateData.entityId,
			className:  refsData.className,
			path:       locateData.path,
			line:       locateData.line,
			language:   locateData.language,
			kind:       locateData.kind,
			references: refsData.references,
			truncated:  refsData.truncated,
			counts:     refsData.counts,
		};

		// Confidence shaping:
		//   high   : non-empty references (the lookup found real refs).
		//   medium : zero references (class exists but is unused -- a
		//            valid answer, but lower signal than "here are the
		//            callers"; callers may want to widen scope).
		const confidence = refsData.references.length > 0 ? 'high' : 'medium';

		if (confidence === 'high') pinReferences(input, value, deps);

		const result: SkillResult<LocateReferencesOutput> = {
			value,
			confidence,
			notes: [],
			toolCalls: [],
		};
		return refsData.truncated ? { ...result, truncated: true } : result;
	},
};

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

interface LocateFoundData {
	readonly found:    true;
	readonly entityId: string;
	readonly path:     string;
	readonly line:     number;
	readonly language: string;
	readonly kind:     string;
}

interface LocateMissData {
	readonly found:   false;
	readonly nearest: readonly NearestCandidate[];
}

type LocateData = LocateFoundData | LocateMissData;

function isLocateData(v: unknown): v is LocateData {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	if (o['found'] === true) {
		return typeof o['entityId'] === 'string'
			&& typeof o['path']     === 'string'
			&& typeof o['line']     === 'number'
			&& typeof o['language'] === 'string'
			&& typeof o['kind']     === 'string';
	}
	if (o['found'] === false) {
		return Array.isArray(o['nearest']);
	}
	return false;
}

interface RefsData {
	readonly entityId:   string;
	readonly className:  string;
	readonly references: readonly ReferenceEntry[];
	readonly truncated:  boolean;
	readonly counts:     Readonly<Record<RefKind, number>>;
}

function isRefsData(v: unknown): v is RefsData {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	if (typeof o['entityId']  !== 'string') return false;
	if (typeof o['className'] !== 'string') return false;
	if (!Array.isArray(o['references']))    return false;
	if (typeof o['truncated'] !== 'boolean') return false;
	if (typeof o['counts']    !== 'object' || o['counts'] === null) return false;
	return true;
}

let CALL_SEQ = 0;
function makeCallId(stage: string): string {
	CALL_SEQ = (CALL_SEQ + 1) & 0xffff;
	return `code-class-locate-references:${stage}:${Date.now()}:${CALL_SEQ}`;
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// Reference walks drift with edits: a single commit touching the source
// class or any caller invalidates the result. 24h TTL is a defensive
// upper bound; reindex triggers force a refresh sooner.

const OWNER_ID: OwnerId = 'skill:code.class.locate-references';
const NAMESPACE = 'class-references';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['repo-add', 'reindex', 'manual'];

function cacheKey(input: LocateReferencesInput): string {
	return `${input.className}::${input.repoPath ?? '*'}::${input.scope ?? 'closure'}::${input.language ?? '*'}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-references',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as LocateReferencesInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'LocateReferencesOutput',
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

function readCachedReferences(input: LocateReferencesInput, deps: SkillDeps): LocateReferencesOutput | undefined {
	const slot = deps.context?.slots.get('cached-references');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<LocateReferencesOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinReferences(input: LocateReferencesInput, value: LocateReferencesOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'code_class_references' },
		payload: value,
		claims:  [`class-references:${cacheKey(input)}`],
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

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const codeClassLocateReferencesSkillWithSubstrate = {
	...codeClassLocateReferencesSkill,
	...substrateExtension,
};

export function registerCodeClassLocateReferencesSkill(): void {
	registerSkill(codeClassLocateReferencesSkillWithSubstrate as unknown as Skill);
}

// Test exports.
export const _codeClassLocateReferencesSkillForTest = codeClassLocateReferencesSkill;
export const _isLocateDataForTest                   = isLocateData;
export const _isRefsDataForTest                     = isRefsData;
