/**
 * code.class.extract-fields -- locate a class by name, then return
 * its typed field metadata. The first cross-owner code-binding skill
 * (code-analyzer-skills.md Phase 3.1) -- it's the prerequisite the
 * data-analyzer §3.1 wrapper depends on.
 *
 * Composition:
 *
 *   1. `code_class_locate({ className, repoPath? })`
 *        - exact-match across class / interface / type kinds
 *        - on miss, returns `{ found: false, nearest }` with the
 *          three closest names by Levenshtein + prefix overlap
 *
 *   2. If found, `code_class_fields({ entityId })`
 *        - per-language extractor (graph walk for Java / Scala,
 *          body regex for TS / JS / Python / Go) emitting
 *          `{ name, type?, nullable?, default?, modifiers?,
 *          declaredAt }` per field
 *
 * Output discriminator pattern -- `{ found: true, ... }` vs
 * `{ found: false, nearest }` -- is the structural fix for the
 * 2026-04-30 hallucinated-class regression. The data-analyzer-side
 * wrapper sees the typed `false` arm and refuses cleanly (offers
 * the user the top-3 candidates) instead of fabricating a 28-row
 * field table off a class that doesn't exist.
 *
 * Skill id: `code.class.extract-fields`. Family: `code-binding`.
 * Owner: `code-analyzer`. Provider affinity: `auto` -- the body
 * has no LLM call (two typed tool round-trips), so affinity tagging
 * is informational only.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import { resolveSearchScope, SCOPE_SCHEMA_FRAGMENT, type SearchScope } from '../scope-helpers.js';
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

interface ExtractFieldsInput {
	readonly className: string;
	readonly repoPath?: string;
	/**
	 * Plan SCS Phase 3 scope override. Defaults to 'closure' -- the
	 * lookup respects the active session's DEPENDS_ON closure.
	 * Ignored when `repoPath` is set (explicit single-repo wins).
	 */
	readonly scope?:    SearchScope;
	readonly language?: 'typescript' | 'javascript' | 'python' | 'go' | 'java' | 'scala';
}

interface NearestCandidate {
	readonly className: string;
	readonly score:     number;
	readonly entityId:  string;
}

interface FieldInfo {
	readonly name:       string;
	readonly type?:      string;
	readonly nullable?:  boolean;
	readonly default?:   string;
	readonly modifiers?: readonly string[];
	readonly declaredAt: { readonly path: string; readonly line: number };
}

type ExtractFieldsOutput =
	| {
		readonly found:    true;
		readonly entityId: string;
		readonly className: string;
		readonly language:  string;
		readonly path:      string;
		readonly line:      number;
		readonly kind:      string;
		readonly isAbstract?: boolean;
		readonly source:    'graph' | 'body' | 'mixed' | 'none';
		readonly fields:    readonly FieldInfo[];
		/**
		 * Head of the class's defining file, populated when `fields` is
		 * empty (the regex/graph extractor couldn't classify anything --
		 * common for unparsed-language classes like Pydantic-via-decorators
		 * or annotation-heavy frameworks). Lets the caller cite raw source
		 * instead of an empty field list. Absent when `fields.length > 0`
		 * (structural data wins).
		 */
		readonly bodyExcerpt?:          string;
		readonly bodyExcerptTruncated?: boolean;
		readonly bodyExcerptSource?:    'file-fallback';
	}
	| {
		readonly found:   false;
		readonly nearest: readonly NearestCandidate[];
	};

const codeClassExtractFieldsSkill: Skill<ExtractFieldsInput, ExtractFieldsOutput> = {
	id: 'code.class.extract-fields',
	name: 'Code: locate a class and extract its fields',
	description:
		'Resolve a class name to a graph entity, then return its typed field metadata. Returns ' +
		'`{ found: true, entityId, fields: [...] }` on hit, or `{ found: false, nearest: [{ className, ' +
		'score }] }` on miss -- the typed-refusal contract that lets cross-owner callers refuse ' +
		'cleanly instead of fabricating answers (the 2026-04-30 hallucinated-class fix).',
	family: 'code-binding',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			className: { type: 'string', description: 'Unqualified class name as referenced in source.' },
			repoPath:  { type: 'string', description: 'Optional repo root absolute path. Narrows the lookup to one workspace; overrides `scope`.' },
			scope:     SCOPE_SCHEMA_FRAGMENT,
			language: {
				type: 'string',
				enum: ['typescript', 'javascript', 'python', 'go', 'java', 'scala'],
				description: 'Optional language filter. Use when the same class name lives in multiple languages.',
			},
		},
		required: ['className'],
		additionalProperties: false,
	},
	outputs: {
		// Discriminated by `found`. Top-level `type: 'object'` satisfies
		// the registry's schema check; the oneOf split is the typed-
		// refusal contract: a `found: true` payload carries entityId +
		// fields; a `found: false` payload carries nearest. Validators
		// reject any payload that mixes the two arms.
		type: 'object',
		properties: {
			found: { type: 'boolean' },
		},
		required: ['found'],
		oneOf: [
			{
				type: 'object',
				properties: {
					found:      { type: 'boolean', enum: [true] },
					entityId:   { type: 'string' },
					className:  { type: 'string' },
					language:   { type: 'string' },
					path:       { type: 'string' },
					line:       { type: 'number' },
					kind:       { type: 'string' },
					isAbstract: { type: 'boolean' },
					source:     { type: 'string', enum: ['graph', 'body', 'mixed', 'none'] },
					bodyExcerpt:          { type: 'string' },
					bodyExcerptTruncated: { type: 'boolean' },
					bodyExcerptSource:    { type: 'string', enum: ['file-fallback'] },
					fields: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								name:       { type: 'string' },
								type:       { type: 'string' },
								nullable:   { type: 'boolean' },
								default:    { type: 'string' },
								modifiers:  { type: 'array', items: { type: 'string' } },
								declaredAt: {
									type: 'object',
									properties: {
										path: { type: 'string' },
										line: { type: 'number' },
									},
									required: ['path', 'line'],
								},
							},
							required: ['name', 'declaredAt'],
						},
					},
				},
				required: ['found', 'entityId', 'className', 'language', 'path', 'line', 'kind', 'source', 'fields'],
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
	toolDeps: ['code_class_locate', 'code_class_fields'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['code_class_locate', 'code_class_fields'],
			reason: 'class lookup + field extraction both ride typed graph tools; without them the skill cannot produce structured output',
		},
	],

	async execute(input: ExtractFieldsInput, deps: SkillDeps): Promise<SkillResult<ExtractFieldsOutput>> {
		// Substrate P1: apply learned aliases (e.g., user said `User`, the
		// workspace canonicalised that to `UserModel`). Falls through to
		// the literal className when no alias matches or context is absent.
		const resolvedClassName = resolveAlias(input.className, input.repoPath, deps);
		if (resolvedClassName !== input.className) {
			// Don't mutate input -- thread the resolved name through locally.
		}

		// Substrate P1: cache hit short-circuit. Cached extractions live in
		// the `extracted-classes` namespace keyed by `<repoPath>::<className>`.
		const cached = readCachedExtraction(resolvedClassName, input.repoPath, deps);
		if (cached !== undefined && cached.value.found === true) {
			return {
				value: cached.value,
				confidence: 'high',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		// Step 1: locate.
		// Plan SCS Phase 3: route scope into the tool's repos[] filter
		// when no single-repo override is given. An explicit `repoPath`
		// wins (most specific); 'global' opts out of the closure filter.
		const locateInput: Record<string, unknown> = { className: resolvedClassName };
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

		const locateData = locateResult.data;
		if (!isLocateData(locateData)) {
			return {
				value: { found: false, nearest: [] },
				confidence: 'low',
				notes: ['code_class_locate returned a payload without the expected `found` discriminator'],
				toolCalls: [],
			};
		}

		// Typed-refusal arm: missing class -> surface nearest candidates.
		if (locateData.found === false) {
			// Substrate P1: persist the miss for nearest-candidate warmth on
			// re-attempts of the same name within the TTL window.
			pinRecentMiss(resolvedClassName, locateData.nearest, deps);
			return {
				value: { found: false, nearest: locateData.nearest },
				// High confidence in the *refusal* itself: the lookup
				// resolved cleanly, the class just isn't there. Callers
				// that want a "did-you-mean" UX have the top-3 candidates.
				confidence: 'high',
				notes: locateData.nearest.length > 0
					? [`class '${resolvedClassName}' not found; nearest candidates: ${locateData.nearest.map(n => n.className).join(', ')}`]
					: [`class '${resolvedClassName}' not found; no nearby candidates in the index`],
				toolCalls: [],
			};
		}

		// Step 2: field extraction.
		const fieldsResult = await deps.runTool({
			id: makeCallId('fields'),
			name: 'code_class_fields',
			input: { entityId: locateData.entityId },
		});

		if (fieldsResult.isError) {
			return {
				value: { found: false, nearest: [] },
				confidence: 'low',
				notes: [
					`code_class_fields returned error: ${fieldsResult.content.slice(0, 200)}`,
					`(class '${input.className}' was located at ${locateData.path}:${locateData.line} but field extraction failed)`,
				],
				toolCalls: [],
			};
		}

		const fieldsData = fieldsResult.data;
		if (!isFieldsData(fieldsData)) {
			return {
				value: { found: false, nearest: [] },
				confidence: 'low',
				notes: ['code_class_fields returned a payload without the expected shape'],
				toolCalls: [],
			};
		}

		// Fallback: when fields[] is empty, the regex / graph extractor
		// found the class but couldn't classify any fields. Often this
		// is a real "no fields" class (marker interface, sealed enum),
		// but it's also the symptom of an annotation-heavy / unparsed-
		// language class (Pydantic with custom decorators, Django models
		// with manager classes, etc.). Read the file head from disk so
		// the caller can cite raw source instead of an empty list.
		const fallbackNotes: string[] = [];
		let bodyExcerpt: string | undefined;
		let bodyExcerptTruncated: boolean | undefined;
		let bodyExcerptSource: 'file-fallback' | undefined;
		if (fieldsData.fields.length === 0) {
			const fb = await tryReadFileForFallback(locateData.path);
			if (fb.ok) {
				bodyExcerpt          = fb.content;
				bodyExcerptTruncated = fb.truncated;
				bodyExcerptSource    = 'file-fallback';
				fallbackNotes.push(`extractor returned 0 fields; read source excerpt from disk (${fb.byteSize} bytes)`);
			} else {
				fallbackNotes.push(`extractor returned 0 fields; disk fallback also failed: ${fb.reason}`);
			}
		}

		const fallback = {
			...(bodyExcerpt          !== undefined ? { bodyExcerpt }          : {}),
			...(bodyExcerptTruncated !== undefined ? { bodyExcerptTruncated } : {}),
			...(bodyExcerptSource    !== undefined ? { bodyExcerptSource }    : {}),
		};

		const value: ExtractFieldsOutput = locateData.isAbstract === true
			? {
				found:      true,
				entityId:   locateData.entityId,
				className:  fieldsData.className,
				language:   fieldsData.language,
				path:       locateData.path,
				line:       locateData.line,
				kind:       locateData.kind,
				isAbstract: true,
				source:     fieldsData.source,
				fields:     fieldsData.fields,
				...fallback,
			}
			: {
				found:     true,
				entityId:  locateData.entityId,
				className: fieldsData.className,
				language:  fieldsData.language,
				path:      locateData.path,
				line:      locateData.line,
				kind:      locateData.kind,
				source:    fieldsData.source,
				fields:    fieldsData.fields,
				...fallback,
			};

		// Substrate P1: pin successful extraction. The namespace's
		// autoDistill: 'always-on-success' policy promotes it to memory
		// when the skill returns cleanly. Cache TTL is 7 days.
		pinSuccessfulExtraction(resolvedClassName, input.repoPath, value, deps);

		return {
			value,
			// High when fields came back; medium for an empty field set
			// (the class exists but has no parseable fields -- could be
			// a marker interface, a sealed enum class, or a body the
			// regex extractor couldn't classify). The body excerpt
			// fallback raises the floor from low to medium when it
			// succeeds.
			confidence: fieldsData.fields.length > 0
				? 'high'
				: (bodyExcerpt !== undefined ? 'medium' : 'low'),
			notes:      fallbackNotes,
			toolCalls: [],
		};
	},
};

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

interface LocateFoundData {
	readonly found:      true;
	readonly entityId:   string;
	readonly path:       string;
	readonly line:       number;
	readonly language:   string;
	readonly kind:       string;
	readonly isAbstract?: boolean;
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

interface FieldsData {
	readonly entityId:  string;
	readonly className: string;
	readonly language:  string;
	readonly fields:    readonly FieldInfo[];
	readonly source:    'graph' | 'body' | 'mixed' | 'none';
}

function isFieldsData(v: unknown): v is FieldsData {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['entityId']  === 'string'
		&& typeof o['className'] === 'string'
		&& typeof o['language']  === 'string'
		&& Array.isArray(o['fields'])
		&& typeof o['source']    === 'string';
}

let CALL_SEQ = 0;
function makeCallId(stage: string): string {
	CALL_SEQ = (CALL_SEQ + 1) & 0xffff;
	return `code-class-extract-fields:${stage}:${Date.now()}:${CALL_SEQ}`;
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (P1 narrow wiring; see
// plans/skills/code/code.class.extract-fields.md for the eventual
// target shape and the per-phase wiring table)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:code.class.extract-fields';

const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = [
	'repo-add', 'reindex', 'connection-add', 'manual',
];

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	// Warm-hit cache: prior successful extraction for this (repo, class).
	{
		name:      'cached-extraction',
		fromOwner: OWNER_ID,
		namespace: 'extracted-classes',
		query: (req) => {
			const task = (req.task ?? {}) as { repoPath?: string; className?: string };
			return { kind: 'byKey', key: cacheKey(task.className ?? '', task.repoPath) };
		},
		limit: 1,
	},
	// Workspace-specific class-name aliases (user said `User`, repo has `UserModel`).
	{
		name:      'class-aliases',
		fromOwner: OWNER_ID,
		namespace: 'class-aliases',
		query: (req) => {
			const task = (req.task ?? {}) as { repoPath?: string };
			return { kind: 'prefix', prefix: `${task.repoPath ?? '*'}::` };
		},
	},
	// Short-TTL miss cache; used for repeated lookups of the same name.
	{
		name:      'recent-misses',
		fromOwner: OWNER_ID,
		namespace: 'recent-misses',
		query: (req) => {
			const task = (req.task ?? {}) as { className?: string };
			return { kind: 'byKey', key: task.className ?? '' };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:  'extracted-classes',
		valueType:  'ExtractedClassRecord',
		autoDistill: 'always-on-success',     // cache
		indexing:   { kind: 'never' },        // lookup by key
		ttl:        '7d',
	},
	{
		namespace:  'class-aliases',
		valueType:  'ClassAlias',
		autoDistill: 'on-pin',                // user-asserted / classifier-routed
		indexing:   { kind: 'never' },        // P1: derived embedding lands in P2
		ttl:        'until-contradicted',
	},
	{
		namespace:  'recent-misses',
		valueType:  'MissRecord',
		autoDistill: 'always-on-success',
		indexing:   { kind: 'never' },
		ttl:        '24h',
	},
	{
		// Declared in P1, populated in P5 when observation distillation
		// wires into skill bodies.
		namespace:  'observations',
		valueType:  'WorkspacePatternObservation',
		autoDistill: 'on-pin',
		indexing:   { kind: 'never' },
		ttl:        '30d',
	},
	{
		// Declared in P1, populated in P5 when the D6 classifier lands.
		namespace:  'user-assertions',
		valueType:  'UserAssertion',
		autoDistill: 'on-pin',
		indexing:   { kind: 'never' },
		ttl:        'until-contradicted',
	},
];

const ASSERTION_INTERESTS: readonly AssertionInterest[] = [
	// Declared in P1; routing inert until P5 (D6 classifier + D14 router).
	{ subjectPattern: 'class-aliases',
	  description: 'Workspace-specific class name aliases (e.g., "User means UserModel here").' },
	{ subjectPattern: 'preferred-repo-for-class',
	  description: 'Which repo wins when a class name is ambiguous across the closure.' },
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
// Substrate helper functions
// ---------------------------------------------------------------------------

interface AliasValue {
	readonly userTerm:  string;
	readonly canonical: string;
	readonly repoPath?: string | null;
}

interface MissValue {
	readonly attemptedName: string;
	readonly nearest:       readonly NearestCandidate[];
}

function cacheKey(className: string, repoPath: string | undefined): string {
	return `${repoPath ?? '*'}::${className}`;
}

/**
 * Read the cached extraction from the substrate-assembled
 * `cached-extraction` slot. Returns undefined when no substrate context
 * or the cache is cold.
 */
function readCachedExtraction(
	className: string,
	repoPath: string | undefined,
	deps: SkillDeps,
): { value: ExtractFieldsOutput } | undefined {
	const slot = deps.context?.slots.get('cached-extraction');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<ExtractFieldsOutput>;
	// Defensive: only return if it really matches this className.
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(className, repoPath)) { return undefined; }
	return { value: hit.value };
}

/**
 * Resolve the user-provided className through any learned aliases.
 * Returns the canonical name when an alias matches, otherwise returns
 * the input unchanged.
 */
function resolveAlias(className: string, repoPath: string | undefined, deps: SkillDeps): string {
	const slot = deps.context?.slots.get('class-aliases');
	if (slot === undefined || slot.length === 0) { return className; }

	for (const entry of slot) {
		const v = (entry as MemoryEntry<AliasValue>).value;
		if (v === undefined) continue;
		if (v.userTerm !== className) continue;
		// Repo scoping: '*' or matching repoPath wins.
		if (v.repoPath != null && repoPath !== undefined && v.repoPath !== repoPath) { continue; }
		return v.canonical;
	}
	return className;
}

/**
 * Pin a successful extraction to working state. The substrate's
 * distillation engine promotes it to memory on successful skill
 * return (D3 'always-on-success' policy on `extracted-classes`).
 *
 * No-op when the runtime didn't provide a working-state ledger.
 */
function pinSuccessfulExtraction(
	className: string,
	repoPath: string | undefined,
	value: ExtractFieldsOutput,
	deps: SkillDeps,
): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'code_class_fields' },
		payload: value,
		claims:  [`extracted:${className}`],
		confidence: 0.95,
	});
	deps.workingState.pin(ref, {
		owner:     OWNER_ID,
		namespace: 'extracted-classes',
		key:       cacheKey(className, repoPath),
		kind:      'fact',
		ttlMs:     7 * 24 * 60 * 60 * 1000,
	});
}

/**
 * Pin a miss + its nearest candidates so a re-attempt of the same name
 * within the TTL window returns warm.
 *
 * No-op when the runtime didn't provide a working-state ledger.
 */
function pinRecentMiss(
	className: string,
	nearest: readonly NearestCandidate[],
	deps: SkillDeps,
): void {
	if (deps.workingState === undefined) { return; }
	const payload: MissValue = { attemptedName: className, nearest };
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'code_class_locate' },
		payload,
		claims:  [`miss:${className}`],
		confidence: 0.9,
	});
	deps.workingState.pin(ref, {
		owner:     OWNER_ID,
		namespace: 'recent-misses',
		key:       className,
		kind:      'fact',
		ttlMs:     24 * 60 * 60 * 1000,
	});
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Compose the substrate-facing fields onto the skill at registration.
 * The legacy `Skill<I, O>` shape ignores the extra fields; the substrate
 * runtime inspects them via the SubstrateSkillExtension cast.
 */
const codeClassExtractFieldsSkillWithSubstrate = {
	...codeClassExtractFieldsSkill,
	...substrateExtension,
};

export function registerCodeClassExtractFieldsSkill(): void {
	registerSkill(codeClassExtractFieldsSkillWithSubstrate as unknown as Skill);
}

// Test exports.
export const _codeClassExtractFieldsSkillForTest = codeClassExtractFieldsSkill;
export const _isLocateDataForTest                = isLocateData;
export const _isFieldsDataForTest                = isFieldsData;
