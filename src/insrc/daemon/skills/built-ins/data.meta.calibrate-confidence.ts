/**
 * data.meta.calibrate-confidence -- Phase 7.4 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic, deterministic post-processing helper. Input: a list of
 * SkillResult-shaped findings + the question + the tool-error trace.
 * Output: a calibrated final confidence value + the chain of rungs
 * that produced it.
 *
 * The reviewer (cloud-side LLM) consumes the calibrated value as a
 * hard prior, mitigating the over-acceptance failure mode the
 * 2026-05-01 fixes addressed at the prompt level.
 *
 * Calibration rules (in order):
 *
 *   1. If `findings` is empty: 'low' (no evidence).
 *   2. Start at min(finding.confidence) across all findings.
 *   3. If `toolErrorTrace` is non-empty: downgrade one rung
 *      (high -> medium, medium -> low, low stays low).
 *   4. If any finding's `notes` array contains a string starting with
 *      "feasibility-rejection:" or "schema-rejection:" the calibrator
 *      clamps to 'low' regardless of the body's claim. (Defensive
 *      restatement of the registry's per-skill clamp -- duplicated
 *      here so the calibration also catches findings produced
 *      outside the registry's clamp path.)
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillConfidence, SkillResult } from '../types.js';

interface FindingShape {
	readonly skillId: string;
	readonly confidence: SkillConfidence;
	readonly notes?: readonly string[];
}

interface CalibrateConfidenceInput {
	readonly question: string;
	readonly findings: readonly FindingShape[];
	readonly toolErrorTrace?: readonly string[];
}

interface CalibrateConfidenceOutput {
	readonly calibrated: SkillConfidence;
	readonly minOfFindings: SkillConfidence | null;
	readonly rationale: readonly string[];
	readonly downgradedFromToolError: boolean;
	readonly clampedFromCriticalNote: boolean;
}

const CONFIDENCE_RANK: Record<SkillConfidence, number> = { high: 2, medium: 1, low: 0 };
const RANK_TO_CONFIDENCE: SkillConfidence[] = ['low', 'medium', 'high'];

const CRITICAL_NOTE_PREFIXES = ['feasibility-rejection:', 'schema-rejection:'];

const skill: Skill<CalibrateConfidenceInput, CalibrateConfidenceOutput> = {
	id: 'data.meta.calibrate-confidence',
	name: 'Meta: calibrate confidence',
	description:
		'Calibrate a list of SkillResult-shaped findings into a single final confidence value. Deterministic: ' +
		'starts at the min confidence across findings, downgrades one rung on tool errors, clamps to `low` on ' +
		'feasibility / schema rejection notes. Returns the rationale chain so the reviewer can audit it.',
	family: 'meta',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			question: { type: 'string' },
			findings: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						skillId:    { type: 'string' },
						confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
						notes:      { type: 'array', items: { type: 'string' } },
					},
					required: ['skillId', 'confidence'],
					additionalProperties: true,
				},
			},
			toolErrorTrace: { type: 'array', items: { type: 'string' } },
		},
		required: ['question', 'findings'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			calibrated:                { type: 'string', enum: ['high', 'medium', 'low'] },
			minOfFindings:             { type: ['string', 'null'], enum: ['high', 'medium', 'low', null] },
			rationale:                 { type: 'array', items: { type: 'string' } },
			downgradedFromToolError:   { type: 'boolean' },
			clampedFromCriticalNote:   { type: 'boolean' },
		},
		required: ['calibrated', 'minOfFindings', 'rationale', 'downgradedFromToolError', 'clampedFromCriticalNote'],
		additionalProperties: false,
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input): Promise<SkillResult<CalibrateConfidenceOutput>> {
		const rationale: string[] = [];

		if (input.findings.length === 0) {
			rationale.push('no findings -- calibrated to low');
			return result('low', null, rationale, false, false);
		}

		// Step 2: min across findings
		let minRank = CONFIDENCE_RANK[input.findings[0]!.confidence];
		for (const f of input.findings) {
			const r = CONFIDENCE_RANK[f.confidence];
			if (r < minRank) minRank = r;
		}
		const minConfidence = RANK_TO_CONFIDENCE[minRank]!;
		rationale.push(`min over ${input.findings.length} findings: ${minConfidence}`);

		let currentRank = minRank;

		// Step 4: clamp to low on critical notes (checked before tool-error
		// downgrade since clamp dominates downgrade)
		const clampedFromCriticalNote = input.findings.some(f =>
			(f.notes ?? []).some(n => CRITICAL_NOTE_PREFIXES.some(p => n.startsWith(p)))
		);
		if (clampedFromCriticalNote) {
			rationale.push('clamped to low: feasibility / schema rejection note present');
			currentRank = 0;
			return result(
				RANK_TO_CONFIDENCE[currentRank]!,
				minConfidence,
				rationale,
				false,
				true,
			);
		}

		// Step 3: downgrade one rung on tool errors
		const downgradedFromToolError = (input.toolErrorTrace ?? []).length > 0;
		if (downgradedFromToolError) {
			const before = currentRank;
			currentRank = Math.max(0, currentRank - 1);
			rationale.push(
				`downgraded one rung for ${(input.toolErrorTrace ?? []).length} tool error(s): ` +
				`${RANK_TO_CONFIDENCE[before]} -> ${RANK_TO_CONFIDENCE[currentRank]}`,
			);
		}

		return result(
			RANK_TO_CONFIDENCE[currentRank]!,
			minConfidence,
			rationale,
			downgradedFromToolError,
			false,
		);
	},
};

function result(
	calibrated: SkillConfidence,
	minOfFindings: SkillConfidence | null,
	rationale: string[],
	downgradedFromToolError: boolean,
	clampedFromCriticalNote: boolean,
): SkillResult<CalibrateConfidenceOutput> {
	return {
		value: { calibrated, minOfFindings, rationale, downgradedFromToolError, clampedFromCriticalNote },
		confidence: 'high',
		toolCalls: [],
	};
}

export function registerDataMetaCalibrateConfidenceSkill(): void {
	registerSkill(skill as unknown as Skill);
}
