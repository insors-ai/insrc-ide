/**
 * Stage 3 of the cloud-plan / local-expand / cloud-review synthesis flow
 * (plans/analyzers/cloud-plan-local-expand-cloud-review.md, Phase 3).
 *
 * One LLM call to the CLOUD provider, returning a strict-JSON
 * verdict on the local expander's draft. The reviewer:
 *   - sees the action card (objective + reviewCriteria),
 *   - sees the local draft,
 *   - sees the same evidence the expander saw,
 *   - emits `{ verdict: 'accept' | 'needs-work', workItems[], accepted?, notes }`
 *     (Phase E of plans/code-analyzer-structured-review.md).
 *
 * Plus the per-action loop driver `expandThenReview` -- a text-only
 * 2-round contract used by the DATA-analyzer (orchestrator path
 * `runFollowupExpandReviewSynthesise`). The code-analyzer no longer
 * uses this driver -- it runs the 3-round patch loop directly via
 * patchSectionWithTools (Phase F.5 / G of the structured-review plan).
 * Migrating the data-analyzer to the same patch loop is out of scope
 * for that plan.
 */

import type { LLMProvider, LLMMessage } from '../../shared/types.js';
import { getLogger } from '../../shared/logger.js';
import { REVIEW_ACTION_SCHEMA } from './schema.js';
import { expandAction, type ExpandActionResult } from './expand-action.js';
import type { PlanExecution, PlannedAction } from './plan-actions.js';

// Phase P.4: cap total reviewer attempts (initial + 2 retries).
// insors-extraction's instructor.from_anthropic ANTHROPIC_JSON mode
// defaults to 3 attempts on validation failures; we mirror that.
const MAX_REVIEW_ATTEMPTS = 3;

const log = getLogger('content-gen:review-action');

// Phase K.2: the new structured-review schema (Phase E) emits up to
// 6 work items, each carrying id/kind/where/issue/action fields.
// Six items * ~450 chars formatted as JSON easily exceeds the old
// 800-token cap, which made the reviewer hit max_tokens mid-string
// on every section of the 2026-05-16 retest. Raised to 2500 to
// comfortably hold 6 items plus an optional accepted.markdown
// polish.
const DEFAULT_MAX_TOKENS = 2500;

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
	/**
	 * Phase N.2: prior rounds' verdicts surfaced to the reviewer so it
	 * can judge whether the new draft addressed what was previously
	 * flagged. Run #2 showed reviewers drifting between rounds because
	 * each pass was completely fresh. Each entry is one round's work-
	 * item list + verdict, in order.
	 */
	readonly priorReviews?: readonly {
		readonly round:     1 | 2;
		readonly verdict:   'accept' | 'needs-work';
		readonly workItems: readonly ReviewWorkItem[];
	}[] | undefined;
}

/**
 * Phase E of plans/code-analyzer-structured-review.md.
 *
 * Kind semantics:
 *   - `fix`     -- factually wrong claim. The patch loop must address
 *                  these; unaddressed `fix` items drop section
 *                  confidence to `low`.
 *   - `enhance` -- correct but thin (missing citations, vague).
 *   - `add`     -- required coverage missing.
 *   - `trim`    -- redundant / off-topic; cut in place.
 */
export type WorkItemKind = 'fix' | 'enhance' | 'add' | 'trim';

/**
 * One concrete editorial change the reviewer wants applied to the
 * draft. Each item is atomic (one location, one issue, one action) --
 * the patch loop (Phase F) iterates over the list and emits a
 * `patch:<id>` or `skip:<id>` block per item.
 */
export interface ReviewWorkItem {
	readonly id:     string;     // unique within the workItems list
	readonly kind:   WorkItemKind;
	readonly where:  string;     // "paragraph 3" | "section opening" | "after paragraph 5"
	readonly issue:  string;     // one-sentence problem statement
	readonly action: string;     // one-sentence concrete fix
	/** Optional references back into the evidence block ("evidence[2]"). */
	readonly evidenceRefs?: readonly string[];
}

export interface ReviewActionResult {
	readonly verdict:   'accept' | 'needs-work';
	/** Work items the patch loop should iterate. Empty when verdict=accept. */
	readonly workItems: readonly ReviewWorkItem[];
	readonly accepted?: { readonly markdown: string };
	readonly notes:     readonly string[];
	/** True when the reviewer's response was unparseable / schema-
	 *  violating after a single retry. The orchestrator treats this
	 *  as a soft accept (verdict='accept', workItems=[], accepted.markdown =
	 *  draft.markdown) so a flaky reviewer can't block the report. */
	readonly degraded:  boolean;
}

// ---------------------------------------------------------------------------
// Public API: review only
// ---------------------------------------------------------------------------

/**
 * Run the review stage for one action. Never throws; failures degrade
 * to verdict='accept' so the report can still ship.
 *
 * Phase P.4: 3-attempt loop with corrective retries. Each retry quotes
 * back the rejected JSON and names the specific violating value (when
 * the validator surfaces one), then suggests a corrective mapping for
 * known constraints (kind enum especially). Matches the
 * insors-extraction `instructor` pattern.
 */
export async function reviewAction(
	input: ReviewActionInput,
	cloudProvider: LLMProvider,
): Promise<ReviewActionResult> {
	const messages = [...buildReviewMessages(input)];

	let lastReason: string | undefined;
	let lastRaw:    string | undefined;
	for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt++) {
		const result = await tryReview(messages, cloudProvider);
		if (result.kind === 'ok') {
			if (attempt > 1) {
				log.info(
					{ analyzer: input.analyzerLabel, actionId: input.action.id, recoveredOnAttempt: attempt },
					'review-action: recovered on retry',
				);
			}
			return result.value;
		}
		lastReason = result.reason;
		lastRaw    = result.raw;
		if (attempt === MAX_REVIEW_ATTEMPTS) break;

		log.info(
			{ analyzer: input.analyzerLabel, actionId: input.action.id, attempt, reason: lastReason },
			'review-action: attempt invalid; retrying with corrective prompt',
		);
		messages.push({
			role: 'user',
			content: buildCorrectiveRetryMessage(lastReason, lastRaw),
		});
	}

	log.warn(
		{ analyzer: input.analyzerLabel, actionId: input.action.id, attempts: MAX_REVIEW_ATTEMPTS, lastReason },
		'review-action: all attempts invalid; soft-accepting draft',
	);
	return {
		verdict:   'accept',
		workItems: [],
		accepted:  { markdown: input.draft.markdown },
		notes:     [`reviewer-degraded after ${MAX_REVIEW_ATTEMPTS} attempts: ${lastReason ?? 'unknown'}`],
		degraded:  true,
	};
}

/**
 * Phase P.4: build the corrective retry user message. Pattern lifted
 * from insors-extraction's instructor.Mode.ANTHROPIC_JSON behavior --
 * include the actual rejected output AND the specific violating value
 * so the model has a concrete correction target, not a generic
 * "your response was rejected" hand-wave.
 */
function buildCorrectiveRetryMessage(reason: string, raw: string | undefined): string {
	const suggestion = correctiveSuggestion(reason);
	const lines: string[] = [];
	lines.push(`Your previous response was rejected by the JSON Schema validator with this error:`);
	lines.push('');
	lines.push(`    ${reason}`);
	lines.push('');
	if (raw !== undefined && raw.trim().length > 0) {
		const preview = raw.length > 600 ? raw.slice(0, 600) + ' ...<truncated>' : raw;
		lines.push('Your rejected response:');
		lines.push('```');
		lines.push(preview);
		lines.push('```');
		lines.push('');
	}
	if (suggestion !== undefined) {
		lines.push(suggestion);
		lines.push('');
	}
	lines.push('Re-emit the JSON object that validates against the schema in the system prompt. Return ONLY the JSON -- no fences, no prose, no preamble.');
	return lines.join('\n');
}

/**
 * Map a validator reason to a corrective suggestion. Covers the
 * highest-frequency violation patterns seen in run #3 (kind enum
 * hallucinations + length-cap edges). Returns `undefined` when the
 * reason has no specific suggestion -- in that case the rejected-
 * payload echo above is enough.
 */
function correctiveSuggestion(reason: string): string | undefined {
	// kind enum violation: extract the bad value and map to the
	// closest valid kind.
	const kindMatch = reason.match(/`workItems\[(\d+)\]\.kind` must be one of fix\|enhance\|add\|trim/);
	if (kindMatch !== null) {
		return [
			`The \`kind\` field is a CLOSED enum -- only fix | enhance | add | trim are valid.`,
			`Closest-valid mappings for common stand-ins:`,
			`  - "clarify" / "expand" / "elaborate" / "specify"  -> use **enhance**`,
			`  - "restructure" / "reorganize" / "consolidate" / "split" -> use **enhance** (or split into a trim+add pair)`,
			`  - "correct" / "rectify" / "amend" -> use **fix**`,
			`  - "remove" / "delete" / "cut" -> use **trim**`,
			`  - "cover" / "include" / "introduce" -> use **add**`,
			`Choose the kind that best matches your intent for workItems[${kindMatch[1]}] from the four valid values.`,
		].join('\n');
	}
	if (/workItems` must be empty when verdict="accept"/.test(reason)) {
		return `When verdict is "accept", the workItems array MUST be empty []. If you have work items, change verdict to "needs-work" instead.`;
	}
	if (/workItems` must be non-empty when verdict="needs-work"/.test(reason)) {
		return `When verdict is "needs-work", you MUST provide 1-6 work items. If the draft has no issues, change verdict to "accept" with workItems = [].`;
	}
	if (/workItems` capped at 6 items/.test(reason)) {
		return `Cap the workItems array at 6 entries. Pick the 6 most important items; the patch loop will catch the rest on subsequent rounds.`;
	}
	if (/workItems\[\d+\]\.kind` is required/.test(reason)) {
		return `Every work item MUST include all of: id, kind, where, issue, action. The kind field is missing from at least one item.`;
	}
	const requiredMatch = reason.match(/`workItems\[(\d+)\]\.(\w+)` is required/);
	if (requiredMatch !== null) {
		return `The required field \`${requiredMatch[2]}\` is missing from workItems[${requiredMatch[1]}]. Every item must include all of: id, kind, where, issue, action.`;
	}
	if (/duplicated/.test(reason)) {
		return `Each work item id must be UNIQUE within the workItems list. Use sequential ids: wi-1, wi-2, wi-3, ...`;
	}
	if (/unparseable JSON/.test(reason)) {
		return `Your response was not valid JSON. Return ONLY a single JSON object with no markdown fences, no prose preamble, and no trailing text after the closing brace.`;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Public API: expand-then-review loop (data-analyzer)
// ---------------------------------------------------------------------------

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

/**
 * Text-only 2-round expand+review loop used by the DATA-analyzer.
 *
 * Contract:
 *   1. Expand (local) -> review (cloud).
 *      - If verdict='accept', return.
 *   2. Else expand again with the reviewer's work-items collapsed
 *      into a hint string -> review again.
 *      - Either verdict is binding: accept the second draft.
 *
 * Never throws; all sub-stage failures degrade to a soft accept.
 *
 * The code-analyzer no longer uses this driver -- it runs a
 * 3-round patch loop via patchSectionWithTools directly. Migrating
 * the data-analyzer to the same loop is out of scope for the
 * structured-review plan; for now this driver bridges the new
 * work-item review shape to the legacy hint-string expander.
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
	// Phase E bridge: the reviewer now emits a typed work-item list
	// (workItems[]) instead of a single hint string. Collapse the
	// list into a hint for the legacy expandAction text expander.
	const hint = review1.workItems.length > 0
		? review1.workItems.map(w => w.action).join('; ')
		: '';
	if (hint.length === 0) {
		log.warn(
			{ analyzer: input.analyzerLabel, actionId: input.action.id },
			'expand-then-review: reviewer returned needs-work without items; soft-accepting round 1',
		);
		const markdown = (review1.accepted?.markdown ?? draft1.markdown).trim();
		const result: ExpandThenReviewResult = {
			markdown,
			rounds:   1,
			verdict:  'accept',
			notes:    [...review1.notes, 'needs-work-without-items; treated as accept'],
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
	if (review2.verdict === 'needs-work') {
		round2Notes.push('second-review-still-needs-work; binding accept');
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

// Phase P.4: SYSTEM_PROMPT carries ONLY the semantic guidance the
// JSON Schema cannot express -- kind-selection intent, when-to-use,
// workflow rules, citation preservation. All structural rules
// (workItems-empty-vs-non-empty, field requireds, field length caps)
// were duplicated between prose and schema and dropped from the
// prose to avoid drift. The shape lives in the JSON Schema block
// appended to the user message by buildReviewMessages.
const SYSTEM_PROMPT = [
	'You review ONE section of an analysis report.',
	'',
	'You will receive:',
	'  - The section\'s objective.',
	'  - The review criteria you must score against.',
	'  - The draft markdown the local expander produced.',
	'  - The same evidence the expander saw.',
	'  - The JSON Schema your response must validate against.',
	'',
	'Your job is a verdict (`accept` or `needs-work`). For `needs-work`,',
	'emit a typed work-item list that a patch loop will iterate.',
	'',
	'## Anti-hallucination gate (CRITICAL -- read first)',
	'',
	'Your single most important job is to catch CLAIMS WITHOUT EVIDENCE.',
	'',
	'The expander has been observed to short-circuit investigation when it has',
	'prior knowledge of a domain (Hadoop, Linux, React, Django, etc.) and write',
	'plausible-sounding general documentation from memory. The reader cannot',
	'tell the difference -- claims sound authoritative either way. Your review',
	'is the gate that catches this.',
	'',
	'For EVERY factual statement in the draft (class names, file paths, counts,',
	'method signatures, architectural claims, specific behaviour descriptions),',
	'check the EVIDENCE block:',
	'',
	'  1. Does the SAME fact appear in an evidence entry? If yes -> fine.',
	'  2. If NO, emit a `fix` work item flagging the unsupported claim. Examples',
	'     of unsupported claims to flag with `fix`:',
	'       - "The module contains 135 files" but no evidence entry confirms 135.',
	'       - "`DistributedFileSystem` extends `FileSystem`" but no evidence',
	'         surfaces either class.',
	'       - Citations linking to DIRECTORIES (e.g. `path:hadoop-hdfs/.../fs`)',
	'         when the prose claims a specific class lives there but no evidence',
	'         entry opened that class -- the citation is hand-rolled, not real.',
	'  3. If the draft contains LANGUAGE ACKNOWLEDGING the gap ("the evidence',
	'     ledger did not provide specific code references", "these processes are',
	'     well-documented in <X>\'s architecture") -- emit a `fix` immediately.',
	'     This is the writer confessing in plain language that it filled in from',
	'     memory.',
	'  4. If the draft is short + honest about evidence gaps, that is GOOD --',
	'     do NOT down-vote it for being short. An honest 200-char section that',
	'     says "the gather phase did not surface enough to cover this objective"',
	'     is preferable to a 3000-char plausible fabrication. Accept short honest',
	'     drafts when the evidence really is empty.',
	'',
	'`fix` is the correct kind for unsupported-claim issues -- they GATE the',
	'section\'s confidence. Use `enhance` only when the claim is supported but',
	'thin / could be deeper. Do NOT use `enhance` to demand new claims; that is',
	'`add`. Do NOT use `trim` to delete fabricated content (the writer needs to',
	'know it was fabricated; emit `fix` so the patch loop replaces it).',
	'',
	'## When to pick each verdict',
	'',
	'  - `accept` -- the draft adequately satisfies the review criteria AND',
	'    every factual claim traces to an evidence entry. You MAY include a',
	'    polished rewrite under `accepted.markdown` if surgical edits are',
	'    clearly worth it; otherwise omit it and the orchestrator uses the',
	'    local draft as-is. Do NOT rewrite just for style.',
	'  - `needs-work` -- the draft has concrete issues that a patch loop',
	'    should address. Emit atomic work items, one per change. ANY',
	'    unsupported claim is automatically `needs-work` regardless of how',
	'    well the rest of the section reads.',
	'',
	'## When to pick each work-item kind',
	'',
	'  - `fix`     -- factually wrong, unsupported, or fabricated claim in',
	'                 the draft. Use for any claim not traceable to the',
	'                 evidence (see anti-hallucination gate above). Use for',
	'                 actual factual errors too (the draft says class X does',
	'                 Y, but evidence shows Z). `fix` items GATE the',
	'                 section -- they must be addressed or it ships with',
	'                 reduced confidence.',
	'  - `enhance` -- claim is correct + supported but thin (missing',
	'                 citations the evidence provides, vague phrasing,',
	'                 lacks specifics). Also covers "clarify", "expand",',
	'                 "elaborate" -- the existing content is grounded but',
	'                 needs more depth.',
	'  - `add`     -- a topic the review criteria require is missing. The',
	'                 patch loop will run a sub-investigation and add a new',
	'                 paragraph at the anchor.',
	'  - `trim`    -- redundant / off-topic content. Do NOT use this for',
	'                 fabricated content -- that needs `fix` so the patch',
	'                 loop replaces it with grounded content.',
	'',
	'## Workflow rules',
	'',
	'  - Each work item is ATOMIC -- one location, one issue, one action.',
	'    If you have three asks for the same paragraph, emit three items.',
	'  - The `where` field MUST point at something concrete in the draft:',
	'    "paragraph N" / "section opening" / "section closing" /',
	'    "after paragraph N". NEVER vague regions like',
	'    "throughout the draft".',
	'  - Keep `issue` and `action` to one short sentence each (the',
	'    schema enforces max 200 chars). State the problem in `issue`,',
	'    the single concrete fix in `action`. Never list alternatives',
	'    ("cite X or Y or Z" -> emit three separate items).',
	'  - Pick the 6 most important items if there are more. Subsequent',
	'    rounds catch the rest.',
	'  - `notes` should be 1-3 short entries describing what was good',
	'    or which criterion drove the verdict.',
	'',
	'## Citation preservation (mandatory)',
	'',
	'The expander emits `[label](path:<file>(#L<startLine>(-L<endLine>)?)?)` ',
	'Markdown links so the IDE can navigate to the source. When polishing',
	'under `accepted.markdown` you MUST preserve these links verbatim --',
	'do NOT strip them, convert them to bare backticks, or invent new',
	'ones the evidence does not support. If the draft is missing links',
	'for entities the evidence carries a file for, emit an `enhance`',
	'work item. If the draft contains links to paths NOT in any evidence',
	'entry (model invented the URL), emit a `fix` work item -- those are',
	'hallucinated citations.',
	'',
	'## Output',
	'',
	'Strict JSON ONLY -- no markdown fences, no prose, no preamble.',
	'The JSON Schema appears at the end of the user message; your',
	'response must validate against it.',
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

	// Phase N.2: prior reviews surfaced so the cloud reviewer can
	// judge whether the new draft addressed earlier flags, rather
	// than starting fresh and drifting between rounds.
	const priorReviews = input.priorReviews ?? [];
	if (priorReviews.length > 0) {
		userLines.push(`## Prior review${priorReviews.length === 1 ? '' : 's'} (this draft is round ${priorReviews.length + 1})`);
		for (const pr of priorReviews) {
			userLines.push('');
			userLines.push(`### Round ${pr.round}: verdict=${pr.verdict}`);
			if (pr.workItems.length === 0) {
				userLines.push('_(no work items)_');
				continue;
			}
			for (const wi of pr.workItems) {
				userLines.push(`- **${wi.id}** (${wi.kind}, ${wi.where}): ${wi.action}`);
			}
		}
		userLines.push('');
		userLines.push('Judge this draft against those earlier flags. If the writer addressed them, say so. If not, raise them again -- but do NOT raise items the prior reviewer did not flag unless they are genuinely new issues with the current draft.');
		userLines.push('');
	}

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

	// Anti-hallucination cross-check reminder, placed RIGHT BEFORE the
	// schema so it's the last semantic instruction the model reads
	// before producing JSON. Reinforces the system prompt's main rule.
	userLines.push('## Before you respond -- cross-check claims against evidence');
	userLines.push('Walk through the draft sentence by sentence. For EACH factual claim --');
	userLines.push('class names, file paths, counts, method signatures, architectural facts --');
	userLines.push('confirm an evidence entry above contains that exact fact. Claims with no');
	userLines.push('supporting evidence -> emit a `fix` work item. Citation links pointing at');
	userLines.push('paths not surfaced by any evidence entry -> emit a `fix` work item');
	userLines.push('(those URLs were composed from prior knowledge, not measured).');
	userLines.push('');
	userLines.push('If the evidence ledger is empty or near-empty AND the draft is short +');
	userLines.push('honest about the gap -> accept with `notes` flagging the gather phase');
	userLines.push('produced thin evidence. Short honest drafts are better than long');
	userLines.push('plausible fabrications.');
	userLines.push('');

	// Phase P.4: inject the JSON Schema as JSON text in a fenced block.
	// The model treats JSON Schema as a strict constraint (recognized
	// format in training data), where bulleted prose reads as
	// "examples". Closes ~90% of first-attempt failures on cloud
	// reviewers per the run #3 analysis.
	userLines.push('## Response schema (JSON Schema)');
	userLines.push('Your response MUST validate against this schema. Enums are CLOSED -- only the listed values are valid.');
	userLines.push('');
	userLines.push('```json');
	userLines.push(JSON.stringify(REVIEW_ACTION_SCHEMA, null, 2));
	userLines.push('```');
	userLines.push('');
	userLines.push('## Output');
	userLines.push('Return ONLY the JSON object that validates against the schema above. No fences, no prose, no preamble.');

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
	| { kind: 'error'; reason: string; raw?: string };

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
			kind:   'error',
			reason: `unparseable JSON (${(err as Error).message})`,
			raw:    rawText,
		};
	}

	const validated = validateReview(parsed);
	if (typeof validated === 'string') {
		return { kind: 'error', reason: `schema violation: ${validated}`, raw: cleaned };
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
	if (verdictRaw !== 'accept' && verdictRaw !== 'needs-work') {
		return '`verdict` must be "accept" or "needs-work"';
	}

	const notes: string[] = [];
	if (Array.isArray(obj['notes'])) {
		for (const n of obj['notes'] as unknown[]) {
			if (typeof n === 'string' && n.trim().length > 0) {
				notes.push(n.trim());
			}
		}
	}

	// Parse workItems (always required as an array, but may be empty
	// for accept). Phase E of plans/code-analyzer-structured-review.md.
	const workItemsRaw = obj['workItems'];
	if (workItemsRaw !== undefined && !Array.isArray(workItemsRaw)) {
		return '`workItems` must be an array';
	}
	const workItems: ReviewWorkItem[] = [];
	const seenIds = new Set<string>();
	// Phase P.3: collect soft-truncation notes here so the caller sees
	// what got clipped. Notes are appended to `result.notes` on
	// success. No rejection-on-length anymore -- the validator clips
	// `issue` / `action` at 200 chars instead of failing the review.
	const truncationNotes: string[] = [];
	if (Array.isArray(workItemsRaw)) {
		if (workItemsRaw.length > 6) {
			return '`workItems` capped at 6 items';
		}
		for (let i = 0; i < workItemsRaw.length; i++) {
			const wiRaw = workItemsRaw[i];
			if (wiRaw === null || typeof wiRaw !== 'object' || Array.isArray(wiRaw)) {
				return `\`workItems[${i}]\` is not an object`;
			}
			const wi = wiRaw as Record<string, unknown>;
			const id        = typeof wi['id']     === 'string' ? (wi['id'] as string).trim() : '';
			const kind      = wi['kind'];
			const where     = typeof wi['where']  === 'string' ? (wi['where'] as string).trim() : '';
			let   issue     = typeof wi['issue']  === 'string' ? (wi['issue'] as string).trim() : '';
			let   action    = typeof wi['action'] === 'string' ? (wi['action'] as string).trim() : '';
			if (id.length === 0)     return `\`workItems[${i}].id\` is required`;
			if (seenIds.has(id))     return `\`workItems[${i}].id\` "${id}" is duplicated`;
			seenIds.add(id);
			if (kind !== 'fix' && kind !== 'enhance' && kind !== 'add' && kind !== 'trim') {
				return `\`workItems[${i}].kind\` must be one of fix|enhance|add|trim`;
			}
			if (where.length === 0)  return `\`workItems[${i}].where\` is required`;
			if (issue.length === 0)  return `\`workItems[${i}].issue\` is required`;
			if (action.length === 0) return `\`workItems[${i}].action\` is required`;
			// Phase P.3: soft-truncate instead of reject. Length caps
			// were costing us valid reviews in run #3 (sections 4 R3,
			// 7 R2 -- reviewer's 230-char `action` field tripped the
			// 200 cap, validator rejected, soft-accept fired). Now we
			// clip with an ellipsis and surface the clip as a note.
			if (issue.length > 200) {
				truncationNotes.push(`workItems[${i}].issue truncated from ${issue.length} to 200 chars`);
				issue = issue.slice(0, 197) + '...';
			}
			if (action.length > 200) {
				truncationNotes.push(`workItems[${i}].action truncated from ${action.length} to 200 chars`);
				action = action.slice(0, 197) + '...';
			}

			const item: { -readonly [K in keyof ReviewWorkItem]: ReviewWorkItem[K] } = {
				id, kind, where, issue, action,
			};
			const refsRaw = wi['evidenceRefs'];
			if (Array.isArray(refsRaw)) {
				const refs: string[] = [];
				for (const r of refsRaw) {
					if (typeof r === 'string' && r.trim().length > 0) refs.push(r.trim());
				}
				if (refs.length > 0) item.evidenceRefs = refs;
			}
			workItems.push(item);
		}
	}
	// Phase P.3: append truncation notes to the review notes so they
	// surface in logs + TodoList. No effect on verdict / workItems.
	if (truncationNotes.length > 0) {
		notes.push(...truncationNotes);
	}

	if (verdictRaw === 'accept') {
		if (workItems.length > 0) {
			return '`workItems` must be empty when verdict="accept"';
		}
		const result: { -readonly [K in keyof ReviewActionResult]: ReviewActionResult[K] } = {
			verdict:   'accept',
			workItems: [],
			notes,
			degraded:  false,
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

	// verdict === 'needs-work'
	if (workItems.length === 0) {
		return '`workItems` must be non-empty when verdict="needs-work"';
	}
	return {
		verdict:   'needs-work',
		workItems,
		notes,
		degraded:  false,
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
