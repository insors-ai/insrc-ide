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
	'and the working-memory bundle. You decide one of three verdicts.',
	'',
	'The per-root findings carry **cited summaries** (citation contract).',
	'Each finding\'s `content` block, when it follows the citation format,',
	'looks like:',
	'',
	'    summary-narrative-line',
	'      claims:',
	'        - <claim> [cited] <- "<verbatim span from raw output>"',
	'        - <claim> [confirmed-null] <- empty:<artifactId tail>',
	'      closures:',
	'        - CLOSES <gap-id> -- <closure-claim>',
	'',
	'The `[cited]` claims have been deterministically substring-verified',
	'against the source artifact. Treat them as ground truth. Claims',
	'appearing in the SECTION MARKDOWN but NOT supported by any `[cited]`',
	'line in the per-root findings are HALLUCINATIONS -- the synth made',
	'them up. Flag those.',
	'',
	'Verdicts:',
	'',
	'  accept       -- ship the section as-is. Every concrete claim in',
	'                  the markdown maps back to a cited finding. ALSO',
	'                  USE THIS when the answer is genuinely null AND',
	'                  the section documents that truthfully with',
	'                  citation (e.g. "directory contains zero JSON',
	'                  files; the scan ran cleanly, no truncation"). A',
	'                  confirmed-null answer is a REAL answer.',
	'  revise-edits -- presentation/coherence fixes (intro, transitions,',
	'                  conclusion, citation phrasing). You return an',
	'                  `edits` string describing what to change. The',
	'                  orchestrator runs ONE rewrite and re-reviews.',
	'                  Cap: 3 revise cycles.',
	'  revise-major -- the per-root findings themselves are insufficient',
	'                  or contradictory AND the failure is recoverable',
	'                  by re-investigation; OR the section markdown',
	'                  contains material claims with NO cited backing in',
	'                  the findings (synth hallucination). Section',
	'                  regeneration cannot fix the first case; the',
	'                  second case may merit revise-edits if the synth',
	'                  just over-paraphrased. Do NOT use revise-major',
	'                  when:',
	'                    - The findings show a clean null result and',
	'                      the markdown surfaces it with citation. That',
	'                      IS the answer.',
	'                    - Cited findings support most of the markdown',
	'                      but a couple of decorative sentences are',
	'                      under-cited -- prefer revise-edits.',
	'',
	'You emit a SINGLE JSON object. No prose, no markdown fences.',
].join('\n');

function buildReviewUser(input: SectionReviewWriterInput): string {
	// 1200 chars per finding lets the structured `claims:` + `closures:`
	// sub-blocks reach the reviewer in full when they exist. With the
	// citation contract the per-root content is denser and more
	// material; 400 chars (legacy plain-text era) was cutting the
	// closures block off.
	const findingsBlock = input.findings.perRoot.length === 0
		? '(no per-root findings)'
		: input.findings.perRoot.map(f => `- ${f.rootId} (verdict: ${f.verdict}${f.exhausted ? ', exhausted' : ''}):\n  ${f.content.slice(0, 1200)}`).join('\n');

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
