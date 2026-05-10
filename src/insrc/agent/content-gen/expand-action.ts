/**
 * Stage 2 of the cloud-plan / local-expand / cloud-review synthesis flow
 * (plans/analyzers/cloud-plan-local-expand-cloud-review.md, Phase 2).
 *
 * One LLM call to the LOCAL provider, drafting a single section
 * markdown body for one `PlannedAction`. Plain-text output (NOT JSON).
 * The expander sees only the action card + the evidence the planner
 * cited -- not the rest of the report or the user's full prompt
 * history. This keeps the per-action loop independent and locally
 * cheap.
 *
 * On a second pass (after a `refine` review verdict) the caller hands
 * back the reviewer's hint via `refineHint`; the expander prepends it
 * to its system prompt as a focused-fix instruction.
 */

import type { LLMProvider, LLMMessage } from '../../shared/types.js';
import { getLogger } from '../../shared/logger.js';
import type { PlanExecution, PlannedAction } from './plan-actions.js';

const log = getLogger('content-gen:expand-action');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExpandActionInput {
	readonly action:    PlannedAction;
	/** Skill executions the orchestrator gathered for THIS plan step.
	 *  The expander never sees executions from other plan steps;
	 *  caller (orchestrator) runs a per-step skills pipeline scoped
	 *  to `action.objective` and hands the results in here. */
	readonly evidence:  readonly PlanExecution[];
	/** Original user prompt (for narrative orientation only). */
	readonly request:   string;
	/** Optional review-from-prior-pass hint. When supplied the
	 *  expander treats this as a focused fix request, not a full
	 *  rewrite. */
	readonly refineHint?: string | undefined;
	/** Optional analyzer label for logging ("code-analyzer" /
	 *  "data-analyzer"). */
	readonly analyzerLabel?: string | undefined;
}

export interface ExpandActionResult {
	readonly actionId:      string;
	readonly markdown:      string;
	readonly tokenEstimate: number;
	/** True when the response hit the `maxTokens` cap. The reviewer
	 *  may use this to decide whether truncation actually hurt the
	 *  output. */
	readonly truncated:     boolean;
	/** True when the expander degraded -- e.g. provider threw mid-call.
	 *  In that case `markdown` is a fallback "(could not draft this
	 *  section ...)" stub the reviewer will see and likely refine. */
	readonly degraded:      boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the expand stage for one action. Never throws; provider
 * failures degrade to a fallback stub markdown so the per-action
 * loop driver can still feed the reviewer something.
 */
export async function expandAction(
	input: ExpandActionInput,
	localProvider: LLMProvider,
): Promise<ExpandActionResult> {
	// Request/response payloads are logged universally by the LLM
	// provider logging-wrapper (agent/providers/logging-wrapper.ts).
	// Helper-level log just adds the semantic stage tag so the trail
	// is searchable by actionId.
	const messages = buildExpandMessages(input);
	const maxTokens = input.action.maxBudgetTokens;

	let rawText: string;
	let stopReason: string | undefined;
	try {
		const response = await localProvider.complete(messages, {
			maxTokens,
			temperature: 0.2,
		});
		rawText = response.text;
		stopReason = response.stopReason;
	} catch (err) {
		log.warn(
			{ analyzer: input.analyzerLabel, actionId: input.action.id, err: (err as Error).message },
			'expand-action: provider call failed; emitting fallback stub',
		);
		return {
			actionId:      input.action.id,
			markdown:      fallbackMarkdown(input.action, `expand provider error: ${(err as Error).message}`),
			tokenEstimate: 0,
			truncated:     false,
			degraded:      true,
		};
	}

	const cleaned = cleanExpanderResponse(rawText);
	const truncated = stopReason === 'max_tokens' || stopReason === 'length';

	log.info(
		{
			llmStage:   'expand-action',
			actionId:   input.action.id,
			rawLen:     rawText.length,
			cleanedLen: cleaned.length,
			truncated,
			degraded:   cleaned.length === 0,
		},
		'expand-action: parsed result (full payload in llm-io log)',
	);

	return {
		actionId:      input.action.id,
		markdown:      cleaned,
		tokenEstimate: estimateTokens(cleaned),
		truncated,
		degraded:      cleaned.length === 0,
	};
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_BASE = [
	'You write ONE section of an analysis report.',
	'',
	'You will receive:',
	'  - The section\'s objective (one sentence).',
	'  - The review criteria a downstream reviewer will score against.',
	'  - The evidence (skill executions) you may cite.',
	'  - The original user request -- for orientation only; do NOT',
	'    answer the whole request, only this section.',
	'',
	'Rules:',
	'  1. Output Markdown body ONLY -- no leading `## <title>` heading,',
	'     no leading section number. The orchestrator stitches headings.',
	'  2. Use ONLY the supplied evidence. Do NOT invent skill ids,',
	'     entity names, file paths, or facts that are not in the',
	'     evidence block. Citing an evidence excerpt verbatim is fine;',
	'     paraphrasing is fine; fabricating is not.',
	'  3. Aim to satisfy every review criterion. The reviewer will',
	'     score you against them and may request a focused refinement.',
	'  4. Keep the section focused on the objective. Do not pad with',
	'     unrelated material; if the evidence is thin, say so plainly.',
	'  5. Code, paths, and identifiers go in `inline code`. Lists,',
	'     tables, and short callouts are welcome where they aid clarity.',
	'  6. Stop when you have addressed the objective and review',
	'     criteria. Concise and complete beats long and meandering.',
].join('\n');

const REFINE_PREFIX_TEMPLATE = (hint: string): string => [
	'## Focused refinement',
	'',
	'A reviewer rejected the prior draft of this section with the',
	'following hint:',
	'',
	`> ${hint}`,
	'',
	'Address this specific issue. Do NOT rewrite the entire section',
	'unless the hint requires it; prefer surgical edits.',
	'',
].join('\n');

function buildExpandMessages(input: ExpandActionInput): LLMMessage[] {
	const sysParts: string[] = [];
	if (input.refineHint !== undefined && input.refineHint.trim().length > 0) {
		sysParts.push(REFINE_PREFIX_TEMPLATE(input.refineHint.trim()));
	}
	sysParts.push(SYSTEM_PROMPT_BASE);

	const userLines: string[] = [];
	userLines.push('## Original request');
	userLines.push(input.request.trim());
	userLines.push('');
	userLines.push('## Section to draft');
	userLines.push(`title:     ${input.action.title}`);
	userLines.push(`objective: ${input.action.objective}`);
	userLines.push('');
	userLines.push('## Review criteria');
	for (const c of input.action.reviewCriteria) {
		userLines.push(`- ${c}`);
	}
	userLines.push('');
	userLines.push(`## Evidence (${input.evidence.length})`);
	if (input.evidence.length === 0) {
		userLines.push('(no evidence supplied -- write the section based only on the original request and your knowledge of analysis-report conventions)');
	} else {
		for (let i = 0; i < input.evidence.length; i++) {
			const e = input.evidence[i]!;
			userLines.push(`### [${i}] ${e.skillId} (confidence: ${e.confidence})`);
			userLines.push(formatEvidenceValue(e.value));
			if (e.notes.length > 0) {
				userLines.push('Notes:');
				for (const n of e.notes.slice(0, 4)) {
					userLines.push(`  - ${n}`);
				}
			}
			userLines.push('');
		}
	}
	userLines.push('## Output');
	userLines.push('Markdown body for this section ONLY. No heading, no section number.');

	return [
		{ role: 'system', content: sysParts.join('\n') },
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
// Response cleanup
// ---------------------------------------------------------------------------

function cleanExpanderResponse(raw: string): string {
	let out = raw.trim();
	// Strip leading code-fence if the model wrapped the whole body.
	if (out.startsWith('```')) {
		out = out.replace(/^```(?:markdown|md)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
	}
	// Strip a leading `## <title>` heading if the model emitted one
	// despite rule 1 (orchestrator stitches headings).
	out = out.replace(/^##+\s+.*\n+/, '');
	return out.trim();
}

function fallbackMarkdown(action: PlannedAction, reason: string): string {
	return [
		`_The local model could not draft this section (${reason}). The`,
		'reviewer should treat the section as needing refinement; the',
		'orchestrator will accept the second-pass draft regardless._',
		'',
		`*Objective:* ${action.objective}`,
	].join('\n');
}

function estimateTokens(s: string): number {
	// Same chars-per-token approximation the rest of the agent uses.
	return Math.ceil(s.length / 3);
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _buildExpandMessagesForTest = buildExpandMessages;
export const _cleanExpanderResponseForTest = cleanExpanderResponse;
export const _fallbackMarkdownForTest    = fallbackMarkdown;

// Re-exports kept for callers that take Refs from this module's
// surface without round-tripping through plan-actions.ts.
export type { PlanExecution, PlannedAction };
