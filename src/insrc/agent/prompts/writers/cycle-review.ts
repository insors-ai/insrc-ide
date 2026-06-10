/**
 * cycle-review writer v1 -- Stage 3 of the section-flow per-TODO loop.
 * Cloud LLM judges this cycle's outputs (which to keep, which steps
 * to schedule next).
 *
 * Migrated from `agent/section-flow/step-cycle-review.ts`'s inline
 * REVIEW_ROLE + buildReviewUser as part of Phase 0 of
 * `plans/section-flow-architecture-redesign.md`. Behaviour-preserving.
 */

import type { LLMMessage } from '../../../shared/types.js';
import type { CatalogSkill } from '../../content-gen/plan-tree-runner.js';
import type {
	CycleMemory,
	DiscoveryStep,
	StepOutput,
} from '../../content-gen/discovery-plan.js';
import type { RequiredFact } from '../../section-flow/fact-gap-types.js';
import type { TodoSpec } from '../../section-flow/types.js';
import { summarizeCycleMemory } from '../../section-flow/cycle-memory.js';
import type { PromptWriter } from '../types.js';

export interface CycleReviewWriterInput {
	readonly todo:               TodoSpec;
	readonly gapFacts:           readonly RequiredFact[];
	readonly stepsThisCycle:     readonly DiscoveryStep[];
	readonly cycleOutputs:       readonly StepOutput[];
	readonly cycleMemory:        CycleMemory;
	readonly cycle:              1 | 2 | 3;
	readonly catalog:            readonly CatalogSkill[];
	readonly isRetry:            boolean;
	readonly priorFailureReason: string | undefined;
}

const REVIEW_ROLE = [
	'You are the CYCLE REVIEWER for one cycle of one TODO of an',
	'investigation report. You see the gap-facts list the cycle is',
	'targeting + the outputs this cycle produced + prior-cycle context,',
	'and you decide three things:',
	'',
	'  - WHICH of this cycle\'s outputs are on-topic + useful (promote to',
	'    the retained ledger via `keep`).',
	'  - WHAT remains uncovered (emit `new_steps` for the next cycle to',
	'    acquire; empty array means we\'re done).',
	'  - OPTIONALLY a brief carry-forward note (`scratchpad`).',
	'',
	'You emit a SINGLE JSON object: { "keep": [...], "new_steps": [...],',
	'"scratchpad"?: "..." }. No prose, no markdown fences, no preamble.',
].join('\n');

function renderGapFacts(gapFactList: readonly RequiredFact[]): string {
	if (gapFactList.length === 0) { return '(no gap facts)'; }
	const lines: string[] = [];
	for (let i = 0; i < gapFactList.length; i++) {
		const f = gapFactList[i]!;
		lines.push(`[${i}] ${f.id} (${f.status})`);
		lines.push(`    fact: ${f.fact}`);
		lines.push(`    why:  ${f.why}`);
	}
	return lines.join('\n');
}

function renderCycleOutputs(
	outputs:        readonly StepOutput[],
	stepsThisCycle: readonly DiscoveryStep[],
): string {
	if (outputs.length === 0) { return '(no outputs)'; }
	const stepsById = new Map(stepsThisCycle.map(s => [s.id, s] as const));
	const lines: string[] = [];
	for (const out of outputs) {
		const step = stepsById.get(out.stepId);
		const intent = step !== undefined ? step.intent : '(no step definition)';
		lines.push(`### ${out.stepId} (status: ${out.status}) -- ${intent}`);
		if (out.facts.length === 0) {
			lines.push('  facts: (none)');
		} else {
			for (const f of out.facts) {
				lines.push(`  - ${f}`);
			}
		}
		if (out.citations.length > 0) {
			lines.push(`  citations: ${out.citations.length}`);
		}
		lines.push('');
	}
	return lines.join('\n').trimEnd();
}

function renderCatalogSummary(catalog: readonly CatalogSkill[]): string {
	if (catalog.length === 0) { return '## SKILL CATALOG (empty)'; }
	const lines: string[] = [`## SKILL CATALOG (${catalog.length} skills available)`];
	for (const s of catalog) {
		const desc = s.description.replace(/\s+/g, ' ').trim().slice(0, 120);
		lines.push(`- \`${s.id}\` -- ${desc}`);
	}
	return lines.join('\n');
}

function buildReviewUser(input: CycleReviewWriterInput): string {
	const factsBlock     = renderGapFacts(input.gapFacts);
	const outputsBlock   = renderCycleOutputs(input.cycleOutputs, input.stepsThisCycle);
	const cycleMemBlock  = summarizeCycleMemory(input.cycleMemory);
	const catalogBlock   = renderCatalogSummary(input.catalog);
	const retryAddendum  = input.isRetry
		? [
			'',
			'## RETRY CORRECTION',
			`Your previous response was rejected: ${input.priorFailureReason ?? 'unknown'}`,
			'Emit a new JSON object that satisfies every rule below.',
			'',
		].join('\n')
		: '';

	const lines: string[] = [
		'## TODO OBJECTIVE',
		input.todo.objective,
		'',
		'## GAP FACTS (coverage targets; indices are stable for targetsCriteria)',
		factsBlock,
		'',
		`## CYCLE: ${input.cycle}`,
		'',
		'## THIS CYCLE\'S STEP OUTPUTS',
		outputsBlock,
	];
	if (cycleMemBlock.length > 0) {
		lines.push('');
		lines.push('## PRIOR CYCLE CONTEXT');
		lines.push('');
		lines.push(cycleMemBlock);
	}
	lines.push('');
	lines.push('## OUTPUT SHAPE');
	lines.push('');
	lines.push('{');
	lines.push('  "keep": ["step-1", "step-3"],                  // ids from THIS CYCLE\'S step outputs');
	lines.push('  "new_steps": [                                 // empty array = terminate');
	lines.push('    {');
	lines.push('      "id": "step-N",');
	lines.push('      "intent": "concrete sentence -- which gap fact + why prior attempt missed",');
	lines.push('      "skills": [');
	lines.push('        { "id": "sN.a", "skillId": "<catalog id>", "context": "literal args" }');
	lines.push('      ],');
	lines.push('      "targetsCriteria": [0, 1]                   // indices into GAP FACTS');
	lines.push('    }');
	lines.push('  ],');
	lines.push('  "scratchpad": "optional <=300 char carry-forward note"');
	lines.push('}');
	lines.push('');
	lines.push('## RULES');
	lines.push('  - `keep` ids MUST be from THIS CYCLE\'S step outputs only (see above).');
	lines.push('  - `new_steps` items follow the discovery-plan-expansion rules:');
	lines.push('      * each step has a concrete intent sentence');
	lines.push('      * each PlannedSkillCall.skillId MUST be in the SKILL CATALOG');
	lines.push('      * each step.targetsCriteria is a non-empty array of valid fact indices (0..' + String(Math.max(0, input.gapFacts.length - 1)) + ')');
	lines.push('      * context for each skill call carries the literal args (file path / class name / connection id / etc.)');
	lines.push('  - Emit `new_steps: []` to terminate the cycle loop when every gap fact is now covered (or the remaining gaps are unrecoverable with available skills).');
	if (input.cycle > 1) {
		lines.push('  - DO NOT re-emit a step whose (skillId, context) matches an already-attempted step in PRIOR CYCLE CONTEXT with failed/open coverage. Try a different angle (different args, different skill, decomposed sub-fact).');
	}
	lines.push('  - `scratchpad` is optional. Use it for qualitative judgements the mechanical coverage map can\'t capture (e.g. "the class file uses non-standard import paths -- flag for writer").');
	lines.push(retryAddendum);
	lines.push('');
	lines.push(catalogBlock);
	lines.push('');
	lines.push('## TASK');
	lines.push('Emit the JSON object now. Begin with "{" and end with "}".');
	return lines.join('\n');
}

export const cycleReviewWriterV1: PromptWriter<CycleReviewWriterInput, readonly LLMMessage[]> = {
	id:      'cycle-review',
	version: 1,
	tier:    'cloud',
	summary: 'Stage 3: judge this cycle\'s outputs (keep / new_steps / scratchpad).',

	build(input: CycleReviewWriterInput): readonly LLMMessage[] {
		return [
			{ role: 'system', content: REVIEW_ROLE },
			{ role: 'user',   content: buildReviewUser(input) },
		];
	},
};
