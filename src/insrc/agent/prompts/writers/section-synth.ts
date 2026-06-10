/**
 * section-synth writer v2 -- Stage 6 of the section-flow per-TODO loop.
 *
 * Phase 0 migration v1 rendered `StepOutput.facts` + `.citations`
 * (sourced from the now-deleted `summarizeResult` cloud call). Phase
 * 1 batch 3b of plans/section-flow-architecture-redesign.md drops
 * v1 and renders the reviewer-emitted per-step summaries instead --
 * the synthesizer sees claim-shaped text with closure markers
 * (`CLOSES <gap-id> fully`, `PARTIALLY supports <gap-id>`, etc.)
 * rather than a pre-summarised fact list.
 *
 * The caller (step-synthesis-from-ledger.ts) pre-resolves the
 * per-step summary text once via `resolveStepSummaries` and passes
 * a `summariesByStep` map. This module just renders.
 */

import type { LLMMessage } from '../../../shared/types.js';
import type {
	CycleMemory,
	StepOutput,
} from '../../content-gen/discovery-plan.js';
import type { RequiredFact } from '../../section-flow/fact-gap-types.js';
import type { TodoSpec } from '../../section-flow/types.js';
import type { PromptWriter } from '../types.js';

export interface SectionSynthWriterInput {
	readonly todo:            TodoSpec;
	readonly retainedLedger:  readonly StepOutput[];
	/** Pre-resolved per-step summaries (from `artifact_vec.summary` + raw fallback). */
	readonly summariesByStep: ReadonlyMap<string, string>;
	readonly cycleMemory:     CycleMemory;
	readonly unmetGaps:       readonly RequiredFact[];
}

const SYNTH_ROLE = [
	'You are the SECTION SYNTHESIZER. You receive a TODO objective + a',
	'retained ledger of per-step CLAIM-SHAPED summaries (each ending in',
	'a closure marker: `CLOSES <gap-id> fully` / `PARTIALLY supports',
	'<gap-id>` / `OFF-TOPIC`) + a list of unmet gaps the loop could not',
	'close. You emit the section markdown.',
	'',
	'Rules:',
	'  1. Use ONLY claims present in the RETAINED LEDGER summaries. Do',
	'     NOT invent field names, types, classes, file paths, line',
	'     numbers, or examples not present.',
	'  2. For each UNMET GAP, emit a structured handoff block with the',
	'     fact name, why it was needed, what was attempted (with cycle +',
	'     stepId + outcome), and a concrete next-step suggestion. Use',
	'     the exact format shown in UNMET GAPS below.',
	'  3. The closure markers are advisory -- a summary marked `CLOSES',
	'     <gap-id> fully` is the strongest signal that gap is covered;',
	'     `PARTIALLY supports` means some evidence; `OFF-TOPIC` means',
	'     the call returned nothing useful for the active gap list.',
	'  4. Structure: short intro paragraph naming the objective + what',
	'     was acquired vs. what remains unresolved; the main section',
	'     content drawn from the summaries; the unmet-gap handoff blocks',
	'     at the bottom (or inline where they break a sub-section).',
	'',
	'Emit the FULL section markdown. No JSON envelope, no preamble,',
	'no "Here is the section" commentary.',
].join('\n');

function renderLedger(
	ledger:          readonly StepOutput[],
	summariesByStep: ReadonlyMap<string, string>,
): string {
	if (ledger.length === 0) { return '(empty)'; }
	const lines: string[] = [];
	for (const o of ledger) {
		lines.push(`### ${o.stepId} (status: ${o.status})`);
		const summary = summariesByStep.get(o.stepId);
		if (summary === undefined || summary.trim().length === 0) {
			lines.push('  (no summary available)');
		} else {
			for (const ln of summary.split('\n')) {
				lines.push(`  ${ln}`);
			}
		}
		lines.push('');
	}
	return lines.join('\n').trimEnd();
}

function renderUnmetGapInput(gap: RequiredFact, cycleMemory: CycleMemory): string {
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

function buildSynthUser(input: SectionSynthWriterInput): string {
	const lines: string[] = [
		'## TODO OBJECTIVE',
		input.todo.objective,
		'',
		'## RETAINED LEDGER (per-step goal-aware summaries)',
		renderLedger(input.retainedLedger, input.summariesByStep),
		'',
	];
	if (input.unmetGaps.length > 0) {
		lines.push('## UNMET GAPS (render each as a structured handoff block)');
		lines.push('');
		for (const gap of input.unmetGaps) {
			lines.push(renderUnmetGapInput(gap, input.cycleMemory));
			lines.push('');
		}
	}
	lines.push('## TASK');
	lines.push('Emit the full section markdown now. No JSON envelope, no preamble.');
	return lines.join('\n');
}

export const sectionSynthWriterV2: PromptWriter<SectionSynthWriterInput, readonly LLMMessage[]> = {
	id:      'section-synth',
	version: 2,
	tier:    'cloud',
	summary: 'Stage 6: synthesise the section markdown from reviewer-emitted per-step summaries + unmet-gap list.',

	build(input: SectionSynthWriterInput): readonly LLMMessage[] {
		return [
			{ role: 'system', content: SYNTH_ROLE },
			{ role: 'user',   content: buildSynthUser(input) },
		];
	},
};

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _renderLedgerForTest        = renderLedger;
export const _renderUnmetGapInputForTest = renderUnmetGapInput;
export const _buildSynthUserForTest      = buildSynthUser;
