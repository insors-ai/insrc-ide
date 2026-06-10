/**
 * section-review + section-revise writers v1 -- Stage 7 of the
 * section-flow per-TODO loop.
 *
 * Two writers because they're independent prompts that the
 * step-section-review orchestrator runs at different points:
 *   - section-review (cloud): judges the section markdown,
 *     emits { verdict, reasoning, edits? }.
 *   - section-revise (cloud): rewrites the section markdown
 *     applying the reviewer's edits.
 *
 * Migrated from `agent/section-flow/step-section-review.ts`'s inline
 * REVIEW_ROLE + REVISE_ROLE + their build functions. Behaviour-
 * preserving.
 */

import type { LLMMessage } from '../../../shared/types.js';
import type { TodoSpec } from '../../section-flow/types.js';
import type { WorkingMemoryFindings } from '../../working-memory/types.js';
import type { PromptWriter } from '../types.js';

const SECTION_REVIEW_CYCLE_CAP = 3;

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export interface SectionReviewWriterInput {
	readonly todo:            TodoSpec;
	readonly findings:        WorkingMemoryFindings;
	readonly candidate:       string;
	readonly cyclesConsumed:  number;
}

const REVIEW_ROLE = [
	'You are the SECTION REVIEWER. You read the assembled section markdown,',
	'the TODO objective, the per-root findings the section was built from,',
	'and the working-memory bundle. You decide one of three verdicts:',
	'',
	'  accept       -- ship the section as-is. The markdown reads well,',
	'                  covers the TODO objective, and cites findings',
	'                  correctly.',
	'  revise-edits -- presentation/coherence fixes (intro, transitions,',
	'                  conclusion, finding citations). You return an',
	'                  `edits` string describing what to change. The',
	'                  orchestrator runs ONE rewrite and re-reviews.',
	'                  Counts toward the per-section cap (3 revise',
	'                  cycles max).',
	'  revise-major -- the per-root findings themselves are insufficient',
	'                  or contradictory. Section regeneration cannot fix',
	'                  this. ESCALATES to the TODO orchestrator which',
	'                  re-opens the section task tree. Use sparingly.',
	'',
	'You emit a SINGLE JSON object. No prose, no markdown fences.',
].join('\n');

function buildReviewUser(input: SectionReviewWriterInput): string {
	const findingsBlock = input.findings.perRoot.length === 0
		? '(no per-root findings)'
		: input.findings.perRoot.map(f => `- ${f.rootId} (verdict: ${f.verdict}${f.exhausted ? ', exhausted' : ''}):\n  ${f.content.slice(0, 400)}`).join('\n');

	return [
		'## TODO OBJECTIVE',
		input.todo.objective,
		'',
		'## PER-ROOT FINDINGS',
		findingsBlock,
		'',
		`## CYCLES CONSUMED: ${input.cyclesConsumed} / ${SECTION_REVIEW_CYCLE_CAP}`,
		'',
		'## CANDIDATE SECTION MARKDOWN',
		input.candidate,
		'',
		'## OUTPUT SHAPE (emit EXACTLY this object)',
		'',
		'{',
		'  "verdict":   "accept" | "revise-edits" | "revise-major",',
		'  "reasoning": "<one sentence>",',
		'  "edits":     "<natural-language description, REQUIRED when verdict is revise-edits>"',
		'}',
		'',
		'## TASK',
		'Emit the JSON verdict now. Begin with "{" and end with "}".',
	].join('\n');
}

export const sectionReviewWriterV1: PromptWriter<SectionReviewWriterInput, readonly LLMMessage[]> = {
	id:      'section-review',
	version: 1,
	tier:    'cloud',
	summary: 'Stage 7: judge the candidate section markdown (accept / revise-edits / revise-major).',

	build(input: SectionReviewWriterInput): readonly LLMMessage[] {
		return [
			{ role: 'system', content: REVIEW_ROLE },
			{ role: 'user',   content: buildReviewUser(input) },
		];
	},
};

// ---------------------------------------------------------------------------
// Revise
// ---------------------------------------------------------------------------

export interface SectionReviseWriterInput {
	readonly todo:    TodoSpec;
	readonly current: string;
	readonly edits:   string;
}

const REVISE_ROLE = [
	'You are the SECTION REVISER. You receive the current section',
	'markdown plus a natural-language `edits` description from the',
	'section reviewer. You emit the FULL revised section markdown --',
	'no JSON envelope, no preamble, no commentary. Preserve the',
	'parts the edits do not call out.',
].join('\n');

function buildReviseUser(input: SectionReviseWriterInput): string {
	return [
		'## TODO OBJECTIVE',
		input.todo.objective,
		'',
		'## CURRENT SECTION',
		input.current,
		'',
		'## REVIEWER EDITS',
		input.edits,
		'',
		'## TASK',
		'Emit the full revised section markdown now. No JSON envelope, no',
		'preamble, no commentary -- just the markdown.',
	].join('\n');
}

export const sectionReviseWriterV1: PromptWriter<SectionReviseWriterInput, readonly LLMMessage[]> = {
	id:      'section-revise',
	version: 1,
	tier:    'cloud',
	summary: 'Stage 7: rewrite the section markdown applying the reviewer\'s edits.',

	build(input: SectionReviseWriterInput): readonly LLMMessage[] {
		return [
			{ role: 'system', content: REVISE_ROLE },
			{ role: 'user',   content: buildReviseUser(input) },
		];
	},
};
