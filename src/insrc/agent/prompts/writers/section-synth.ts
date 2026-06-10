/**
 * section-synth writer v1 -- Stage 6 of the section-flow per-TODO loop.
 * Cloud LLM synthesises the section markdown from the retained ledger
 * + the unmet-gap list.
 *
 * Migrated from `agent/section-flow/step-synthesis-from-ledger.ts`'s
 * inline SYNTH_ROLE + buildSynthUser as part of Phase 0 of
 * `plans/section-flow-architecture-redesign.md`. Behaviour-preserving.
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
	readonly todo:           TodoSpec;
	readonly retainedLedger: readonly StepOutput[];
	readonly cycleMemory:    CycleMemory;
	readonly unmetGaps:      readonly RequiredFact[];
}

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
		'## RETAINED LEDGER',
		renderLedger(input.retainedLedger),
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

export const sectionSynthWriterV1: PromptWriter<SectionSynthWriterInput, readonly LLMMessage[]> = {
	id:      'section-synth',
	version: 1,
	tier:    'cloud',
	summary: 'Stage 6: synthesise the section markdown from the retained ledger + unmet-gap list.',

	build(input: SectionSynthWriterInput): readonly LLMMessage[] {
		return [
			{ role: 'system', content: SYNTH_ROLE },
			{ role: 'user',   content: buildSynthUser(input) },
		];
	},
};
