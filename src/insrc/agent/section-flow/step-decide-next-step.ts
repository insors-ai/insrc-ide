/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * decide-next-step caller -- Phase 4 of
 * plans/section-flow-architecture-redesign.md.
 *
 * The cloud-tier turn at the heart of the dynamic orchestrator loop.
 * Runs ONCE per iteration. Validates the LLM's response against:
 *
 *   - `action` is one of `execute-step` / `replan-sketch` / `terminate`.
 *   - On `execute-step`: the embedded `step` validates via the shared
 *     `coerceStep` (same path used by sketch + cycle-review).
 *   - On `terminate`: `verdict` is `covered` or `unrecoverable`.
 *   - `lastStepArtifactSummary` is a `{ callId: summary }` object;
 *     callIds are verified against the most-recently-executed step's
 *     declared call ids. Unknown callIds dropped with warn.
 *
 * Retry: one corrective hint on parse/shape failure. Second failure
 * throws -- the orchestrator catches it and routes the iteration to
 * its safety path.
 *
 * Lenient on `lastStepArtifactSummary` -- a malformed entry doesn't
 * abort the iteration; the missing summary degrades to the structural
 * fallback per Phase 1's graceful-degrade contract.
 */

import type { CatalogSkill } from '../content-gen/plan-tree-runner.js';
import type { DiscoveryStep } from '../content-gen/discovery-plan.js';
import type { LLMMessage, LLMProvider } from '../../shared/types.js';
import type { CloudMemoryView } from '../working-memory/index.js';
import type { RequiredFact } from './fact-gap-types.js';
import type { TodoSpec } from './types.js';
import { coerceStep } from './step-validators.js';
import type {
	DecideLastStepRawOutputs,
	DecideNextStepWriterInput,
	DecidePriorAttempt,
} from '../prompts/writers/decide-next-step.js';
import { getPromptRegistry } from '../prompts/registry.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:decide-next-step');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type DecideAction = 'execute-step' | 'replan-sketch' | 'terminate';
export type TerminateVerdict = 'covered' | 'unrecoverable';

export interface DecideNextStepInput {
	readonly todo:     TodoSpec;
	readonly gapFacts: readonly RequiredFact[];
	readonly sketch:   readonly DiscoveryStep[];
	readonly catalog:  readonly CatalogSkill[];
	readonly toc:      string;
	readonly lastStep: DecideLastStepRawOutputs | undefined;
	/**
	 * Every step executed for this TODO so far, with skill ids + step-
	 * level status. Surfaced in the writer's PRIOR ATTEMPTS block so
	 * the model can see "we already tried this skill and it returned
	 * empty" without inferring from `lastStep` alone. Empty / undefined
	 * on the first turn.
	 */
	readonly priorAttempts?: readonly DecidePriorAttempt[] | undefined;
	readonly memory?:  CloudMemoryView | undefined;
	readonly provider: LLMProvider;
}

/**
 * Reviewer-emitted summary for each call in the last step.
 * Empty when there was no last step (first iteration) OR the LLM
 * skipped the field. Keys are the last step's declared call ids;
 * unknown keys are dropped during parse.
 */
export type LastStepSummaries = Readonly<Record<string, string>>;

/**
 * The decided action + its action-specific payload, before the
 * retry/telemetry metadata gets folded in. Phase 4 of
 * plans/section-flow-architecture-redesign.md.
 */
export type DecidedAction =
	| { readonly action: 'execute-step';  readonly step: DiscoveryStep; readonly reasoning: string; readonly lastStepSummaries: LastStepSummaries }
	| { readonly action: 'replan-sketch'; readonly reasoning: string; readonly lastStepSummaries: LastStepSummaries }
	| { readonly action: 'terminate';     readonly verdict: TerminateVerdict; readonly reasoning: string; readonly lastStepSummaries: LastStepSummaries };

export type DecideNextStepResult = DecidedAction & {
	readonly retried:             boolean;
	readonly firstFailureReason?: string | undefined;
};

const MAX_TOKENS = 3072;

export async function runDecideNextStep(input: DecideNextStepInput): Promise<DecideNextStepResult> {
	const catalogIds = new Set(input.catalog.map(c => c.id));
	const maxFactIdx = Math.max(0, input.gapFacts.length - 1);
	const lastStepCallIds = input.lastStep === undefined
		? new Set<string>()
		: new Set(input.lastStep.skills.map(s => s.callId));

	const first = await callDecider(input, false, undefined);
	const firstResult = parse(first, catalogIds, maxFactIdx, lastStepCallIds);
	if (firstResult.ok) {
		log.info({
			todoId: input.todo.id, action: firstResult.value.action,
			summaryCount: Object.keys(firstResult.value.lastStepSummaries).length,
		}, 'decide-next-step: first-attempt validated');
		return { ...firstResult.value, retried: false };
	}

	log.warn({ todoId: input.todo.id, reason: firstResult.reason }, 'decide-next-step: first-attempt rejected; retrying with corrective hint');

	const retry = await callDecider(input, true, firstResult.reason);
	const retryResult = parse(retry, catalogIds, maxFactIdx, lastStepCallIds);
	if (!retryResult.ok) {
		throw new Error(`decide-next-step validation failed after retry: ${retryResult.reason}`);
	}
	log.info({ todoId: input.todo.id, action: retryResult.value.action }, 'decide-next-step: retry validated');
	return { ...retryResult.value, retried: true, firstFailureReason: firstResult.reason };
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callDecider(
	input:              DecideNextStepInput,
	isRetry:            boolean,
	priorFailureReason: string | undefined,
): Promise<string> {
	const writer = getPromptRegistry().get<DecideNextStepWriterInput, readonly LLMMessage[]>('decide-next-step');
	const messages = [...writer.build({
		todo:               input.todo,
		gapFacts:           input.gapFacts,
		sketch:             input.sketch,
		catalog:            input.catalog,
		toc:                input.toc,
		lastStep:           input.lastStep,
		priorAttempts:      input.priorAttempts,
		memory:             input.memory,
		isRetry,
		priorFailureReason,
	})];
	const response = await input.provider.complete(messages, {
		maxTokens:       MAX_TOKENS,
		temperature:     0,
		responseFormat:  'json',
		disableThinking: true,
	});
	return response.text;
}

// ---------------------------------------------------------------------------
// Parse + validate
// ---------------------------------------------------------------------------

interface ParseOk {
	readonly ok:    true;
	readonly value: DecidedAction;
}
interface ParseErr {
	readonly ok:     false;
	readonly reason: string;
}
type ParseResult = ParseOk | ParseErr;

export function parse(
	raw:              string,
	catalogIds:       ReadonlySet<string>,
	maxFactIdx:       number,
	lastStepCallIds:  ReadonlySet<string>,
): ParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripFences(raw));
	} catch (err) {
		return { ok: false, reason: `JSON parse failed: ${(err as Error).message}` };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, reason: 'response is not a JSON object' };
	}
	const obj = parsed as Record<string, unknown>;

	const actionRaw = obj['action'];
	if (typeof actionRaw !== 'string') {
		return { ok: false, reason: '`action` must be a string' };
	}
	const action = actionRaw.trim();
	if (action !== 'execute-step' && action !== 'replan-sketch' && action !== 'terminate') {
		return { ok: false, reason: `\`action\` "${action}" is not one of execute-step / replan-sketch / terminate` };
	}

	const reasoning = typeof obj['reasoning'] === 'string' ? obj['reasoning'].trim() : '';
	if (reasoning.length === 0) {
		return { ok: false, reason: '`reasoning` must be a non-empty string' };
	}

	const lastStepSummaries = extractLastStepSummaries(obj['lastStepArtifactSummary'], lastStepCallIds);

	if (action === 'execute-step') {
		const stepRaw = obj['step'];
		if (stepRaw === null || typeof stepRaw !== 'object' || Array.isArray(stepRaw)) {
			return { ok: false, reason: '`step` must be an object when action="execute-step"' };
		}
		// Empty earlier-step map -- decide-next-step's emitted step is
		// the next one to run, not a multi-step dependency target.
		const coerced = coerceStep(stepRaw as Record<string, unknown>, 0, catalogIds, maxFactIdx, new Map());
		if (typeof coerced === 'string') {
			return { ok: false, reason: `\`step\` failed validation: ${coerced}` };
		}
		return {
			ok: true,
			value: {
				action: 'execute-step',
				step:   coerced,
				reasoning,
				lastStepSummaries,
			},
		};
	}

	if (action === 'replan-sketch') {
		return {
			ok: true,
			value: {
				action: 'replan-sketch',
				reasoning,
				lastStepSummaries,
			},
		};
	}

	// action === 'terminate'
	const verdictRaw = obj['verdict'];
	if (typeof verdictRaw !== 'string') {
		return { ok: false, reason: '`verdict` must be a string when action="terminate"' };
	}
	const verdict = verdictRaw.trim();
	if (verdict !== 'covered' && verdict !== 'unrecoverable') {
		return { ok: false, reason: `\`verdict\` "${verdict}" is not "covered" or "unrecoverable"` };
	}
	return {
		ok: true,
		value: {
			action: 'terminate',
			verdict: verdict as TerminateVerdict,
			reasoning,
			lastStepSummaries,
		},
	};
}

/**
 * Pull `lastStepArtifactSummary` from the raw response. Lenient on
 * every axis: missing / non-object / unknown-callId / non-string
 * values are silently dropped (or returned as empty), so the
 * iteration never aborts on summary issues. Phase 1 of
 * plans/section-flow-architecture-redesign.md.
 */
export function extractLastStepSummaries(
	raw:             unknown,
	lastStepCallIds: ReadonlySet<string>,
): LastStepSummaries {
	if (raw === undefined || raw === null) { return {}; }
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		log.warn({}, 'decide-next-step: lastStepArtifactSummary is not a JSON object; ignoring');
		return {};
	}
	const out: Record<string, string> = {};
	for (const [callId, valueRaw] of Object.entries(raw as Record<string, unknown>)) {
		if (lastStepCallIds.size > 0 && !lastStepCallIds.has(callId)) {
			log.warn({ callId }, 'decide-next-step: lastStepArtifactSummary callId not declared in the last step; dropping');
			continue;
		}
		if (typeof valueRaw !== 'string') { continue; }
		const trimmed = valueRaw.trim();
		if (trimmed.length === 0) { continue; }
		out[callId] = trimmed;
	}
	return out;
}

function stripFences(text: string): string {
	let out = text.trim();
	if (out.startsWith('```')) {
		out = out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
	}
	return out.trim();
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _parseForTest                    = parse;
export const _stripFencesForTest              = stripFences;
export const _extractLastStepSummariesForTest = extractLastStepSummaries;
