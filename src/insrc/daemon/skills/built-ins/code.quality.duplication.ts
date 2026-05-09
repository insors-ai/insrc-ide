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

const TARGET_KINDS: ReadonlySet<EntityKind> = new Set(['function', 'method']);

const DEFAULT_THRESHOLD   = 0.8;
const DEFAULT_MAX_PAIRS   = 100;
const HARD_PAIR_BUDGET    = 500;

interface DuplicationInput {
	readonly repoPath:    string;
	readonly threshold?:  number;
	readonly maxPairs?:   number;
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
			maxPairs:  { type: 'number', minimum: 1, maximum: HARD_PAIR_BUDGET, description: `Top-N pairs returned. Default: ${DEFAULT_MAX_PAIRS}.` },
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

	async execute(input: DuplicationInput, _deps: SkillDeps): Promise<SkillResult<DuplicationOutput>> {
		const threshold = clamp(input.threshold ?? DEFAULT_THRESHOLD, 0, 1);
		const maxPairs  = Math.max(1, Math.min(HARD_PAIR_BUDGET, input.maxPairs ?? DEFAULT_MAX_PAIRS));

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
		const truncated = pairs.length > maxPairs;
		const top = pairs.slice(0, maxPairs);

		const out: DuplicationOutput = {
			repoPath:           input.repoPath,
			entityCount:        targets.length,
			fingerprintedCount: sigs.length,
			pairCount:          pairs.length,
			threshold,
			pairs:              top,
		};

		const result: SkillResult<DuplicationOutput> = {
			value: out,
			confidence: sigs.length > 0 ? 'high' : 'low',
			notes: sigs.length === 0
				? [`No fingerprintable function / method bodies in '${input.repoPath}' (need >= 5 tokens each).`]
				: [],
			toolCalls: [],
		};
		return truncated ? { ...result, truncated: true } : result;
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

export function registerCodeQualityDuplicationSkill(): void {
	registerSkill(codeQualityDuplicationSkill as unknown as Skill);
}
