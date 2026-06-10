/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Section review loop (planner-section-task-separation P3.c part 2,
 * Q5).
 *
 * Three-verdict structured output (distinct from the per-root review
 * in P3.b; this layer reviews the ASSEMBLED section for
 * presentation/coherence, while per-root review covered
 * investigation completeness):
 *
 *   accept       -- ship the section as-is.
 *   revise-edits -- small fixes; LLM rewrites the whole section, we
 *                   re-review. Counts toward the per-section cap.
 *   revise-major -- structural failure (per-root findings are
 *                   insufficient or contradictory). ESCALATE to the
 *                   TODO orchestrator (P3.d) which re-opens the
 *                   section task tree. Does NOT consume a cycle.
 *
 * Cap is 3 revise-and-re-review cycles after the initial review
 * (Q5's "cap 3"). After cap, force-accept with `exhausted: true`;
 * orchestrator surfaces a `section-review-exhausted` annotation so
 * the final report review (Q7) can flag under-evidenced sections.
 *
 * Cost ceiling per section:
 *   - Typical: 1 review (accept)                            = 1 call
 *   - Revise-edits path (cap 1): 1 review + 1 revise + 1    = 3 calls
 *   - Worst case (cap 3): 1 + 3*(revise+review)             = 7 calls
 */

import type { LLMMessage, LLMProvider } from '../../shared/types.js';
import type { CloudMemoryView } from '../working-memory/index.js';
import type { WorkingMemoryFindings } from '../working-memory/types.js';
import type { TodoSpec } from './types.js';
import { getLogger } from '../../shared/logger.js';
import { getPromptRegistry } from '../prompts/registry.js';
import type {
	SectionReviewWriterInput,
	SectionReviseWriterInput,
} from '../prompts/writers/section-review.js';

const log = getLogger('section-flow:section-review');

/** Q5 cap: up to 3 revise-and-re-review cycles after the initial review. */
const SECTION_REVIEW_CYCLE_CAP = 3;

const MAX_REVIEW_TOKENS  = 1024;
/**
 * Worst-case section markdown the revise step can produce. Section
 * markdown is typically short (a few paragraphs + lists); 6k tokens
 * (~18k chars) gives plenty of headroom without inviting over-long
 * rewrites that don't add value.
 */
const MAX_REVISE_TOKENS  = 6144;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SectionReviewInput {
	readonly todo:        TodoSpec;
	readonly memory:      CloudMemoryView;
	/** Candidate section markdown (assembly step's output). */
	readonly candidate:   string;
	readonly findings:    WorkingMemoryFindings;
	readonly provider:    LLMProvider;
}

export interface SectionReviewResult {
	readonly finalMarkdown:   string;
	readonly cyclesConsumed:  number;
	readonly exhausted:       boolean;
	readonly reopenRequested: boolean;
	readonly reopenReason?:   string | undefined;
	/** Final review verdict the model emitted (or 'force-accept' on cap hit). */
	readonly finalVerdict:    'accept' | 'force-accept' | 'revise-major';
}

export async function reviewSection(input: SectionReviewInput): Promise<SectionReviewResult> {
	let current = input.candidate;
	let cyclesConsumed = 0;
	let review = await reviewOnce(input, current, cyclesConsumed);

	while (review.verdict === 'revise-edits' && cyclesConsumed < SECTION_REVIEW_CYCLE_CAP) {
		const edits = review.edits ?? '(no specific edits provided)';
		log.info({ todoId: input.todo.id, cycle: cyclesConsumed + 1, edits: edits.slice(0, 120) }, 'section review: revise-edits, rewriting');
		current = await reviseSection(input, current, edits);
		cyclesConsumed += 1;
		review = await reviewOnce(input, current, cyclesConsumed);
	}

	if (review.verdict === 'revise-major') {
		const reason = review.reasoning ?? 'revise-major requested by section review';
		log.warn({ todoId: input.todo.id, cyclesConsumed, reason }, 'section review: revise-major escalation');
		return {
			finalMarkdown:   current,
			cyclesConsumed,
			exhausted:       false,
			reopenRequested: true,
			reopenReason:    reason,
			finalVerdict:    'revise-major',
		};
	}

	const exhausted = review.verdict === 'revise-edits';
	const verdict: SectionReviewResult['finalVerdict'] = exhausted ? 'force-accept' : 'accept';
	log.info({ todoId: input.todo.id, cyclesConsumed, exhausted, verdict }, 'section review complete');

	return {
		finalMarkdown:   current,
		cyclesConsumed,
		exhausted,
		reopenRequested: false,
		finalVerdict:    verdict,
	};
}

// ---------------------------------------------------------------------------
// Review LLM call
// ---------------------------------------------------------------------------

interface ReviewParsed {
	readonly verdict:    'accept' | 'revise-edits' | 'revise-major';
	readonly reasoning?: string | undefined;
	/** Free-form natural-language edits when verdict === 'revise-edits'. */
	readonly edits?:     string | undefined;
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

async function reviewOnce(input: SectionReviewInput, candidate: string, cyclesConsumed: number): Promise<ReviewParsed> {
	const writer = getPromptRegistry().get<SectionReviewWriterInput, readonly LLMMessage[]>('section-review');
	const messages = [...writer.build({
		todo:           input.todo,
		findings:       input.findings,
		candidate,
		cyclesConsumed,
	})];
	const response = await input.provider.complete(messages, {
		maxTokens:       MAX_REVIEW_TOKENS,
		temperature:     0,
		responseFormat:  'json',
		disableThinking: true,
	});
	return parseReview(response.text);
}

function buildReviewUser(input: SectionReviewInput, candidate: string, cyclesConsumed: number): string {
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
		`## CYCLES CONSUMED: ${cyclesConsumed} / ${SECTION_REVIEW_CYCLE_CAP}`,
		'',
		'## CANDIDATE SECTION MARKDOWN',
		candidate,
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

function parseReview(raw: string): ReviewParsed {
	let text = raw.trim();
	if (text.startsWith('```')) {
		text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		log.warn({ preview: raw.slice(0, 200) }, 'section review: JSON parse failed; defaulting to accept');
		return { verdict: 'accept', reasoning: 'review parse failure -> accept' };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { verdict: 'accept', reasoning: 'review shape invalid -> accept' };
	}
	const obj = parsed as Record<string, unknown>;
	const verdictRaw = obj['verdict'];
	const verdict: ReviewParsed['verdict'] =
		verdictRaw === 'revise-edits' || verdictRaw === 'revise-major' ? verdictRaw : 'accept';
	const reasoning = typeof obj['reasoning'] === 'string' ? obj['reasoning'] : undefined;
	const edits     = typeof obj['edits']     === 'string' ? obj['edits']     : undefined;
	return {
		verdict,
		...(reasoning !== undefined ? { reasoning } : {}),
		...(edits     !== undefined ? { edits }     : {}),
	};
}

// ---------------------------------------------------------------------------
// Revise LLM call
// ---------------------------------------------------------------------------

const REVISE_ROLE = [
	'You are the SECTION REVISER. You receive the current section',
	'markdown plus a natural-language `edits` description from the',
	'section reviewer. You emit the FULL revised section markdown --',
	'no JSON envelope, no preamble, no commentary. Preserve the',
	'parts the edits do not call out.',
].join('\n');

async function reviseSection(input: SectionReviewInput, current: string, edits: string): Promise<string> {
	const writer = getPromptRegistry().get<SectionReviseWriterInput, readonly LLMMessage[]>('section-revise');
	const messages = [...writer.build({
		todo:    input.todo,
		current,
		edits,
	})];
	const response = await input.provider.complete(messages, {
		maxTokens:       MAX_REVISE_TOKENS,
		temperature:     0,
		disableThinking: true,
		// NOT responseFormat: 'json' -- the output is markdown, not JSON.
	});
	const text = response.text.trim();
	if (text.length === 0) {
		log.warn({ todoId: input.todo.id }, 'section revise: empty response; keeping current');
		return current;
	}
	return text;
}

function buildReviseUser(todo: TodoSpec, current: string, edits: string): string {
	return [
		'## TODO OBJECTIVE',
		todo.objective,
		'',
		'## CURRENT SECTION',
		current,
		'',
		'## REVIEWER EDITS',
		edits,
		'',
		'## TASK',
		'Emit the full revised section markdown now. No JSON envelope, no',
		'preamble, no commentary -- just the markdown.',
	].join('\n');
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _parseReviewForTest         = parseReview;
export const _buildReviewUserForTest     = buildReviewUser;
export const _buildReviseUserForTest     = buildReviseUser;
export const SECTION_REVIEW_CYCLE_CAP_VALUE = SECTION_REVIEW_CYCLE_CAP;
