/**
 * code.quality.duplication -- find near-duplicate functions /
 * methods (code-analyzer-skills.md Phase 5.3).
 *
 * Min-hash signature per entity body; pair scan with optional LSH
 * bucketing; report pairs whose Jaccard estimate clears
 * SIMILARITY_THRESHOLD.
 *
 * Math lives in `code.quality.duplication.algo.ts`.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import { listEntitiesForRepo } from '../../../db/entities.js';
import type { Entity, EntityKind } from '../../../shared/types.js';
import {
	computeSignature,
	jaccardEstimate,
	type Signature,
} from './code.quality.duplication.algo.js';
import type {
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

const TARGET_KINDS: ReadonlySet<EntityKind> = new Set(['function', 'method']);

const DEFAULT_THRESHOLD   = 0.8;
// Phase B.1: removed maxPairs. Returns the full sorted pair list;
// renderer pages for the LLM.

interface DuplicationInput {
	readonly repoPath:    string;
	readonly threshold?:  number;
}

interface DupePartner {
	readonly id:        string;
	readonly name:      string;
	readonly file:      string;
	readonly startLine: number;
}

interface DupePair {
	readonly a:        DupePartner;
	readonly b:        DupePartner;
	readonly similarity: number;
}

interface DuplicationOutput {
	readonly repoPath:        string;
	readonly entityCount:     number;
	readonly fingerprintedCount: number;
	readonly pairCount:       number;
	readonly threshold:       number;
	readonly pairs:           readonly DupePair[];
}

const codeQualityDuplicationSkill: Skill<DuplicationInput, DuplicationOutput> = {
	id: 'code.quality.duplication',
	name: 'Code: near-duplicate functions / methods',
	description:
		'Detect near-duplicate function / method bodies via min-hash. Reports pairs whose ' +
		'Jaccard similarity clears the threshold (default 0.8). String literals + numeric ' +
		'literals are normalised so renamed copies still match.',
	family: 'quality-profile',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			repoPath:  { type: 'string', description: 'Repo root absolute path.' },
			threshold: { type: 'number', minimum: 0, maximum: 1, description: `Jaccard threshold. Default: ${DEFAULT_THRESHOLD}.` },
		},
		required: ['repoPath'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			repoPath:           { type: 'string' },
			entityCount:        { type: 'number' },
			fingerprintedCount: { type: 'number' },
			pairCount:          { type: 'number' },
			threshold:          { type: 'number' },
			pairs:              { type: 'array' },
		},
		required: ['repoPath', 'entityCount', 'fingerprintedCount', 'pairCount', 'threshold', 'pairs'],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: DuplicationInput, deps: SkillDeps): Promise<SkillResult<DuplicationOutput>> {
		const threshold = clamp(input.threshold ?? DEFAULT_THRESHOLD, 0, 1);
		const normalized: DuplicationInput = { ...input, threshold };

		// Substrate: cache hit short-circuits the O(N^2) pair scan.
		const cached = readCachedReport(normalized, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.fingerprintedCount > 0 ? 'high' : 'low',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		const all = await listEntitiesForRepo(null, input.repoPath);
		const targets = all.filter(e => TARGET_KINDS.has(e.kind) && e.body.length > 0);

		// Compute signatures up front so the pair scan is signature-vs-signature.
		const sigs: { entity: Entity; sig: Signature }[] = [];
		for (const e of targets) {
			const sig = computeSignature(e.body);
			if (sig !== null) sigs.push({ entity: e, sig });
		}

		const pairs: DupePair[] = [];
		// O(N^2) pair scan -- caller-friendly for repos in the
		// thousands; for tens-of-thousands of functions, the v1 caller
		// should narrow the scope by file or directory.
		for (let i = 0; i < sigs.length; i++) {
			for (let j = i + 1; j < sigs.length; j++) {
				const sim = jaccardEstimate(sigs[i]!.sig, sigs[j]!.sig);
				if (sim >= threshold) {
					pairs.push({
						a:          toPartner(sigs[i]!.entity),
						b:          toPartner(sigs[j]!.entity),
						similarity: round2(sim),
					});
				}
			}
		}

		pairs.sort((a, b) => b.similarity - a.similarity);

		const out: DuplicationOutput = {
			repoPath:           input.repoPath,
			entityCount:        targets.length,
			fingerprintedCount: sigs.length,
			pairCount:          pairs.length,
			threshold,
			pairs,
		};
		pinReport(normalized, out, deps);

		return {
			value: out,
			confidence: sigs.length > 0 ? 'high' : 'low',
			notes: sigs.length === 0
				? [`No fingerprintable function / method bodies in '${input.repoPath}' (need >= 5 tokens each).`]
				: [],
			toolCalls: [],
		};
	},
};

function toPartner(e: Entity): DupePartner {
	return {
		id:        e.id,
		name:      e.name,
		file:      e.file,
		startLine: e.startLine,
	};
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (per plans/skills/code/code.quality.suite.md)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:code.quality.duplication';
const NAMESPACE = 'duplication-reports';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['repo-add', 'reindex', 'manual'];

function cacheKey(input: DuplicationInput): string {
	return `${input.repoPath}::${input.threshold ?? DEFAULT_THRESHOLD}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-report',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as DuplicationInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'DuplicationOutput',
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

function readCachedReport(input: DuplicationInput, deps: SkillDeps): DuplicationOutput | undefined {
	const slot = deps.context?.slots.get('cached-report');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<DuplicationOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinReport(input: DuplicationInput, value: DuplicationOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'minhash-jaccard' },
		payload: value,
		claims:  [`duplication:${input.repoPath}::${input.threshold ?? DEFAULT_THRESHOLD}`],
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

const codeQualityDuplicationSkillWithSubstrate = {
	...codeQualityDuplicationSkill,
	...substrateExtension,
};

export function registerCodeQualityDuplicationSkill(): void {
	registerSkill(codeQualityDuplicationSkillWithSubstrate as unknown as Skill);
}
