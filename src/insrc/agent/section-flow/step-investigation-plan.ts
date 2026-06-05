/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Step 2 -- Investigation plan (planner-section-task-separation P2).
 *
 * Produces the flat TODO list the per-TODO section orchestrator (P3)
 * will iterate over. Two paths:
 *
 *   - Fast path (Q4): when scope.isTrivial is true, emit a single-
 *     TODO plan deterministically -- no LLM call.
 *
 *   - General path: one LLM call producing 2-12 TODOs. The validator
 *     rejects degenerate plans (0 TODOs, >12 TODOs, empty objectives,
 *     near-duplicate objectives). One corrective retry on validation
 *     failure before throwing.
 *
 * The validator's de-dupe is a simple normalised-string comparison
 * (lowercase + collapse whitespace + drop punctuation). LLM planners
 * occasionally restate the same objective with a different surface
 * form ("review the data layer" vs "audit the data layer"); we accept
 * the first emission and drop the rest.
 *
 * Each emitted TodoSpec has `origin: 'initial'`. Mid-run TODOs added
 * by the report reviewer (Q7 `revise-structural`) carry origin
 * `'report-review-escalation'` and are appended by the orchestrator,
 * not this step.
 */

import type { LLMMessage, LLMProvider } from '../../shared/types.js';
import type { ScopeStepResult, TodoSpec, InvestigationPlanResult } from './types.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:investigation-plan');

const MIN_TODOS_NORMAL  = 1;
const MAX_TODOS         = 12;
const MAX_OBJECTIVE_LEN = 240;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InvestigationPlanInput {
	readonly question: string;
	readonly scope:    ScopeStepResult;
	readonly provider: LLMProvider;
}

export async function runInvestigationPlan(
	input: InvestigationPlanInput,
): Promise<InvestigationPlanResult> {
	if (input.scope.isTrivial) {
		const todo = buildTrivialTodo(input.question, input.scope);
		log.info({ scope: input.scope.scope, todoId: todo.id }, 'fast-path: emitted single-TODO plan');
		return {
			todos:      [todo],
			reasoning:  'fast-path: trivial scope + single contextRef -> single-TODO plan',
			isFastPath: true,
			retried:    false,
		};
	}

	const firstAttempt = await callPlanner(input.question, input.scope, input.provider, false);
	const firstValidation = validate(firstAttempt.todos);
	if (firstValidation.ok) {
		const todos = stampOrigin(firstValidation.todos);
		log.info({ count: todos.length }, 'planner: first-attempt plan validated');
		return {
			todos,
			reasoning:  firstAttempt.reasoning,
			isFastPath: false,
			retried:    false,
		};
	}
	log.warn({ reason: firstValidation.reason }, 'planner: first-attempt failed validation; retrying with corrective hint');

	const retry = await callPlanner(input.question, input.scope, input.provider, true, firstValidation.reason);
	const retryValidation = validate(retry.todos);
	if (!retryValidation.ok) {
		throw new Error(`investigation plan validation failed after retry: ${retryValidation.reason}`);
	}
	const todos = stampOrigin(retryValidation.todos);
	log.info({ count: todos.length }, 'planner: retry plan validated');
	return {
		todos,
		reasoning:  retry.reasoning,
		isFastPath: false,
		retried:    true,
	};
}

// ---------------------------------------------------------------------------
// Fast-path emission
// ---------------------------------------------------------------------------

function buildTrivialTodo(question: string, scope: ScopeStepResult): TodoSpec {
	const ref = scope.contextRefs[0];
	const objective = ref !== undefined
		? `Answer the user's question against ${ref.kind} \`${ref.value}\``
		: `Answer: ${truncate(question, MAX_OBJECTIVE_LEN)}`;
	return {
		id:        'todo-trivial',
		objective,
		origin:    'initial',
	};
}

// ---------------------------------------------------------------------------
// LLM planner call
// ---------------------------------------------------------------------------

interface PlannerResponse {
	readonly todos:     readonly { id?: string; objective: string }[];
	readonly reasoning: string;
}

async function callPlanner(
	question: string,
	scope: ScopeStepResult,
	provider: LLMProvider,
	isRetry: boolean,
	priorFailureReason?: string,
): Promise<PlannerResponse> {
	const messages: LLMMessage[] = [
		{ role: 'system', content: PLANNER_ROLE },
		{ role: 'user',   content: buildPlannerUser(question, scope, isRetry, priorFailureReason) },
	];
	const response = await provider.complete(messages, {
		maxTokens:       2048,
		temperature:     0,
		responseFormat:  'json',
		disableThinking: true,
	});
	return parseResponse(response.text);
}

const PLANNER_ROLE = [
	'You are the INVESTIGATION PLANNER for an agentic reporting system.',
	'Given a user question + a scope brief, you produce a FLAT list of',
	'TODOs the orchestrator will iterate over. Each TODO maps to one',
	'section in the final report. You emit a SINGLE JSON object with no',
	'prose, no markdown fences, no preamble.',
].join('\n');

function buildPlannerUser(
	question: string,
	scope: ScopeStepResult,
	isRetry: boolean,
	priorFailureReason: string | undefined,
): string {
	const contextRefsBlock = scope.contextRefs.length === 0
		? '(none surfaced by Step 1)'
		: scope.contextRefs.map(r => `- ${r.kind}: ${r.value}`).join('\n');

	const retryAddendum = isRetry
		? [
			'',
			'## RETRY CORRECTION',
			`Your previous plan failed validation: ${priorFailureReason ?? 'unknown'}`,
			'Fix the issue and emit a new plan that satisfies every rule below.',
			'',
		].join('\n')
		: '';

	return [
		'## USER QUESTION',
		question,
		'',
		'## SCOPE BRIEF',
		`tier:    ${scope.scope}`,
		`subtype: ${scope.subtype}`,
		`reasoning: ${scope.reasoning}`,
		'',
		'## CONTEXT REFS (concrete pointers the user surfaced)',
		contextRefsBlock,
		retryAddendum,
		'',
		'## OUTPUT SHAPE (emit EXACTLY this object)',
		'',
		'{',
		'  "todos": [',
		'    { "id": "<kebab-case-stable-id>", "objective": "<sentence>" }',
		'  ],',
		'  "reasoning": "<one sentence explaining the breakdown>"',
		'}',
		'',
		'## RULES',
		`  - Emit ${MIN_TODOS_NORMAL}-${MAX_TODOS} TODOs.`,
		'  - Each TODO covers ONE coherent investigation. Avoid umbrella TODOs that',
		'    span multiple distinct subjects -- split them.',
		'  - Avoid near-duplicate objectives (the validator rejects them).',
		`  - Each \`objective\` <= ${MAX_OBJECTIVE_LEN} characters.`,
		'  - Each `id` is a kebab-case string unique within this plan.',
		'  - The order is the order the orchestrator will execute. Earlier TODOs',
		'    should produce findings later TODOs can build on.',
		'',
		'## TASK',
		'Emit the JSON object now. Begin with "{" and end with "}".',
	].join('\n');
}

function parseResponse(raw: string): PlannerResponse {
	let text = raw.trim();
	if (text.startsWith('```')) {
		text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(`planner response: JSON parse failed: ${(err as Error).message}`);
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('planner response: not a JSON object');
	}
	const obj = parsed as Record<string, unknown>;
	const todosRaw = obj['todos'];
	const reasoning = typeof obj['reasoning'] === 'string' ? obj['reasoning'] : '';
	if (!Array.isArray(todosRaw)) {
		throw new Error('planner response: missing or non-array `todos` field');
	}
	const todos: { id?: string; objective: string }[] = [];
	for (const entry of todosRaw) {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
			continue;
		}
		const e = entry as Record<string, unknown>;
		const objective = typeof e['objective'] === 'string' ? e['objective'] : undefined;
		if (objective === undefined) {
			continue;
		}
		const id = typeof e['id'] === 'string' ? e['id'] : undefined;
		todos.push(id !== undefined ? { id, objective } : { objective });
	}
	return { todos, reasoning };
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

interface ValidationOk {
	readonly ok:    true;
	readonly todos: readonly { id: string; objective: string }[];
}

interface ValidationErr {
	readonly ok:     false;
	readonly reason: string;
}

type ValidationResult = ValidationOk | ValidationErr;

function validate(todos: readonly { id?: string; objective: string }[]): ValidationResult {
	if (todos.length < MIN_TODOS_NORMAL) {
		return { ok: false, reason: `at least ${MIN_TODOS_NORMAL} TODO required; got ${todos.length}` };
	}
	if (todos.length > MAX_TODOS) {
		return { ok: false, reason: `at most ${MAX_TODOS} TODOs allowed; got ${todos.length}` };
	}

	const usedIds = new Set<string>();
	const usedFingerprints = new Set<string>();
	const out: { id: string; objective: string }[] = [];

	for (let i = 0; i < todos.length; i++) {
		const t = todos[i]!;
		const objective = t.objective.trim();
		if (objective.length === 0) {
			return { ok: false, reason: `TODO ${i} has empty objective` };
		}
		if (objective.length > MAX_OBJECTIVE_LEN) {
			return { ok: false, reason: `TODO ${i} objective exceeds ${MAX_OBJECTIVE_LEN} chars` };
		}
		const fingerprint = fingerprintObjective(objective);
		if (usedFingerprints.has(fingerprint)) {
			return { ok: false, reason: `TODO ${i} ("${truncate(objective, 60)}") is a near-duplicate of an earlier objective` };
		}
		usedFingerprints.add(fingerprint);

		let id = t.id ?? deriveId(objective, i);
		id = normaliseId(id);
		if (id.length === 0) {
			id = `todo-${i + 1}`;
		}
		let candidate = id;
		let suffix = 2;
		while (usedIds.has(candidate)) {
			candidate = `${id}-${suffix}`;
			suffix++;
		}
		usedIds.add(candidate);
		out.push({ id: candidate, objective });
	}

	return { ok: true, todos: out };
}

/**
 * Normalised objective key for near-duplicate detection. Lowercase,
 * collapse whitespace, drop trailing punctuation. Two objectives with
 * the same fingerprint count as duplicates.
 */
function fingerprintObjective(objective: string): string {
	return objective
		.toLowerCase()
		.replace(/[^a-z0-9\s]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function deriveId(objective: string, index: number): string {
	const slug = objective
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	return slug.length > 0 ? slug : `todo-${index + 1}`;
}

function normaliseId(id: string): string {
	return id
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
}

function stampOrigin(todos: readonly { id: string; objective: string }[]): TodoSpec[] {
	return todos.map(t => ({ id: t.id, objective: t.objective, origin: 'initial' as const }));
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max) + '...';
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _validateForTest             = validate;
export const _fingerprintObjectiveForTest = fingerprintObjective;
export const _deriveIdForTest             = deriveId;
export const _normaliseIdForTest          = normaliseId;
export const _buildTrivialTodoForTest     = buildTrivialTodo;
export const _parseResponseForTest        = parseResponse;
export const MAX_TODOS_VALUE              = MAX_TODOS;
export const MAX_OBJECTIVE_LEN_VALUE      = MAX_OBJECTIVE_LEN;
