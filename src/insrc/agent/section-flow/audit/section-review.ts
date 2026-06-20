/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Section review loop (originally section-flow Stage 7; now extracted as
 * a standalone audit library so it can also be invoked on external-agent
 * deliverables -- see `plans/external-agent-integration.md` Phase 0 and
 * Phase 6).
 *
 * Three-verdict structured output:
 *
 *   accept       -- ship the section as-is.
 *   revise-edits -- small fixes; LLM rewrites the whole section, we
 *                   re-review. Counts toward the per-section cap.
 *   revise-major -- structural failure (per-root findings are
 *                   insufficient or contradictory). ESCALATE to the
 *                   caller; in section-flow this triggers a TODO recycle.
 *                   Does NOT consume a cycle.
 *
 * Default cap is 3 revise-and-re-review cycles after the initial review.
 * Callers can override via `cycleCapOpt`. After cap, force-accept with
 * `exhausted: true`.
 *
 * Pure in terms of side effects: only LLM calls + module-level logging.
 * No working-memory mutation, ledger writes, DB access, or session reads.
 * Callers are responsible for ensuring the prompt registry is initialised
 * (via `registerAllPromptWriters()` or equivalent).
 *
 * Cost ceiling per section:
 *   - Typical: 1 review (accept)                            = 1 call
 *   - Revise-edits path (cap 1): 1 review + 1 revise + 1    = 3 calls
 *   - Worst case (cap 3): 1 + 3*(revise+review)             = 7 calls
 */

import type { LLMMessage, LLMProvider } from '../../../shared/types.js';
import type { WorkingMemoryFindings } from '../../working-memory/types.js';
import type { TodoSpec } from '../types.js';
import { getLogger } from '../../../shared/logger.js';
import { getPromptRegistry } from '../../prompts/registry.js';
import type {
	SectionReviewWriterInput,
	SectionReviseWriterInput,
} from '../../prompts/writers/section-review.js';

const log = getLogger('section-flow:section-review');

/** Default cap: up to 3 revise-and-re-review cycles after the initial review. */
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
	/** Candidate section markdown (assembly step's output, or external-agent deliverable). */
	readonly candidate:   string;
	readonly findings:    WorkingMemoryFindings;
	readonly provider:    LLMProvider;
	/** Optional per-call override of the default cycle cap (3). */
	readonly cycleCapOpt?: number | undefined;
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
	const cap = input.cycleCapOpt ?? SECTION_REVIEW_CYCLE_CAP;
	let current = input.candidate;
	let cyclesConsumed = 0;
	let review = await reviewOnce(input, current, cyclesConsumed, cap);

	while (review.verdict === 'revise-edits' && cyclesConsumed < cap) {
		const edits = review.edits ?? '(no specific edits provided)';
		log.info({ todoId: input.todo.id, cycle: cyclesConsumed + 1, edits: edits.slice(0, 120) }, 'section review: revise-edits, rewriting');
		current = await reviseSection(input, current, edits);
		cyclesConsumed += 1;
		review = await reviewOnce(input, current, cyclesConsumed, cap);
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

// plans/structured-output.md Phase C.7. JSON Schema for the wire-layer
// enforcement of the section-review verdict. App-level fallback
// (accept-on-invalid-shape) stays in `parseReview`.
const SECTION_REVIEW_SCHEMA: Record<string, unknown> = {
	type: 'object',
	required: ['verdict'],
	additionalProperties: false,
	properties: {
		verdict:   { type: 'string', enum: ['accept', 'revise-edits', 'revise-major'] },
		reasoning: { type: 'string', maxLength: 2000 },
		edits:     { type: 'string', maxLength: 4000 },
	},
};

async function reviewOnce(input: SectionReviewInput, candidate: string, cyclesConsumed: number, _cap: number): Promise<ReviewParsed> {
	const writer = getPromptRegistry().get<SectionReviewWriterInput, readonly LLMMessage[]>('section-review');
	const messages = [...writer.build({
		todo:           input.todo,
		findings:       input.findings,
		candidate,
		cyclesConsumed,
	})];
	let parsed: unknown;
	try {
		parsed = await input.provider.completeStructured<unknown>(messages, SECTION_REVIEW_SCHEMA, {
			maxTokens:       MAX_REVIEW_TOKENS,
			temperature:     0,
			disableThinking: true,
		});
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'section review: call failed; defaulting to accept');
		return { verdict: 'accept', reasoning: 'review call failure -> accept' };
	}
	return parseReview(parsed);
}

function buildReviewUser(input: SectionReviewInput, candidate: string, cyclesConsumed: number): string {
	const cap = input.cycleCapOpt ?? SECTION_REVIEW_CYCLE_CAP;
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
		`## CYCLES CONSUMED: ${cyclesConsumed} / ${cap}`,
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

function parseReview(parsed: unknown): ReviewParsed {
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
