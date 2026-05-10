/**
 * Stage 1 of the cloud-plan / local-expand / cloud-review synthesis flow
 * (plans/analyzers/cloud-plan-local-expand-cloud-review.md, Phase 1).
 *
 * One LLM call to the active cloud provider, constrained to
 * `PLAN_ACTIONS_SCHEMA`. Decomposes a single user prompt + the skills-
 * pipeline executions into N action-cards. Each action carries enough
 * information for an independent local-expand / cloud-review loop --
 * objective, evidence refs, review criteria.
 *
 * Mirrors `generateOutline` in `outline.ts`: structured-JSON output,
 * one validation retry, fallback to `degraded: true` on second
 * failure. Caller (orchestrator) handles degraded by falling back to
 * a single synthetic "summary" action so the report still produces.
 *
 * Analyzer-agnostic: takes a generic `PlanExecution[]` shape that
 * both code-analyzer and data-analyzer's `PerSkillExecution` satisfy
 * structurally.
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

/** Subset of `PerSkillExecution` the planner needs. Both
 *  analyzers' `PerSkillExecution` satisfies this structurally. */
export interface PlanExecution {
	readonly skillId:    string;
	readonly value:      unknown;
	readonly confidence: 'high' | 'medium' | 'low';
	readonly notes:      readonly string[];
}

export interface PlannedEvidenceRef {
	readonly skillId:      string;
	readonly executionIdx: number;
	readonly highlight?:   string | undefined;
}

export interface PlannedAction {
	readonly id:              string;
	readonly title:           string;
	readonly objective:       string;
	readonly evidence:        readonly PlannedEvidenceRef[];
	readonly maxBudgetTokens: number;
	readonly reviewCriteria:  readonly string[];
}

export interface PlanActionsInput {
	/** User's enhanced prompt (post-question-enhancer where applicable). */
	readonly request: string;
	/** Free-form repo summary line. Caller composes; planner just
	 *  echoes it as context. */
	readonly repoSummary: string;
	/** Skill executions in the order the pipeline ran them. */
	readonly executions: readonly PlanExecution[];
	/** Scope tier (caps action count via `ACTION_BUDGET_BY_TIER`). */
	readonly tier: ScopeSize;
	/** Optional one-line summary of what prior turns covered, so the
	 *  planner doesn't repeat them. */
	readonly priorContextSummary?: string | undefined;
	/** Override the per-tier action budget (advisory). Clamped to the
	 *  schema's hard cap of 32. */
	readonly maxActions?: number | undefined;
	/** Output token cap. Default 2500. */
	readonly maxTokens?: number | undefined;
	/** Optional analyzer label for logging ("code-analyzer" /
	 *  "data-analyzer"). */
	readonly analyzerLabel?: string | undefined;
}

export interface PlanActionsResult {
	readonly intentBrief: string;
	readonly actions:     readonly PlannedAction[];
	/** True when the planner failed both attempts. Caller substitutes
	 *  a synthetic single-action fallback. */
	readonly degraded:    boolean;
	readonly note?:       string | undefined;
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

const SYSTEM_PROMPT = [
	'You plan an analysis report.',
	'',
	'Given the user request, the active repository summary, and the skill',
	'executions the analyzer pipeline produced, decompose the work into',
	'N action-cards. Each card becomes one section of the final markdown',
	'report and is processed by an independent expand+review loop.',
	'',
	'Per action you MUST emit:',
	'  - id              kebab-case stable key (deduped across actions)',
	'  - title           short user-facing heading',
	'  - objective       ONE sentence stating what the section answers',
	'  - evidence        array of { skillId, executionIdx, highlight? } refs',
	'                    pointing at the supplied executions; only cite',
	'                    skills that actually ran',
	'  - maxBudgetTokens cap for the local expander\'s draft',
	'                    (default 1500; clamp 400-3000)',
	'  - reviewCriteria  3-5 short bullets the reviewer scores against',
	'',
	'Plan-stage rules:',
	'  1. EVERY action must cite at least one execution unless the section',
	'     is purely structural (intro / summary / drill-down callout). When',
	'     uncertain prefer to cite.',
	'  2. Hard cap on action count is supplied per call -- never exceed it.',
	'  3. The DEFAULT for in-repo report sections is depth, not breadth.',
	'     A "describe X" prompt with detailed evidence should produce',
	'     fewer / longer sections, not more / shallower ones.',
	'  4. `intentBrief` is 1-2 sentences summarising what the report is',
	'     about; the orchestrator uses it as the report intro.',
	'  5. Review criteria are concrete checkable statements (e.g. "names',
	'     each top-level module by path", "cites the cyclic-deps finding'
		+ ' at least once"), NOT generic style notes.',
	'',
	'Output strict JSON ONLY (no markdown fences, no prose, no preamble).',
].join('\n');

interface BuiltMessages { readonly messages: LLMMessage[]; readonly userText: string; }

function buildPlanMessages(input: PlanActionsInput, maxActions: number): LLMMessage[] {
	return buildPlanMessagesWithDebug(input, maxActions).messages;
}

/** Exported for tests so they can assert on the user-prompt body. */
function buildPlanMessagesWithDebug(input: PlanActionsInput, maxActions: number): BuiltMessages {
	const lines: string[] = [];

	lines.push('## Request');
	lines.push(input.request.trim());
	lines.push('');

	lines.push('## Repository');
	lines.push(input.repoSummary.trim().length > 0 ? input.repoSummary.trim() : '(none)');
	lines.push('');

	lines.push(`## Action budget`);
	lines.push(`Maximum actions for this report: ${maxActions} (scope tier: ${input.tier}).`);
	lines.push('');

	if (input.priorContextSummary !== undefined && input.priorContextSummary.trim().length > 0) {
		lines.push('## Prior turns covered');
		lines.push(input.priorContextSummary.trim());
		lines.push('Avoid duplicating sections the prior report already covered. Reference them only when the current request asks to drill deeper.');
		lines.push('');
	}

	lines.push(`## Executions (${input.executions.length})`);
	if (input.executions.length === 0) {
		lines.push('(no executions ran -- the pipeline returned an empty result)');
	} else {
		for (let i = 0; i < input.executions.length; i++) {
			const e = input.executions[i]!;
			lines.push(`### [${i}] ${e.skillId} (confidence: ${e.confidence})`);
			lines.push(formatExecutionValue(e.value));
			if (e.notes.length > 0) {
				lines.push('Notes:');
				for (const n of e.notes.slice(0, 4)) {
					lines.push(`  - ${n}`);
				}
			}
			lines.push('');
		}
	}

	const userText = lines.join('\n');
	return {
		messages: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{ role: 'user',   content: userText },
		],
		userText,
	};
}

const EXECUTION_PREVIEW_MAX = 600;

function formatExecutionValue(value: unknown): string {
	if (value === null || value === undefined) return '(no value)';
	let s: string;
	try {
		s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
	} catch {
		s = String(value);
	}
	if (s.length <= EXECUTION_PREVIEW_MAX) return s;
	return s.slice(0, EXECUTION_PREVIEW_MAX) + ' ...<truncated>';
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
	// Note: the request/response payloads are logged universally by
	// the LLM provider logging-wrapper (agent/providers/logging-wrapper.ts),
	// which sees every provider.complete() call. We only log the
	// structural parsed-plan summary here so each log entry has
	// semantic stage context.
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

		if (!Array.isArray(a['evidence'])) {
			return `action[${i}].evidence must be an array`;
		}
		const evidenceRaw = a['evidence'] as unknown[];
		const evidence: PlannedEvidenceRef[] = [];
		for (let j = 0; j < evidenceRaw.length; j++) {
			const eRaw = evidenceRaw[j];
			if (eRaw === null || typeof eRaw !== 'object' || Array.isArray(eRaw)) {
				return `action[${i}].evidence[${j}] is not an object`;
			}
			const e = eRaw as Record<string, unknown>;
			const skillId = typeof e['skillId'] === 'string' ? e['skillId'].trim() : '';
			if (skillId.length === 0) return `action[${i}].evidence[${j}].skillId missing`;
			const idxRaw = e['executionIdx'];
			if (typeof idxRaw !== 'number' || !Number.isFinite(idxRaw) || idxRaw < 0) {
				return `action[${i}].evidence[${j}].executionIdx must be a non-negative number`;
			}
			const ref: { -readonly [K in keyof PlannedEvidenceRef]: PlannedEvidenceRef[K] } = {
				skillId,
				executionIdx: Math.floor(idxRaw),
			};
			if (typeof e['highlight'] === 'string' && (e['highlight'] as string).trim().length > 0) {
				ref.highlight = (e['highlight'] as string).trim();
			}
			evidence.push(ref);
		}

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

		actions.push({ id, title, objective, evidence, maxBudgetTokens, reviewCriteria });
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
