/**
 * Stage 3 of the cloud-plan / local-expand / cloud-review synthesis flow
 * (plans/analyzers/cloud-plan-local-expand-cloud-review.md, Phase 3).
 *
 * One LLM call to the CLOUD provider, returning a strict-JSON
 * verdict on the local expander's draft. The reviewer:
 *   - sees the action card (objective + reviewCriteria),
 *   - sees the local draft,
 *   - sees the same evidence the expander saw,
 *   - emits `{ verdict: 'accept' | 'refine', accepted?, refine?, notes }`.
 *
 * Plus the per-action loop driver `expandThenReview` that ties Phase
 * 2 + 3 together: expand -> review -> if refine then expand-with-hint
 * -> review -> binding accept on the second review regardless of
 * verdict.
 */

import type { LLMProvider, LLMMessage } from '../../shared/types.js';
import { getLogger } from '../../shared/logger.js';
import { REVIEW_ACTION_SCHEMA } from './schema.js';
import { expandAction, type ExpandActionResult } from './expand-action.js';
import type { PlanExecution, PlannedAction } from './plan-actions.js';

const log = getLogger('content-gen:review-action');

const DEFAULT_MAX_TOKENS = 800;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One failed tool call surfaced to the reviewer for CONTEXT only --
 * never scored as evidence. Lets the reviewer see "the writer tried
 * but the call was rejected (e.g. invalid input)" without conflating
 * the failure with the writer's reasoning.
 */
export interface FailedToolCall {
	readonly skillId:           string;
	readonly args:              unknown;
	readonly rejectionReason?:  string | undefined;
	readonly output:            string;
}

export interface ReviewActionInput {
	readonly action:        PlannedAction;
	readonly draft:         ExpandActionResult;
	/** Successful tool calls; the reviewer scores the draft against this. */
	readonly evidence:      readonly PlanExecution[];
	/** Failed tool calls (invalid input, feasibility-failed, execute-threw,
	 *  protocol-error). Surfaced to the reviewer as context only -- never
	 *  used as evidence. Optional. */
	readonly failedCalls?:  readonly FailedToolCall[] | undefined;
	readonly analyzerLabel?: string | undefined;
}

export interface ReviewActionResult {
	readonly verdict:   'accept' | 'refine';
	readonly accepted?: { readonly markdown: string };
	readonly refine?:   { readonly hint: string };
	readonly notes:     readonly string[];
	/** True when the reviewer's response was unparseable / schema-
	 *  violating after a single retry. The orchestrator treats this
	 *  as a soft accept (verdict='accept', accepted.markdown =
	 *  draft.markdown) so a flaky reviewer can't block the report. */
	readonly degraded:  boolean;
}

export interface ExpandThenReviewInput {
	readonly action:   PlannedAction;
	readonly evidence: readonly PlanExecution[];
	readonly request:  string;
	readonly analyzerLabel?: string | undefined;
	/** Optional progress hook fired between phases. The orchestrator
	 *  uses this to emit liveStep events to the chat panel. */
	readonly onProgress?: ExpandThenReviewProgress | undefined;
}

export type ExpandThenReviewPhase =
	| 'expand-1'
	| 'review-1'
	| 'expand-2'
	| 'review-2'
	| 'final';

export type ExpandThenReviewProgress = (phase: ExpandThenReviewPhase, payload: ExpandThenReviewPayload) => void;

export type ExpandThenReviewPayload =
	| { readonly kind: 'expand'; readonly result: ExpandActionResult }
	| { readonly kind: 'review'; readonly result: ReviewActionResult }
	| { readonly kind: 'final';  readonly verdict: 'accept' | 'refine-then-accept'; readonly rounds: 1 | 2; readonly markdown: string };

export interface ExpandThenReviewResult {
	readonly markdown: string;
	readonly rounds:   1 | 2;
	readonly verdict:  'accept' | 'refine-then-accept';
	readonly notes:    readonly string[];
}

// ---------------------------------------------------------------------------
// Public API: review only
// ---------------------------------------------------------------------------

/**
 * Run the review stage for one action. Never throws; failures degrade
 * to verdict='accept' so the report can still ship.
 */
export async function reviewAction(
	input: ReviewActionInput,
	cloudProvider: LLMProvider,
): Promise<ReviewActionResult> {
	const messages = buildReviewMessages(input);

	const first = await tryReview(messages, cloudProvider);
	if (first.kind === 'ok') return first.value;

	log.info(
		{ analyzer: input.analyzerLabel, actionId: input.action.id, reason: first.reason },
		'review-action: first attempt invalid; retrying with correction',
	);
	const retryMessages: LLMMessage[] = [
		...messages,
		{
			role: 'user',
			content: `Your previous response was rejected: ${first.reason}.\n\nReturn ONLY the JSON object that matches the ReviewActionResult schema. No fences, no prose, no preamble.`,
		},
	];
	const second = await tryReview(retryMessages, cloudProvider);
	if (second.kind === 'ok') return second.value;

	log.warn(
		{ analyzer: input.analyzerLabel, actionId: input.action.id, first: first.reason, second: second.reason },
		'review-action: both attempts invalid; soft-accepting draft',
	);
	return {
		verdict:  'accept',
		accepted: { markdown: input.draft.markdown },
		notes:    [`reviewer-degraded: ${second.reason}`],
		degraded: true,
	};
}

// ---------------------------------------------------------------------------
// Public API: expand-then-review loop
// ---------------------------------------------------------------------------

/**
 * @deprecated No production callers since the code-analyzer's
 * Phase F refactor (2026-05-11) moved to a tool-loop expander
 * (`writeSectionWithTools`) and inlined the 2-round driver in
 * `runPlanExpandReviewSynthesise`. The text-only `expandAction`
 * expander this function wraps is no longer used by any analyzer.
 *
 * Kept for now as regression coverage of the 2-round contract
 * (accept@1, refine→accept@2, refine→refine binding accept). If a
 * future caller needs a generic 2-round driver, refactor this
 * function to accept an expander callback instead of bundling
 * `expandAction` directly.
 *
 * One per-action expand+review loop. Two-round contract:
 *   1. Expand (local) -> review (cloud).
 *      - If verdict='accept', return.
 *   2. Else expand again with the reviewer's hint -> review again.
 *      - Either verdict is binding: accept the second draft.
 *
 * Never throws; all sub-stage failures degrade to a soft accept.
 */
export async function expandThenReview(
	input: ExpandThenReviewInput,
	localProvider: LLMProvider,
	cloudProvider: LLMProvider,
): Promise<ExpandThenReviewResult> {
	const onProgress = input.onProgress;

	// --- Round 1 ---------------------------------------------------------
	const draft1 = await expandAction(
		{
			action:   input.action,
			evidence: input.evidence,
			request:  input.request,
			...(input.analyzerLabel !== undefined ? { analyzerLabel: input.analyzerLabel } : {}),
		},
		localProvider,
	);
	onProgress?.('expand-1', { kind: 'expand', result: draft1 });

	const review1 = await reviewAction(
		{
			action:   input.action,
			draft:    draft1,
			evidence: input.evidence,
			...(input.analyzerLabel !== undefined ? { analyzerLabel: input.analyzerLabel } : {}),
		},
		cloudProvider,
	);
	onProgress?.('review-1', { kind: 'review', result: review1 });

	if (review1.verdict === 'accept') {
		const markdown = (review1.accepted?.markdown ?? draft1.markdown).trim();
		const result: ExpandThenReviewResult = {
			markdown,
			rounds:   1,
			verdict:  'accept',
			notes:    review1.notes,
		};
		onProgress?.('final', { kind: 'final', verdict: result.verdict, rounds: result.rounds, markdown: result.markdown });
		return result;
	}

	// --- Round 2 ---------------------------------------------------------
	const hint = review1.refine?.hint?.trim();
	if (hint === undefined || hint.length === 0) {
		// Reviewer said `refine` but didn't supply a hint -- treat as
		// accept of round-1 draft.
		log.warn(
			{ analyzer: input.analyzerLabel, actionId: input.action.id },
			'expand-then-review: reviewer returned refine without a hint; soft-accepting round 1',
		);
		const markdown = (review1.accepted?.markdown ?? draft1.markdown).trim();
		const result: ExpandThenReviewResult = {
			markdown,
			rounds:   1,
			verdict:  'accept',
			notes:    [...review1.notes, 'refine-without-hint; treated as accept'],
		};
		onProgress?.('final', { kind: 'final', verdict: result.verdict, rounds: result.rounds, markdown: result.markdown });
		return result;
	}

	const draft2 = await expandAction(
		{
			action:     input.action,
			evidence:   input.evidence,
			request:    input.request,
			refineHint: hint,
			...(input.analyzerLabel !== undefined ? { analyzerLabel: input.analyzerLabel } : {}),
		},
		localProvider,
	);
	onProgress?.('expand-2', { kind: 'expand', result: draft2 });

	const review2 = await reviewAction(
		{
			action:   input.action,
			draft:    draft2,
			evidence: input.evidence,
			...(input.analyzerLabel !== undefined ? { analyzerLabel: input.analyzerLabel } : {}),
		},
		cloudProvider,
	);
	onProgress?.('review-2', { kind: 'review', result: review2 });

	const markdown2 = (review2.accepted?.markdown ?? draft2.markdown).trim();
	const round2Notes = [...review1.notes, ...review2.notes];
	if (review2.verdict === 'refine') {
		round2Notes.push('second-review-still-refine; binding accept');
	}
	const final: ExpandThenReviewResult = {
		markdown: markdown2,
		rounds:   2,
		verdict:  'refine-then-accept',
		notes:    round2Notes,
	};
	onProgress?.('final', { kind: 'final', verdict: final.verdict, rounds: final.rounds, markdown: final.markdown });
	return final;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
	'You review ONE section of an analysis report.',
	'',
	'You will receive:',
	'  - The section\'s objective.',
	'  - The review criteria you must score against.',
	'  - The draft markdown the local expander produced.',
	'  - The same evidence the expander saw.',
	'',
	'Your job is a single binary verdict + (optionally) a focused fix.',
	'',
	'Verdict rules:',
	'  - `accept` -- the draft adequately satisfies the review criteria.',
	'    You MAY include a polished rewrite under `accepted.markdown`',
	'    if surgical edits are clearly worth it; otherwise omit it and',
	'    the orchestrator uses the local draft as-is. Do NOT rewrite',
	'    just for style.',
	'  - `refine` -- the draft has a SPECIFIC concrete gap that a',
	'    second pass should fix. Provide ONE actionable sentence in',
	'    `refine.hint`. Do NOT list multiple issues -- pick the most',
	'    important one. The local expander gets one more attempt with',
	'    your hint as a focused-fix instruction.',
	'',
	'Hard rules:',
	'  1. Output strict JSON ONLY -- no markdown fences, no prose, no preamble.',
	'  2. The schema is fixed: `{ verdict, accepted?, refine?, notes? }`.',
	'  3. `accept` MUST NOT include a `refine` field. `refine` MUST',
	'     include a `hint` and SHOULD NOT include `accepted`.',
	'  4. Keep `notes` short -- 1-3 entries describing what was good',
	'     or which criterion drove the verdict.',
	'  5. PRESERVE CLICKABLE CITATIONS. The expander emits',
	'     `[label](path:<file>(#L<startLine>(-L<endLine>)?)?)` Markdown',
	'     links so the IDE can navigate to the source. When polishing',
	'     under `accepted.markdown` you MUST preserve these links',
	'     verbatim -- do NOT strip them, convert them to bare backticks,',
	'     or invent new ones the evidence does not support. If the',
	'     draft is missing links for entities the evidence carries a',
	'     file for, emit `refine` with a hint to add them.',
].join('\n');

function buildReviewMessages(input: ReviewActionInput): LLMMessage[] {
	const userLines: string[] = [];

	userLines.push('## Section under review');
	userLines.push(`title:     ${input.action.title}`);
	userLines.push(`objective: ${input.action.objective}`);
	userLines.push('');

	userLines.push('## Review criteria');
	for (const c of input.action.reviewCriteria) {
		userLines.push(`- ${c}`);
	}
	userLines.push('');

	userLines.push('## Draft markdown');
	userLines.push('```markdown');
	userLines.push(input.draft.markdown);
	userLines.push('```');
	if (input.draft.truncated) {
		userLines.push('');
		userLines.push('_Note: the local expander hit its token cap. Verify whether truncation actually hurt the section before requesting a refine._');
	}
	if (input.draft.degraded) {
		userLines.push('');
		userLines.push('_Note: the local expander degraded (provider error / empty response). The draft may be a stub; refining is appropriate if so._');
	}
	userLines.push('');

	userLines.push(`## Evidence the expander saw (${input.evidence.length})`);
	if (input.evidence.length === 0) {
		userLines.push('(none)');
	} else {
		for (let i = 0; i < input.evidence.length; i++) {
			const e = input.evidence[i]!;
			userLines.push(`### [${i}] ${e.skillId} (confidence: ${e.confidence})`);
			userLines.push(formatEvidenceValue(e.value));
			userLines.push('');
		}
	}

	// Fix 11.8: failed tool calls go in a separate block so the
	// reviewer treats them as CONTEXT (the writer tried but the call
	// errored) rather than EVIDENCE (which would taint scoring).
	const failedCalls = input.failedCalls ?? [];
	if (failedCalls.length > 0) {
		userLines.push('');
		userLines.push(`## Failed tool calls (CONTEXT ONLY -- do not score against these)`);
		userLines.push('These calls did not produce useful output. Do not refine just because they failed -- score the draft against the successful Evidence above.');
		userLines.push('');
		for (let i = 0; i < failedCalls.length; i++) {
			const f = failedCalls[i]!;
			const reason = f.rejectionReason ?? 'errored';
			userLines.push(`### [${i}] ${f.skillId} (${reason})`);
			userLines.push('args: ' + formatEvidenceValue(f.args));
			userLines.push('');
		}
	}

	userLines.push('## Output');
	userLines.push('Strict JSON: `{ verdict, accepted?, refine?, notes }`. No fences, no prose.');

	return [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user',   content: userLines.join('\n') },
	];
}

const EVIDENCE_PREVIEW_MAX = 1500;

function formatEvidenceValue(value: unknown): string {
	if (value === null || value === undefined) return '(no value)';
	let s: string;
	try {
		s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
	} catch {
		s = String(value);
	}
	if (s.length <= EVIDENCE_PREVIEW_MAX) return s;
	return s.slice(0, EVIDENCE_PREVIEW_MAX) + ' ...<truncated>';
}

// ---------------------------------------------------------------------------
// One review attempt
// ---------------------------------------------------------------------------

type ReviewAttempt =
	| { kind: 'ok';    value: ReviewActionResult }
	| { kind: 'error'; reason: string };

async function tryReview(
	messages: LLMMessage[],
	provider: LLMProvider,
): Promise<ReviewAttempt> {
	let rawText: string;
	try {
		const response = await provider.complete(messages, {
			maxTokens:   DEFAULT_MAX_TOKENS,
			temperature: 0,
			responseFormat: { schema: REVIEW_ACTION_SCHEMA as unknown as Record<string, unknown> },
		});
		rawText = response.text;
	} catch (err) {
		return { kind: 'error', reason: `provider error: ${(err as Error).message}` };
	}

	const cleaned = stripFences(rawText.trim());
	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned);
	} catch (err) {
		return {
			kind: 'error',
			reason: `unparseable JSON (${(err as Error).message}); raw=${rawText.slice(0, 120)}`,
		};
	}

	const validated = validateReview(parsed);
	if (typeof validated === 'string') {
		return { kind: 'error', reason: `schema violation: ${validated}` };
	}
	return { kind: 'ok', value: validated };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateReview(parsed: unknown): ReviewActionResult | string {
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return 'response is not a JSON object';
	}
	const obj = parsed as Record<string, unknown>;

	const verdictRaw = obj['verdict'];
	if (verdictRaw !== 'accept' && verdictRaw !== 'refine') {
		return '`verdict` must be "accept" or "refine"';
	}

	const notes: string[] = [];
	if (Array.isArray(obj['notes'])) {
		for (const n of obj['notes'] as unknown[]) {
			if (typeof n === 'string' && n.trim().length > 0) {
				notes.push(n.trim());
			}
		}
	}

	if (verdictRaw === 'accept') {
		const result: { -readonly [K in keyof ReviewActionResult]: ReviewActionResult[K] } = {
			verdict:  'accept',
			notes,
			degraded: false,
		};
		const acceptedRaw = obj['accepted'];
		if (acceptedRaw !== undefined && typeof acceptedRaw === 'object' && acceptedRaw !== null) {
			const a = acceptedRaw as Record<string, unknown>;
			if (typeof a['markdown'] === 'string' && a['markdown'].trim().length > 0) {
				result.accepted = { markdown: (a['markdown'] as string).trim() };
			}
		}
		return result;
	}

	// verdict === 'refine'
	const refineRaw = obj['refine'];
	if (refineRaw === undefined || typeof refineRaw !== 'object' || refineRaw === null) {
		return '`refine` block missing for verdict="refine"';
	}
	const r = refineRaw as Record<string, unknown>;
	const hint = typeof r['hint'] === 'string' ? r['hint'].trim() : '';
	if (hint.length === 0) {
		return '`refine.hint` must be a non-empty string';
	}
	return {
		verdict:  'refine',
		refine:   { hint },
		notes,
		degraded: false,
	};
}

function stripFences(text: string): string {
	let out = text;
	if (out.startsWith('```')) {
		out = out.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
	}
	return out.trim();
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _validateReviewForTest      = validateReview;
export const _buildReviewMessagesForTest = buildReviewMessages;
export const _stripFencesForTest         = stripFences;
