/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Stage 6 of the fact-gap-driven task loop -- Phase epsilon of
 * plans/section-flow-fact-gap-loop.md, reworked in Phase 1 batch 3b
 * of plans/section-flow-architecture-redesign.md.
 *
 * One LLM call. Reads the retained ledger + the per-step goal-aware
 * summaries (pre-resolved from `artifact_vec.summary` by the
 * orchestrator) + the fact-gap analysis + the TODO objective, and
 * emits the section markdown.
 *
 * Critical content rules (enforced by the prompt):
 *
 *   - Use ONLY claims present in the per-step SUMMARIES.
 *   - For each unmet `RequiredFact` (still `absent` at termination),
 *     emit a structured handoff block: fact name + why needed +
 *     what was tried (cycle/stepId from cycleMemory's priorAsks) +
 *     concrete next-step suggestion. Decision #14 (carried over).
 *   - Do NOT invent fields, types, examples not present in the
 *     summaries.
 *
 * Defensive behaviour:
 *   - Empty retained ledger + every fact still absent -> deterministic
 *     "all gaps unresolved" stub. No LLM call required.
 *   - LLM returns empty body -> deterministic concatenation of the
 *     per-step summaries + gap handoff blocks. The orchestrator's
 *     section-review (Q5) can still flag this as revise-edits /
 *     revise-major.
 *
 * No retry at this stage -- the output is markdown, not JSON, and
 * the section-review verdict downstream is the quality gate.
 */

import type { LLMMessage, LLMProvider } from '../../shared/types.js';
import type { CloudMemoryView } from '../working-memory/index.js';
import type { StepOutput } from '../content-gen/discovery-plan.js';
import type { FactGapAnalysis, RequiredFact } from './fact-gap-types.js';
import type { TodoSpec } from './types.js';
import { getLogger } from '../../shared/logger.js';
import { getPromptRegistry } from '../prompts/registry.js';
import type { PriorAttempt, SectionSynthWriterInput } from '../prompts/writers/section-synth.js';

const log = getLogger('section-flow:synthesis');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SynthesisInput {
	readonly todo:            TodoSpec;
	readonly memory:          CloudMemoryView;
	readonly gapAnalysis:     FactGapAnalysis;
	readonly retainedLedger:  readonly StepOutput[];
	/**
	 * Pre-resolved per-step summary text (reviewer-emitted claim from
	 * `artifact_vec.summary` for each call, joined per step; the
	 * orchestrator builds this once via `resolveStepSummaries` so
	 * Stage 6 + Stage 7 don't double-fetch).
	 */
	readonly summariesByStep: ReadonlyMap<string, string>;
	/**
	 * Flat list of every step that executed for this TODO -- the
	 * synthesizer reads these to render the "what was tried" block
	 * for each unmet gap. Phase 4 batch 4.2 replaced the old
	 * `cycleMemory.priorAsks` (cycle-scoped) with this simpler
	 * dynamic-loop history.
	 */
	readonly priorAttempts:   readonly PriorAttempt[];
	readonly provider:        LLMProvider;
}

export interface SynthesisResult {
	readonly markdown:      string;
	/** True when the LLM produced an empty body and we fell back to deterministic concat. */
	readonly usedFallback:  boolean;
	/** Required facts that remained `absent` at termination -- surfaced for telemetry. */
	readonly unmetGaps:     readonly RequiredFact[];
}

const MAX_SYNTHESIS_TOKENS = 8192;

export async function synthesizeSectionFromLedger(
	input: SynthesisInput,
): Promise<SynthesisResult> {
	const unmetGaps = computeUnmetGaps(input.gapAnalysis, input.retainedLedger);

	if (input.retainedLedger.length === 0 && unmetGaps.length === input.gapAnalysis.requiredFacts.length) {
		// Zero retained facts AND every required fact unresolved -- no
		// material for the LLM to work with. Emit a deterministic
		// all-gaps stub so the section review can route it.
		log.warn({ todoId: input.todo.id }, 'synthesizeSectionFromLedger: empty ledger + all-gaps -> deterministic stub');
		return {
			markdown:     buildAllGapsStub(input.todo, unmetGaps),
			usedFallback: true,
			unmetGaps,
		};
	}

	const writer = getPromptRegistry().get<SectionSynthWriterInput, readonly LLMMessage[]>('section-synth');
	const messages = [...writer.build({
		todo:            input.todo,
		retainedLedger:  input.retainedLedger,
		summariesByStep: input.summariesByStep,
		priorAttempts:   input.priorAttempts,
		unmetGaps,
	})];
	const response = await input.provider.complete(messages, {
		maxTokens:       MAX_SYNTHESIS_TOKENS,
		temperature:     0,
		disableThinking: true,
		// NOT responseFormat: 'json' -- the output is markdown.
	});
	const text = response.text.trim();
	if (text.length === 0) {
		log.warn({ todoId: input.todo.id, ledgerSize: input.retainedLedger.length, unmetGapCount: unmetGaps.length }, 'synthesizeSectionFromLedger: empty LLM response -> deterministic fallback');
		return {
			markdown:     buildDeterministicFallback(input.todo, input.retainedLedger, input.summariesByStep, unmetGaps),
			usedFallback: true,
			unmetGaps,
		};
	}
	return {
		markdown:     text,
		usedFallback: false,
		unmetGaps,
	};
}

// ---------------------------------------------------------------------------
// Defensive fallbacks
// ---------------------------------------------------------------------------

function computeUnmetGaps(
	gapAnalysis:    FactGapAnalysis,
	retainedLedger: readonly StepOutput[],
): readonly RequiredFact[] {
	const requiredAbsent = gapAnalysis.requiredFacts.filter(f => f.status === 'absent' || f.status === 'partial');
	// Phase 1 batch 3b: without facts[] the "did we acquire anything"
	// proxy becomes step status. A step with `status: 'failed'`
	// produced nothing; `'ok'` or `'partial'` produced at least one
	// non-empty skill call. The reviewer's CLOSES / PARTIALLY markers
	// drive the precise convergence decision in Phase 5; for now this
	// is the conservative analogue of the prior "any facts" check.
	const anyEvidence = retainedLedger.some(o => o.status !== 'failed');
	if (!anyEvidence) {
		return requiredAbsent;
	}
	// Even when we have evidence, the original-absent set is what the
	// synthesizer prompt surfaces as "still potentially unmet" -- the
	// LLM judges which were actually covered by the summaries.
	return requiredAbsent;
}

function buildAllGapsStub(todo: TodoSpec, unmetGaps: readonly RequiredFact[]): string {
	const lines: string[] = [
		`# ${todo.objective}`,
		'',
		'_(no discovery facts were retained; every required fact remains unresolved.)_',
		'',
		'## Unresolved facts',
		'',
	];
	for (const gap of unmetGaps) {
		lines.push(`- **${gap.fact}** -- ${gap.why}`);
		if (gap.suggestedSkills !== undefined && gap.suggestedSkills.length > 0) {
			lines.push(`  Suggested skills: ${gap.suggestedSkills.map(s => '`' + s + '`').join(', ')}`);
		}
	}
	return lines.join('\n');
}

function buildDeterministicFallback(
	todo:            TodoSpec,
	retainedLedger:  readonly StepOutput[],
	summariesByStep: ReadonlyMap<string, string>,
	unmetGaps:       readonly RequiredFact[],
): string {
	const lines: string[] = [
		`# ${todo.objective}`,
		'',
		'_(Assembled deterministically; the synthesis LLM returned an empty body.)_',
		'',
	];
	if (retainedLedger.length > 0) {
		lines.push('## Retained step summaries');
		lines.push('');
		for (const o of retainedLedger) {
			lines.push(`### ${o.stepId} (${o.status})`);
			const summary = summariesByStep.get(o.stepId);
			if (summary !== undefined && summary.trim().length > 0) {
				lines.push(summary);
			} else {
				lines.push('(no summary)');
			}
			lines.push('');
		}
	}
	if (unmetGaps.length > 0) {
		lines.push('## Unresolved gaps');
		lines.push('');
		for (const gap of unmetGaps) {
			lines.push(`- **${gap.fact}** -- ${gap.why}`);
		}
	}
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _computeUnmetGapsForTest           = computeUnmetGaps;
export const _buildAllGapsStubForTest           = buildAllGapsStub;
export const _buildDeterministicFallbackForTest = buildDeterministicFallback;
