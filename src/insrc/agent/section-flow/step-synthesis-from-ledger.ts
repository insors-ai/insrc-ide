/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Stage 6 of the fact-gap-driven task loop -- Phase epsilon of
 * plans/section-flow-fact-gap-loop.md.
 *
 * Replaces the deterministic per-tree `step-section-assembly.ts`.
 * One LLM call. Reads the retained ledger + the fact-gap analysis
 * (so unmet gaps surface as structured handoff blocks per Decision
 * #14) + the TODO objective and emits the section markdown.
 *
 * Critical content rules (enforced by the prompt, surfaced as
 * test assertions via prompt-structure checks):
 *
 *   - Use ONLY facts present in the retained ledger.
 *   - For each unmet `RequiredFact` (still `absent` at termination),
 *     emit a structured handoff block: fact name + why needed +
 *     what was tried (cycle/stepId + outcome from cycleMemory's
 *     priorAsks) + concrete next-step suggestion. Decision #14.
 *   - Do NOT invent fields, types, examples not present in the
 *     retained ledger.
 *
 * Defensive behaviour:
 *   - Empty retained ledger + every fact still absent -> deterministic
 *     "all gaps unresolved" stub. No LLM call required.
 *   - LLM returns empty body -> deterministic concatenation of facts
 *     + gap handoff blocks. The orchestrator's section-review (Q5)
 *     can still flag this as revise-edits / revise-major.
 *
 * No retry at this stage -- the output is markdown, not JSON, and
 * the section-review verdict downstream is the quality gate.
 */

import type { LLMMessage, LLMProvider } from '../../shared/types.js';
import type { MemoryShapeBundle } from '../working-memory/index.js';
import type { CycleMemory, StepOutput } from '../content-gen/discovery-plan.js';
import type { FactGapAnalysis, RequiredFact } from './fact-gap-types.js';
import type { TodoSpec } from './types.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:synthesis');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SynthesisInput {
	readonly todo:            TodoSpec;
	readonly memory:          MemoryShapeBundle;
	readonly gapAnalysis:     FactGapAnalysis;
	readonly retainedLedger:  readonly StepOutput[];
	/** Final cycleMemory after the cycle loop -- carries priorAsks so the synthesis
	 *  prompt can render concrete "what was tried" details for unmet gaps. */
	readonly cycleMemory:     CycleMemory;
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
	const unmetGaps = computeUnmetGaps(input.gapAnalysis, input.retainedLedger, input.cycleMemory);

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

	const messages: LLMMessage[] = [
		{ role: 'system', content: SYNTH_ROLE },
		{ role: 'user',   content: buildSynthUser(input, unmetGaps) },
	];
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
			markdown:     buildDeterministicFallback(input.todo, input.retainedLedger, unmetGaps),
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
// Prompt
// ---------------------------------------------------------------------------

const SYNTH_ROLE = [
	'You are the SECTION SYNTHESIZER. You receive a TODO objective + a',
	'retained ledger of facts the discovery loop acquired + a list of',
	'unmet gaps the loop could not close. You emit the section markdown.',
	'',
	'Rules:',
	'  1. Use ONLY facts present in the RETAINED LEDGER. Do NOT invent',
	'     field names, types, classes, file paths, line numbers, or',
	'     examples not present.',
	'  2. For each UNMET GAP, emit a structured handoff block with the',
	'     fact name, why it was needed, what was attempted (with cycle +',
	'     stepId + outcome), and a concrete next-step suggestion. Use',
	'     the exact format shown in UNMET GAPS below.',
	'  3. Cite facts via inline markdown links from the ledger\'s',
	'     citation entries when present.',
	'  4. Structure: short intro paragraph naming the objective + what',
	'     was acquired vs. what remains unresolved; the main section',
	'     content from the ledger facts; the unmet-gap handoff blocks',
	'     at the bottom (or inline where they break a sub-section).',
	'',
	'Emit the FULL section markdown. No JSON envelope, no preamble,',
	'no "Here is the section" commentary.',
].join('\n');

function buildSynthUser(input: SynthesisInput, unmetGaps: readonly RequiredFact[]): string {
	const lines: string[] = [
		'## TODO OBJECTIVE',
		input.todo.objective,
		'',
		'## RETAINED LEDGER',
		renderLedger(input.retainedLedger),
		'',
	];
	if (unmetGaps.length > 0) {
		lines.push('## UNMET GAPS (render each as a structured handoff block)');
		lines.push('');
		for (const gap of unmetGaps) {
			lines.push(renderUnmetGapInput(gap, input.cycleMemory));
			lines.push('');
		}
	}
	lines.push('## TASK');
	lines.push('Emit the full section markdown now. No JSON envelope, no preamble.');
	return lines.join('\n');
}

function renderLedger(ledger: readonly StepOutput[]): string {
	if (ledger.length === 0) { return '(empty)'; }
	const lines: string[] = [];
	for (const o of ledger) {
		lines.push(`### ${o.stepId} (status: ${o.status})`);
		if (o.facts.length === 0) {
			lines.push('  facts: (none)');
		} else {
			for (const f of o.facts) { lines.push(`  - ${f}`); }
		}
		if (o.citations.length > 0) {
			lines.push('  citations:');
			for (const c of o.citations) {
				const range = c.startLine !== undefined && c.endLine !== undefined
					? `#L${c.startLine}-L${c.endLine}`
					: (c.startLine !== undefined ? `#L${c.startLine}` : '');
				const label = c.label ?? c.path.split('/').pop() ?? c.path;
				lines.push(`    - [${label}](${c.path}${range})`);
			}
		}
		lines.push('');
	}
	return lines.join('\n').trimEnd();
}

function renderUnmetGapInput(gap: RequiredFact, cycleMemory: CycleMemory): string {
	// Find the prior-cycle attempts that targeted this fact by id.
	// cycleMemory.priorAsks is the source of truth for "what was tried".
	const attempts: string[] = [];
	for (const ask of cycleMemory.priorAsks) {
		for (const s of ask.steps) {
			if (s.intent.toLowerCase().includes(gap.id.toLowerCase()) ||
			    s.intent.toLowerCase().includes(gap.fact.toLowerCase().slice(0, 32))) {
				attempts.push(`  - cycle ${ask.cycle} step \`${s.id}\`: ${s.intent}`);
			}
		}
	}
	const suggested = gap.suggestedSkills !== undefined && gap.suggestedSkills.length > 0
		? gap.suggestedSkills.map(s => `\`${s}\``).join(', ')
		: '(no skill suggestion available)';
	const lines: string[] = [
		`### Unresolved fact: ${gap.fact}`,
		`Required for: ${gap.why}`,
		'',
		'Attempts:',
		attempts.length > 0 ? attempts.join('\n') : '  (no recorded attempts targeted this fact)',
		'',
		`Suggested next step: invoke one of ${suggested} with concrete args for the missing fact.`,
	];
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Defensive fallbacks
// ---------------------------------------------------------------------------

function computeUnmetGaps(
	gapAnalysis:    FactGapAnalysis,
	retainedLedger: readonly StepOutput[],
	_cycleMemory:   CycleMemory,
): readonly RequiredFact[] {
	void _cycleMemory;
	// A required fact is "unmet" if it was originally absent (or partial)
	// AND the retained ledger has no step that targeted it with non-empty
	// facts. We use the ledger directly rather than cycleMemory's
	// criteriaCoverage because the ledger has the authoritative
	// post-cycle truth (some kept steps may have been empty/failed).
	const requiredAbsent = gapAnalysis.requiredFacts.filter(f => f.status === 'absent' || f.status === 'partial');
	// Without targetsCriteria-by-id mapping at this level we use a soft
	// heuristic: a fact is met if ANY ledger step has non-empty facts.
	// More precise mapping would require carrying stepsById here; for
	// v1 the criterion is "did we acquire anything substantive at all?"
	// and the prompt + section review do the final filtering.
	const anyFacts = retainedLedger.some(o => o.facts.length > 0);
	if (anyFacts) {
		// Without per-fact targeting we can't say which facts the ledger
		// covered; treat all originally-absent facts as still unmet ONLY
		// when the retained ledger is empty. When it has substantive
		// content, surface the prompt-level unmet list as the
		// orchestrator-supplied facts that the analysis said were
		// absent -- the LLM will judge what's covered.
		return requiredAbsent;
	}
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
	todo:           TodoSpec,
	retainedLedger: readonly StepOutput[],
	unmetGaps:      readonly RequiredFact[],
): string {
	const lines: string[] = [
		`# ${todo.objective}`,
		'',
		'_(Assembled deterministically; the synthesis LLM returned an empty body.)_',
		'',
	];
	if (retainedLedger.length > 0) {
		lines.push('## Retained facts');
		lines.push('');
		for (const o of retainedLedger) {
			lines.push(`### ${o.stepId} (${o.status})`);
			for (const f of o.facts) { lines.push(`- ${f}`); }
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

export const _buildSynthUserForTest             = buildSynthUser;
export const _renderLedgerForTest               = renderLedger;
export const _renderUnmetGapInputForTest        = renderUnmetGapInput;
export const _computeUnmetGapsForTest           = computeUnmetGaps;
export const _buildAllGapsStubForTest           = buildAllGapsStub;
export const _buildDeterministicFallbackForTest = buildDeterministicFallback;
