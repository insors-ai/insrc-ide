/**
 * Stage 1 of the cloud-plan / local-expand / cloud-review synthesis flow
 * (plans/analyzers/cloud-plan-local-expand-cloud-review.md, Phase 1).
 *
 * One LLM call to the active cloud provider, constrained to
 * `PLAN_ACTIONS_SCHEMA`. Decomposes a single user request into N
 * action-cards. Each card becomes one section of the final markdown
 * report and is processed by an independent expand+review loop.
 *
 * **Lean input.** The cloud planner sees ONLY:
 *   - intent          ('code-analysis' / 'data-analysis')
 *   - request         (the user's prompt)
 *   - summary context (one-line repo descriptor + memory of prior turns)
 *
 * It does NOT see the skills pipeline's executions or any pre-fetched
 * evidence. The local model picks tools / runs skills per plan step.
 * (Per the user's decision: "what tools to use, how to expand the
 * plan steps should be left to the local LLM".)
 *
 * Mirrors `generateOutline` in `outline.ts`: structured-JSON output,
 * one validation retry, fallback to `degraded: true` on second
 * failure. Caller (orchestrator) handles degraded by falling back to
 * a single synthetic "summary" action.
 */

import type { LLMProvider, LLMMessage } from '../../shared/types.js';
import type { ScopeSize } from '../../shared/classify.js';
import { getLogger } from '../../shared/logger.js';
import { PLAN_ACTIONS_SCHEMA } from './schema.js';

const log = getLogger('content-gen:plan-actions');

const DEFAULT_MAX_TOKENS = 2500;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-tier action budget cap. Lower tiers get fewer sections;
 * higher tiers get more breathing room. The cap is advisory to the
 * planner -- it can return fewer -- and a hard clamp on the helper
 * side so a runaway model can't blow the report up.
 *
 * The schema's absolute ceiling is 32 (matches XXXXL).
 */
export const ACTION_BUDGET_BY_TIER: Readonly<Record<ScopeSize, number>> = {
	S:     2,
	M:     4,
	L:     8,
	XL:    12,
	XXL:   16,
	XXXL:  24,
	XXXXL: 32,
};

export interface PlannedAction {
	readonly id:              string;
	readonly title:           string;
	readonly objective:       string;
	readonly maxBudgetTokens: number;
	readonly reviewCriteria:  readonly string[];
}

export interface PlanActionsInput {
	/** Analyzer family / intent. e.g. 'code-analysis' or 'data-analysis'. */
	readonly intent: string;
	/** User's prompt verbatim (post-question-enhancer where applicable). */
	readonly request: string;
	/**
	 * One- or two-line summary the planner uses as orientation. Caller
	 * composes it from:
	 *   - active repo descriptor (path, languages, tier)
	 *   - memory: brief recap of prior turns + facts already covered
	 * The planner does NOT see skill executions, evidence blobs, or
	 * any other heavy context.
	 */
	readonly summaryContext: string;
	/** Scope tier (caps action count via `ACTION_BUDGET_BY_TIER`). */
	readonly tier: ScopeSize;
	/** Override the per-tier action budget (advisory). Clamped to the
	 *  schema's hard cap of 32. */
	readonly maxActions?: number | undefined;
	/** Output token cap. Default 2500. */
	readonly maxTokens?: number | undefined;
	/** Optional analyzer label for logging. */
	readonly analyzerLabel?: string | undefined;
	/**
	 * Optional per-tier decomposition guidance the caller supplies. The
	 * planner framework is shared across analyzers; this field is the
	 * caller-injected context that tells the planner WHAT TO COVER for
	 * the active tier. Phase E of plans/code-analyzer-scope-tier-prompts.md.
	 *
	 * Code-analyzer fills this with the rendered `sections/planner-
	 * context/{tier}.md` MD. Data-analyzer (which has its own tier-
	 * aware prompts elsewhere) leaves it undefined. When undefined,
	 * the planner emits its prior generic prompt.
	 */
	readonly tierContext?: string | undefined;
}

export interface PlanActionsResult {
	readonly intentBrief: string;
	readonly actions:     readonly PlannedAction[];
	/** True when the planner failed both attempts. Caller substitutes
	 *  a synthetic single-action fallback. */
	readonly degraded:    boolean;
	readonly note?:       string | undefined;
}

/**
 * `PlanExecution` shape kept for backwards compat with the
 * expand-action / review-action helpers and the legacy orchestrator
 * paths. The planner itself no longer consumes this -- it's used by
 * the per-step skills pipeline that runs inside expand.
 */
export interface PlanExecution {
	readonly skillId:    string;
	readonly value:      unknown;
	readonly confidence: 'high' | 'medium' | 'low';
	readonly notes:      readonly string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the plan stage. Throws only if `request` is empty; every other
 * error path returns `degraded: true` with an empty `actions` array
 * so the caller can substitute a fallback without crashing the run.
 */
export async function planActions(
	input: PlanActionsInput,
	cloudProvider: LLMProvider,
): Promise<PlanActionsResult> {
	if (input.request.trim().length === 0) {
		throw new Error('planActions: `request` must be non-empty');
	}

	const tierCap   = ACTION_BUDGET_BY_TIER[input.tier];
	const requested = input.maxActions ?? tierCap;
	const maxActions = Math.max(1, Math.min(32, requested));
	const maxTokens  = input.maxTokens ?? DEFAULT_MAX_TOKENS;
	const messages   = buildPlanMessages(input, maxActions);

	const first = await tryPlan(messages, cloudProvider, maxTokens);
	if (first.kind === 'ok') {
		return {
			intentBrief: first.value.intentBrief,
			actions:     clamp(first.value.actions, maxActions),
			degraded:    false,
		};
	}

	log.warn(
		{ analyzer: input.analyzerLabel, reason: first.reason },
		'plan-actions: first attempt failed; retrying with correction',
	);
	const retryMessages: LLMMessage[] = [
		...messages,
		{
			role: 'user',
			content: `Your previous response was rejected: ${first.reason}.\n\nReturn ONLY the JSON object that matches the PlanActionsResult schema. No fences, no prose, no preamble.`,
		},
	];
	const second = await tryPlan(retryMessages, cloudProvider, maxTokens);
	if (second.kind === 'ok') {
		return {
			intentBrief: second.value.intentBrief,
			actions:     clamp(second.value.actions, maxActions),
			degraded:    false,
		};
	}

	log.warn(
		{ analyzer: input.analyzerLabel, first: first.reason, second: second.reason },
		'plan-actions: both attempts failed; returning degraded result',
	);
	return {
		intentBrief: '',
		actions:     [],
		degraded:    true,
		note:        `plan stage failed: ${second.reason}`,
	};
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildSystemPrompt(intent: string, tierContext: string | undefined): string {
	const parts: string[] = [
		`You plan a ${intent} report for a coding assistant.`,
		'',
		'Given the user request and a brief summary context (active',
		'repository + memory of prior turns), decompose the work into N',
		'high-level action-cards. Each card is one section of the final',
		'markdown report. The local model will pick its own tools for',
		'each step; the cloud model reviews each section.',
		'',
	];
	// Phase E of plans/code-analyzer-scope-tier-prompts.md:
	// the caller (orchestrator) injects a per-tier decomposition menu
	// here when one is available, so the planner emits sections aligned
	// with the tier-appropriate exploration. Shared planner framework =
	// generic; caller-injected context = analyzer-specific.
	if (tierContext !== undefined && tierContext.trim().length > 0) {
		parts.push(tierContext.trim());
		parts.push('');
	}
	parts.push(
		'Per action you MUST emit:',
		'  - id              kebab-case stable key (deduped across actions)',
		'  - title           short user-facing heading',
		'  - objective       ONE sentence stating WHAT the section answers',
		'                    (this becomes the local model\'s working brief)',
		'  - maxBudgetTokens cap for the local expander\'s draft',
		'                    (default 1500; clamp 400-3000)',
		'  - reviewCriteria  3-5 short bullets the reviewer scores against',
		'',
		'Plan-stage rules:',
		'  1. Hard cap on action count is supplied per call -- never exceed it.',
		'  2. The DEFAULT for in-repo report sections is depth, not breadth.',
		'     A "describe X" prompt should produce fewer / longer sections,',
		'     not more / shallower ones. Pick the shape that lets the report',
		'     answer the request thoroughly.',
		'  3. Do NOT name skills, tools, or specific file paths / class names in',
		'     the OBJECTIVE. The local model picks those at expand time. The',
		'     objective is a goal statement -- not a tool call.',
		'  4. TITLES MUST name specific subsystems from the `## Repo summary`',
		'     block when it is present in the context. Generic titles like',
		'     "Architecture & Entry Points", "Core Capabilities", "Technology',
		'     Stack" are a CODE SMELL -- they signal you ignored the repo',
		'     summary. If the summary lists top modules `insors/ocr/`,',
		'     `insors/extraction/legal/`, `insors/core/PDF/stirling/`, the',
		'     action titles should name them ("OCR & Layout Detection",',
		'     "Legal Case Extraction Pipeline", "PDF Processing via Stirling").',
		'     The objective can still be a generic goal statement; only the',
		'     title carries the subsystem reference.',
		'  5. Use the memory section to AVOID re-covering what prior turns did.',
		'     Plan deeper / sideways from where prior reports left off.',
		'  6. `intentBrief` is 1-2 sentences summarising what the report is about.',
		'  7. Review criteria are concrete checkable statements (e.g. "names',
		'     each top-level module by path", "covers cyclic dependencies if',
		'     any are present"), NOT generic style notes.',
		'',
		'Output strict JSON ONLY (no markdown fences, no prose, no preamble).',
	);
	return parts.join('\n');
}

interface BuiltMessages { readonly messages: LLMMessage[]; readonly userText: string; }

function buildPlanMessages(input: PlanActionsInput, maxActions: number): LLMMessage[] {
	return buildPlanMessagesWithDebug(input, maxActions).messages;
}

function buildPlanMessagesWithDebug(input: PlanActionsInput, maxActions: number): BuiltMessages {
	const lines: string[] = [];

	lines.push('## Intent');
	lines.push(input.intent);
	lines.push('');

	lines.push('## Request');
	lines.push(input.request.trim());
	lines.push('');

	lines.push('## Summary context');
	lines.push(input.summaryContext.trim().length > 0 ? input.summaryContext.trim() : '(no summary supplied)');
	lines.push('');

	lines.push('## Action budget');
	lines.push(`Maximum actions for this report: ${maxActions} (scope tier: ${input.tier}).`);

	const userText = lines.join('\n');
	return {
		messages: [
			{ role: 'system', content: buildSystemPrompt(input.intent, input.tierContext) },
			{ role: 'user',   content: userText },
		],
		userText,
	};
}

// ---------------------------------------------------------------------------
// One plan attempt
// ---------------------------------------------------------------------------

type PlanAttempt =
	| { kind: 'ok';    value: { intentBrief: string; actions: PlannedAction[] } }
	| { kind: 'error'; reason: string };

async function tryPlan(
	messages: LLMMessage[],
	provider: LLMProvider,
	maxTokens: number,
): Promise<PlanAttempt> {
	// Note: request/response payloads are logged universally by the LLM
	// provider logging-wrapper (agent/providers/logging-wrapper.ts).
	let rawText: string;
	try {
		const response = await provider.complete(messages, {
			maxTokens,
			temperature: 0,
			responseFormat: { schema: PLAN_ACTIONS_SCHEMA as unknown as Record<string, unknown> },
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

	const validated = validatePlan(parsed);
	if (typeof validated === 'string') {
		return { kind: 'error', reason: `schema violation: ${validated}` };
	}

	log.info(
		{ llmStage: 'plan-actions', parsedPlan: validated },
		'plan-actions: parsed plan structure (full payload in llm-io log)',
	);

	return { kind: 'ok', value: validated };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validatePlan(parsed: unknown): { intentBrief: string; actions: PlannedAction[] } | string {
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return 'response is not a JSON object';
	}
	const obj = parsed as Record<string, unknown>;

	const intentBrief = typeof obj['intentBrief'] === 'string' ? obj['intentBrief'].trim() : '';
	if (intentBrief.length === 0) {
		return '`intentBrief` missing or empty';
	}

	if (!Array.isArray(obj['actions'])) {
		return '`actions` must be an array';
	}
	const actionsRaw = obj['actions'] as unknown[];

	const seenIds = new Set<string>();
	const actions: PlannedAction[] = [];
	for (let i = 0; i < actionsRaw.length; i++) {
		const aRaw = actionsRaw[i];
		if (aRaw === null || typeof aRaw !== 'object' || Array.isArray(aRaw)) {
			return `action[${i}] is not an object`;
		}
		const a = aRaw as Record<string, unknown>;

		const id = typeof a['id'] === 'string' ? a['id'].trim() : '';
		if (id.length === 0) return `action[${i}].id missing or empty`;
		if (seenIds.has(id)) return `action[${i}].id "${id}" duplicates an earlier action`;
		seenIds.add(id);

		const title = typeof a['title'] === 'string' ? a['title'].trim() : '';
		if (title.length === 0) return `action[${i}].title missing or empty`;

		const objective = typeof a['objective'] === 'string' ? a['objective'].trim() : '';
		if (objective.length === 0) return `action[${i}].objective missing or empty`;

		if (!Array.isArray(a['reviewCriteria'])) {
			return `action[${i}].reviewCriteria must be an array`;
		}
		const criteriaRaw = a['reviewCriteria'] as unknown[];
		const reviewCriteria = criteriaRaw
			.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
			.map(c => c.trim());
		if (reviewCriteria.length === 0) {
			return `action[${i}].reviewCriteria must have at least one entry`;
		}

		const budgetRaw = a['maxBudgetTokens'];
		const maxBudgetTokens = typeof budgetRaw === 'number' && Number.isFinite(budgetRaw)
			? Math.max(400, Math.min(3000, Math.floor(budgetRaw)))
			: 1500;

		actions.push({ id, title, objective, maxBudgetTokens, reviewCriteria });
	}

	return { intentBrief, actions };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(actions: readonly PlannedAction[], cap: number): readonly PlannedAction[] {
	if (actions.length <= cap) return actions;
	return actions.slice(0, cap);
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

export const _validatePlanForTest          = validatePlan;
export const _buildPlanMessagesForTest     = buildPlanMessagesWithDebug;
export const _stripFencesForTest           = stripFences;
