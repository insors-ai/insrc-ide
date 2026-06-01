/**
 * code.compare.signature -- entity-to-entity signature diff
 * (code-analyzer-skills.md Phase 4.1).
 *
 * Composite skill: pulls two entity summaries via
 * `code.entity.summary` and surfaces the per-field differences as a
 * typed change list. The fields compared are the ones that affect
 * source-level compatibility:
 *
 *   - name        (renames)
 *   - kind        (method <-> function reclassification)
 *   - signature   (parameter / return-type changes)
 *   - language    (rare; flags accidental cross-language compares)
 *   - isExported  (visibility flips)
 *   - isAbstract  / isAsync   (modifier flips)
 *
 * Output is a flat `changes: [{ field, from, to }]` array so
 * downstream renderers (Phase 6.2 findings-table) can pretty-print
 * without re-walking the structure. `changed` is true iff any field
 * differs.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import type {
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

interface CompareSignatureInput {
	readonly aEntityId: string;
	readonly bEntityId: string;
}

interface SignatureChange {
	readonly field: 'name' | 'kind' | 'signature' | 'language' | 'isExported' | 'isAbstract' | 'isAsync';
	readonly from?: string | boolean;
	readonly to?:   string | boolean;
}

type CompareSignatureOutput =
	| {
		readonly found:      true;
		readonly aEntityId:  string;
		readonly bEntityId:  string;
		readonly changed:    boolean;
		readonly changes:    readonly SignatureChange[];
	}
	| {
		readonly found:  false;
		readonly reason: 'a-not-found' | 'b-not-found';
	};

const skill: Skill<CompareSignatureInput, CompareSignatureOutput> = {
	id: 'code.compare.signature',
	name: 'Code: signature diff between two entities',
	description:
		'Pull two entity summaries and surface the differences across name / kind / signature / ' +
		'language / visibility / async / abstract flags. Returns `{ found: false, reason }` when ' +
		'either entity id misses.',
	family: 'comparison-diff',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			aEntityId: { type: 'string', minLength: 32, maxLength: 32 },
			bEntityId: { type: 'string', minLength: 32, maxLength: 32 },
		},
		required: ['aEntityId', 'bEntityId'],
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
					aEntityId: { type: 'string' },
					bEntityId: { type: 'string' },
					changed:   { type: 'boolean' },
					changes:   { type: 'array' },
				},
				required: ['found', 'aEntityId', 'bEntityId', 'changed', 'changes'],
			},
			{
				type: 'object',
				properties: {
					found:  { type: 'boolean', enum: [false] },
					reason: { type: 'string', enum: ['a-not-found', 'b-not-found'] },
				},
				required: ['found', 'reason'],
			},
		],
	},
	toolDeps: [],
	skillDeps: ['code.entity.summary'],
	providerAffinity: 'auto',

	async execute(input: CompareSignatureInput, deps: SkillDeps): Promise<SkillResult<CompareSignatureOutput>> {
		// Substrate: cache hit short-circuits both summary lookups. The
		// signature diff is symmetric on entity ids, so cmp(A, B) and
		// cmp(B, A) share the entry (the cache key sorts ids).
		const cached = readCachedSignatureDiff(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: 'high',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const a = await deps.runSkill<{ entityId: string }, EntitySummary>('code.entity.summary', { entityId: input.aEntityId });
		if (!a.value.found) {
			return {
				value: { found: false, reason: 'a-not-found' },
				confidence: 'low',
				notes: [`Entity '${input.aEntityId}' not in the graph.`],
				toolCalls: [],
			};
		}
		const b = await deps.runSkill<{ entityId: string }, EntitySummary>('code.entity.summary', { entityId: input.bEntityId });
		if (!b.value.found) {
			return {
				value: { found: false, reason: 'b-not-found' },
				confidence: 'low',
				notes: [`Entity '${input.bEntityId}' not in the graph.`],
				toolCalls: [],
			};
		}

		const A = a.value;
		const B = b.value;
		const changes: SignatureChange[] = [];
		stringDiff(changes, 'name',     A.name,     B.name);
		stringDiff(changes, 'kind',     A.kind,     B.kind);
		stringDiff(changes, 'signature', A.signature, B.signature);
		stringDiff(changes, 'language', A.language, B.language);
		boolDiff(changes,  'isExported', A.isExported, B.isExported);
		boolDiff(changes,  'isAbstract', A.isAbstract, B.isAbstract);
		boolDiff(changes,  'isAsync',    A.isAsync,    B.isAsync);

		const value: CompareSignatureOutput = {
			found:      true,
			aEntityId:  input.aEntityId,
			bEntityId:  input.bEntityId,
			changed:    changes.length > 0,
			changes,
		};
		pinSignatureDiff(input, value, deps);
		return {
			value,
			confidence: 'high',
			notes: [],
			toolCalls: [],
		};
	},
};

interface EntitySummary {
	readonly found:      boolean;
	readonly name:       string;
	readonly kind:       string;
	readonly language:   string;
	readonly signature?: string;
	readonly isExported?: boolean;
	readonly isAbstract?: boolean;
	readonly isAsync?:    boolean;
}

function stringDiff(out: SignatureChange[], field: SignatureChange['field'], a: string | undefined, b: string | undefined): void {
	const av = a ?? '';
	const bv = b ?? '';
	if (av !== bv) {
		const change: SignatureChange = { field };
		if (av !== '') (change as { from?: string }).from = av;
		if (bv !== '') (change as { to?: string }).to   = bv;
		out.push(change);
	}
}

function boolDiff(out: SignatureChange[], field: SignatureChange['field'], a: boolean | undefined, b: boolean | undefined): void {
	const av = a === true;
	const bv = b === true;
	if (av !== bv) {
		out.push({ field, from: av, to: bv });
	}
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// A signature diff between two entity ids is symmetric: cmp(A, B) and
// cmp(B, A) produce equivalent change lists (just flipped). Cache key
// sorts the ids so both orientations share one entry. The cached
// payload's `aEntityId`/`bEntityId` reflect whichever invocation
// populated the entry first. Entity signatures change with edits, so
// 7d is the upper bound; reindex triggers force a refresh sooner.

const OWNER_ID: OwnerId = 'skill:code.compare.signature';
const NAMESPACE = 'signature-diffs';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['repo-add', 'reindex', 'manual'];

function cacheKey(input: CompareSignatureInput): string {
	const [lo, hi] = input.aEntityId <= input.bEntityId
		? [input.aEntityId, input.bEntityId]
		: [input.bEntityId, input.aEntityId];
	return `${lo}::${hi}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-signature-diff',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as CompareSignatureInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'CompareSignatureOutput',
		autoDistill: 'always-on-success',
		indexing:    { kind: 'never' },
		ttl:         '7d',
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

function readCachedSignatureDiff(input: CompareSignatureInput, deps: SkillDeps): CompareSignatureOutput | undefined {
	const slot = deps.context?.slots.get('cached-signature-diff');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<CompareSignatureOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinSignatureDiff(input: CompareSignatureInput, value: CompareSignatureOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'code.entity.summary' },
		payload: value,
		claims:  [`signature-diff:${cacheKey(input)}`],
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

const skillWithSubstrate = { ...skill, ...substrateExtension };

export function registerCodeCompareSignatureSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
