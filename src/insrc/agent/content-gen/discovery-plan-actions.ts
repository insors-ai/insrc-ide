/**
 * Cloud-side entrypoints for the discovery-plan loop -- Phase γ of
 * plans/code-analyzer-discovery-plan-loop.md.
 *
 * Two cloud LLM calls:
 *
 *   1. `expandDiscoveryPlan(section, cycle, cycleMemory)` -> DiscoveryPlan
 *      Stage 2 of the architecture. Cloud receives the section + the
 *      tier-aware coverage menu + (cycle 2+) the carried CycleMemory,
 *      and emits an ordered list of steps with cloud-named skills +
 *      semantic context.
 *
 *   2. `reviewCycle(stepOutputs, cycleMemory, section)` -> CycleReviewResponse
 *      Stage 5. Cloud reviews THIS cycle's raw step outputs + the
 *      CycleMemory; emits which step outputs to keep (promoted to
 *      ledger) and what NEW steps to run next cycle (empty array =
 *      terminate the loop).
 *
 * Both:
 *   - Send strict JSON via `responseFormat.schema`.
 *   - Run up to 3 attempts (the same correction-retry pattern
 *     `reviewAction` uses for the legacy reviewer); a final failure
 *     degrades to a sentinel "no progress" response so the
 *     orchestrator doesn't crash.
 *   - Never throw; degrades silently to keep the report shipping.
 */

import type { LLMProvider, LLMMessage } from '../../shared/types.js';
import { getLogger } from '../../shared/logger.js';
import { loadFlowPrompt } from '../tasks/code-analyzer/prompts/loader.js';
import { normalizeTier } from '../tasks/code-analyzer/prompts/loader.js';
import { summarizeCycleMemory } from '../tasks/code-analyzer/cycle-memory.js';
import type { ScopeSize } from '../../shared/classify.js';
import type { PlannedAction } from './plan-actions.js';
import type {
	CycleMemory,
	CycleReviewResponse,
	DiscoveryPlan,
	DiscoveryStep,
	PlannedSkillCall,
	StepOutput,
} from './discovery-plan.js';
import {
	CYCLE_REVIEW_RESPONSE_SCHEMA,
	DISCOVERY_PLAN_SCHEMA,
	PROSE_REVIEW_RESPONSE_SCHEMA,
} from './discovery-plan.js';

const log = getLogger('content-gen:discovery-plan-actions');

const MAX_ATTEMPTS  = 3;
const DEFAULT_MAX_TOKENS = 3000;

// ---------------------------------------------------------------------------
// expandDiscoveryPlan
// ---------------------------------------------------------------------------

export interface ExpandDiscoveryPlanInput {
	readonly section:        PlannedAction;
	readonly tier:           ScopeSize;
	readonly cycle:          1 | 2 | 3;
	readonly cycleMemory:    CycleMemory;
	readonly repoSummary?:   string | undefined;
	readonly analyzerLabel?: string | undefined;
	readonly maxTokens?:     number | undefined;
}

/**
 * Expand a planned section into a DiscoveryPlan. Cloud picks
 * skills + provides semantic context; orchestrator fills in
 * authoritative arg schemas when forwarding each step to the
 * local LLM.
 *
 * Returns a fallback single-step plan if all attempts fail --
 * the orchestrator gets SOME plan so the loop doesn't dead-end.
 */
export async function expandDiscoveryPlan(
	input:         ExpandDiscoveryPlanInput,
	cloudProvider: LLMProvider,
): Promise<DiscoveryPlan> {
	const messages = buildExpandMessages(input);

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const response = await cloudProvider.complete(messages, {
				maxTokens:      input.maxTokens ?? DEFAULT_MAX_TOKENS,
				temperature:    0,
				responseFormat: { schema: DISCOVERY_PLAN_SCHEMA as Record<string, unknown> },
			});
			const parsed = parseJsonStrict(response.text);
			if (parsed === null) {
				if (attempt === MAX_ATTEMPTS) break;
				continue;
			}
			const validated = validateDiscoveryPlan(parsed, input.cycle);
			if (typeof validated === 'string') {
				log.info({ analyzer: input.analyzerLabel, attempt, reason: validated }, 'expandDiscoveryPlan: schema violation; retrying');
				if (attempt === MAX_ATTEMPTS) break;
				continue;
			}
			return validated;
		} catch (err) {
			log.warn({ analyzer: input.analyzerLabel, attempt, err: (err as Error).message }, 'expandDiscoveryPlan: provider error');
			if (attempt === MAX_ATTEMPTS) break;
		}
	}

	log.warn({ analyzer: input.analyzerLabel, sectionId: input.section.id, cycle: input.cycle }, 'expandDiscoveryPlan: all attempts failed -- emitting fallback single-step plan');
	return fallbackPlan(input);
}

function buildExpandMessages(input: ExpandDiscoveryPlanInput): LLMMessage[] {
	const system = loadFlowPrompt('discovery-expand', {
		TIER: normalizeTier(input.tier),
	});

	const userLines: string[] = [];
	userLines.push('## Section to expand');
	userLines.push(`title:     ${input.section.title}`);
	userLines.push(`objective: ${input.section.objective}`);
	userLines.push('');
	userLines.push('## Review criteria (the section must answer these)');
	input.section.reviewCriteria.forEach((c, i) => userLines.push(`  ${i}. ${c}`));
	userLines.push('');
	userLines.push(`## Cycle ${input.cycle} of 3`);
	const memorySummary = summarizeCycleMemory(input.cycleMemory);
	if (memorySummary.length > 0) {
		userLines.push('');
		userLines.push(memorySummary);
	}
	if (input.repoSummary !== undefined && input.repoSummary.trim().length > 0) {
		userLines.push('');
		userLines.push('## Repository under analysis');
		userLines.push(input.repoSummary);
	}
	userLines.push('');
	userLines.push('## Response schema');
	userLines.push('Your response MUST be strict JSON matching:');
	userLines.push('```json');
	userLines.push(JSON.stringify(DISCOVERY_PLAN_SCHEMA, null, 2));
	userLines.push('```');
	userLines.push('');
	userLines.push(`Set \`cycle: ${input.cycle}\` in your response.`);

	return [
		{ role: 'system', content: system },
		{ role: 'user',   content: userLines.join('\n') },
	];
}

function fallbackPlan(input: ExpandDiscoveryPlanInput): DiscoveryPlan {
	return {
		cycle: input.cycle,
		steps: [{
			id:               'step-fallback-1',
			intent:           `Investigate ${input.section.title} (fallback plan -- cloud planner failed)`,
			skills: [
				{
					id:      'sf.a',
					skillId: 'code.source.repo.describe',
					context: 'the active repo (no context resolution needed)',
				},
			],
			targetsCriteria: input.section.reviewCriteria.map((_, i) => i),
		}],
	};
}

// ---------------------------------------------------------------------------
// reviewCycle
// ---------------------------------------------------------------------------

export interface ReviewCycleInput {
	readonly section:        PlannedAction;
	readonly cycle:          1 | 2 | 3;
	readonly stepOutputs:    readonly StepOutput[];
	readonly cycleMemory:    CycleMemory;
	readonly analyzerLabel?: string | undefined;
	readonly maxTokens?:     number | undefined;
}

/**
 * Cloud reviews one cycle's step outputs + the CycleMemory. Returns
 * a CycleReviewResponse:
 *   - `keep`: stepIds the cloud trusts; orchestrator promotes those
 *     outputs to the retained ledger.
 *   - `new_steps`: discovery for the next cycle (empty = terminate).
 *   - `scratchpad`: optional carry-forward note.
 *
 * Fallback on all-attempts-fail: keep ALL outputs that had status
 * `ok`, no new_steps (terminates the loop). Lets the report ship
 * even if the cloud reviewer is broken.
 */
export async function reviewCycle(
	input:         ReviewCycleInput,
	cloudProvider: LLMProvider,
): Promise<CycleReviewResponse> {
	const messages = buildReviewMessages(input);

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const response = await cloudProvider.complete(messages, {
				maxTokens:      input.maxTokens ?? DEFAULT_MAX_TOKENS,
				temperature:    0,
				responseFormat: { schema: CYCLE_REVIEW_RESPONSE_SCHEMA as Record<string, unknown> },
			});
			const parsed = parseJsonStrict(response.text);
			if (parsed === null) {
				if (attempt === MAX_ATTEMPTS) break;
				continue;
			}
			const validated = validateCycleReview(parsed, input.stepOutputs);
			if (typeof validated === 'string') {
				log.info({ analyzer: input.analyzerLabel, attempt, reason: validated }, 'reviewCycle: schema violation; retrying');
				if (attempt === MAX_ATTEMPTS) break;
				continue;
			}
			return validated;
		} catch (err) {
			log.warn({ analyzer: input.analyzerLabel, attempt, err: (err as Error).message }, 'reviewCycle: provider error');
			if (attempt === MAX_ATTEMPTS) break;
		}
	}

	log.warn({ analyzer: input.analyzerLabel, sectionId: input.section.id, cycle: input.cycle }, 'reviewCycle: all attempts failed -- keep all ok outputs, terminate loop');
	return {
		keep:      input.stepOutputs.filter(o => o.status === 'ok').map(o => o.stepId),
		new_steps: [],
	};
}

function buildReviewMessages(input: ReviewCycleInput): LLMMessage[] {
	const system = loadFlowPrompt('discovery-review', {});

	const userLines: string[] = [];
	userLines.push('## Section under review');
	userLines.push(`title:     ${input.section.title}`);
	userLines.push(`objective: ${input.section.objective}`);
	userLines.push('');
	userLines.push('## Review criteria');
	input.section.reviewCriteria.forEach((c, i) => userLines.push(`  ${i}. ${c}`));
	userLines.push('');
	userLines.push(`## Cycle ${input.cycle} step outputs`);
	for (const out of input.stepOutputs) {
		userLines.push('');
		userLines.push(`### ${out.stepId}  (status: ${out.status}; duration: ${out.durationMs}ms)`);
		if (out.facts.length > 0) {
			userLines.push('facts:');
			for (const f of out.facts) userLines.push(`  - ${f}`);
		}
		if (out.citations.length > 0) {
			userLines.push('citations:');
			for (const c of out.citations) {
				const range = (c.startLine !== undefined && c.endLine !== undefined)
					? `#L${c.startLine}-L${c.endLine}`
					: (c.startLine !== undefined ? `#L${c.startLine}` : '');
				const label = c.label !== undefined ? ` (\`${c.label}\`)` : '';
				userLines.push(`  - ${c.path}${range}${label}`);
			}
		}
		if (out.extraSkillsCalled !== undefined && out.extraSkillsCalled.length > 0) {
			userLines.push(`extra skills called (beyond cloud plan): ${out.extraSkillsCalled.join(', ')}`);
		}
	}
	userLines.push('');
	const memorySummary = summarizeCycleMemory(input.cycleMemory);
	if (memorySummary.length > 0) {
		userLines.push(memorySummary);
		userLines.push('');
	}
	userLines.push('## Response schema');
	userLines.push('Your response MUST be strict JSON matching:');
	userLines.push('```json');
	userLines.push(JSON.stringify(CYCLE_REVIEW_RESPONSE_SCHEMA, null, 2));
	userLines.push('```');

	return [
		{ role: 'system', content: system },
		{ role: 'user',   content: userLines.join('\n') },
	];
}

// ---------------------------------------------------------------------------
// reviewProse (Stage 7)
// ---------------------------------------------------------------------------

export interface ReviewProseResponse {
	readonly verdict:  'accept' | 'redraft';
	readonly notes:    readonly string[];
}

export interface ReviewProseInput {
	readonly section:        PlannedAction;
	readonly prose:          string;
	readonly analyzerLabel?: string | undefined;
	readonly maxTokens?:     number | undefined;
}

/**
 * Final prose-only review. Sees the section markdown + section
 * objective + review criteria; does NOT see the retained ledger.
 *
 * Defaults to `accept` on all-attempts-fail -- the loop shouldn't
 * fail the report just because the final reviewer is flaky.
 */
export async function reviewProse(
	input:         ReviewProseInput,
	cloudProvider: LLMProvider,
): Promise<ReviewProseResponse> {
	const messages = buildProseReviewMessages(input);

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const response = await cloudProvider.complete(messages, {
				maxTokens:      input.maxTokens ?? 800,
				temperature:    0,
				responseFormat: { schema: PROSE_REVIEW_RESPONSE_SCHEMA as Record<string, unknown> },
			});
			const parsed = parseJsonStrict(response.text);
			if (parsed === null) {
				if (attempt === MAX_ATTEMPTS) break;
				continue;
			}
			const validated = validateProseReview(parsed);
			if (typeof validated === 'string') {
				log.info({ analyzer: input.analyzerLabel, attempt, reason: validated }, 'reviewProse: schema violation; retrying');
				if (attempt === MAX_ATTEMPTS) break;
				continue;
			}
			return validated;
		} catch (err) {
			log.warn({ analyzer: input.analyzerLabel, attempt, err: (err as Error).message }, 'reviewProse: provider error');
			if (attempt === MAX_ATTEMPTS) break;
		}
	}

	log.warn({ analyzer: input.analyzerLabel, sectionId: input.section.id }, 'reviewProse: all attempts failed -- soft-accepting');
	return { verdict: 'accept', notes: ['reviewer-degraded; soft-accepted'] };
}

function buildProseReviewMessages(input: ReviewProseInput): LLMMessage[] {
	const system = loadFlowPrompt('prose-review', {});

	const userLines: string[] = [];
	userLines.push('## Section under review');
	userLines.push(`title:     ${input.section.title}`);
	userLines.push(`objective: ${input.section.objective}`);
	userLines.push('');
	userLines.push('## Review criteria');
	input.section.reviewCriteria.forEach((c, i) => userLines.push(`  ${i}. ${c}`));
	userLines.push('');
	userLines.push('## Section prose (markdown)');
	userLines.push('```markdown');
	userLines.push(input.prose);
	userLines.push('```');
	userLines.push('');
	userLines.push('## Response schema');
	userLines.push('Your response MUST be strict JSON matching:');
	userLines.push('```json');
	userLines.push(JSON.stringify(PROSE_REVIEW_RESPONSE_SCHEMA, null, 2));
	userLines.push('```');

	return [
		{ role: 'system', content: system },
		{ role: 'user',   content: userLines.join('\n') },
	];
}

function validateProseReview(parsed: unknown): ReviewProseResponse | string {
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return 'response is not a JSON object';
	}
	const obj = parsed as Record<string, unknown>;
	const verdict = obj['verdict'];
	if (verdict !== 'accept' && verdict !== 'redraft') {
		return '`verdict` must be "accept" or "redraft"';
	}
	const notesRaw = obj['notes'];
	const notes: string[] = Array.isArray(notesRaw)
		? (notesRaw as unknown[]).filter((n): n is string => typeof n === 'string' && n.trim().length > 0).map(n => n.trim())
		: [];
	return { verdict, notes };
}

// ---------------------------------------------------------------------------
// Parsing + validation
// ---------------------------------------------------------------------------

function parseJsonStrict(raw: string): unknown {
	let s = raw.trim();
	if (s.startsWith('```')) {
		s = s.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
	}
	try { return JSON.parse(s); } catch { return null; }
}

function validateDiscoveryPlan(parsed: unknown, expectedCycle: 1 | 2 | 3): DiscoveryPlan | string {
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return 'response is not a JSON object';
	}
	const obj = parsed as Record<string, unknown>;
	const stepsRaw = obj['steps'];
	if (!Array.isArray(stepsRaw)) return '`steps` must be an array';
	if (stepsRaw.length === 0)    return '`steps` must be non-empty';
	const steps: DiscoveryStep[] = [];
	const seenIds = new Set<string>();
	for (let i = 0; i < stepsRaw.length; i++) {
		const s = validateStep(stepsRaw[i], i);
		if (typeof s === 'string') return s;
		if (seenIds.has(s.id)) return `\`steps[${i}].id\` "${s.id}" is duplicated`;
		seenIds.add(s.id);
		steps.push(s);
	}
	// `cycle` is required by schema; we override to expectedCycle so
	// the orchestrator's view stays canonical.
	void obj['cycle'];   // schema asserts; we don't strictly need to read it
	return { steps, cycle: expectedCycle };
}

function validateStep(raw: unknown, idx: number): DiscoveryStep | string {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return `\`steps[${idx}]\` is not an object`;
	const s = raw as Record<string, unknown>;
	const id     = typeof s['id']     === 'string' ? (s['id'] as string).trim()     : '';
	const intent = typeof s['intent'] === 'string' ? (s['intent'] as string).trim() : '';
	if (id.length === 0)     return `\`steps[${idx}].id\` is required`;
	if (intent.length === 0) return `\`steps[${idx}].intent\` is required`;
	const skillsRaw = s['skills'];
	if (!Array.isArray(skillsRaw) || skillsRaw.length === 0) return `\`steps[${idx}].skills\` must be a non-empty array`;
	const skills: PlannedSkillCall[] = [];
	for (let k = 0; k < skillsRaw.length; k++) {
		const sk = validateSkillCall(skillsRaw[k], idx, k);
		if (typeof sk === 'string') return sk;
		skills.push(sk);
	}
	const tcRaw = s['targetsCriteria'];
	if (!Array.isArray(tcRaw)) return `\`steps[${idx}].targetsCriteria\` must be an array`;
	const targetsCriteria: number[] = [];
	for (const t of tcRaw) {
		if (typeof t === 'number' && Number.isInteger(t) && t >= 0) targetsCriteria.push(t);
	}
	return { id, intent, skills, targetsCriteria };
}

function validateSkillCall(raw: unknown, stepIdx: number, callIdx: number): PlannedSkillCall | string {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return `\`steps[${stepIdx}].skills[${callIdx}]\` is not an object`;
	const c = raw as Record<string, unknown>;
	const id        = typeof c['id']        === 'string' ? (c['id']        as string).trim() : '';
	const skillId   = typeof c['skillId']   === 'string' ? (c['skillId']   as string).trim() : '';
	const context   = typeof c['context']   === 'string' ? (c['context']   as string).trim() : '';
	if (id.length === 0)      return `\`steps[${stepIdx}].skills[${callIdx}].id\` is required`;
	if (skillId.length === 0) return `\`steps[${stepIdx}].skills[${callIdx}].skillId\` is required`;
	if (context.length === 0) return `\`steps[${stepIdx}].skills[${callIdx}].context\` is required`;
	const out: { -readonly [K in keyof PlannedSkillCall]: PlannedSkillCall[K] } = { id, skillId, context };
	if (typeof c['dependsOn'] === 'string' && (c['dependsOn'] as string).trim().length > 0) {
		out.dependsOn = (c['dependsOn'] as string).trim();
	}
	return out;
}

function validateCycleReview(parsed: unknown, stepOutputs: readonly StepOutput[]): CycleReviewResponse | string {
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return 'response is not a JSON object';
	}
	const obj = parsed as Record<string, unknown>;
	const keepRaw = obj['keep'];
	if (!Array.isArray(keepRaw)) return '`keep` must be an array';
	const validIds = new Set(stepOutputs.map(o => o.stepId));
	const keep: string[] = [];
	for (const k of keepRaw) {
		if (typeof k === 'string' && validIds.has(k)) keep.push(k);
		// Silently drop unknown ids -- the cloud may hallucinate one;
		// we don't fail the whole review on a single bad id.
	}
	const newStepsRaw = obj['new_steps'];
	if (!Array.isArray(newStepsRaw)) return '`new_steps` must be an array (use [] to terminate)';
	const newSteps: DiscoveryStep[] = [];
	const seenStepIds = new Set<string>();
	for (let i = 0; i < newStepsRaw.length; i++) {
		const s = validateStep(newStepsRaw[i], i);
		if (typeof s === 'string') return `new_${s}`;
		if (seenStepIds.has(s.id))  return `\`new_steps[${i}].id\` "${s.id}" is duplicated`;
		seenStepIds.add(s.id);
		newSteps.push(s);
	}
	const result: { -readonly [K in keyof CycleReviewResponse]: CycleReviewResponse[K] } = { keep, new_steps: newSteps };
	if (typeof obj['scratchpad'] === 'string' && (obj['scratchpad'] as string).trim().length > 0) {
		result.scratchpad = (obj['scratchpad'] as string).trim();
	}
	return result;
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _validateDiscoveryPlanForTest = validateDiscoveryPlan;
export const _validateCycleReviewForTest   = validateCycleReview;
export const _validateProseReviewForTest   = validateProseReview;
export const _buildExpandMessagesForTest   = buildExpandMessages;
export const _buildReviewMessagesForTest   = buildReviewMessages;
export const _buildProseReviewMessagesForTest = buildProseReviewMessages;
export const _fallbackPlanForTest          = fallbackPlan;
