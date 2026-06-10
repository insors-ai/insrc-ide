/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Stage 0 of the fact-gap-driven task loop -- Phase beta of
 * plans/section-flow-fact-gap-loop.md.
 *
 * One LLM call per TODO. Takes the TODO objective + the accumulated
 * working-memory bundle + a catalog summary, returns a `FactGapAnalysis`
 * enumerating the facts the TODO needs and their availability status.
 *
 * The downstream stages target only the `absent` and `partial` facts:
 *
 *   - Stage 1 (discovery-plan expansion) plans discovery steps for
 *     the gap subset
 *   - Stage 3 (cycle review) tracks coverage of the full required-fact
 *     list as it accumulates the retained ledger
 *   - Stage 6 (synthesis) renders structured handoff blocks for any
 *     facts still absent at loop termination
 *
 * Trivial fast-path: when every required fact is `present`, the
 * orchestrator skips Stages 1-5 entirely and goes straight to
 * synthesis with just the memory bundle as evidence.
 *
 * Retry policy: 1 corrective on JSON schema violation or missing
 * required fields. Second failure throws (Q9-recoverable; the TODO
 * orchestrator's L2 fallback takes over).
 */

import type { CatalogSkill } from '../content-gen/plan-tree-runner.js';
import type { LLMMessage, LLMProvider } from '../../shared/types.js';
import type { CloudMemoryView } from '../working-memory/index.js';
import type { TodoSpec } from './types.js';
import type { FactGapAnalysis, RequiredFact } from './fact-gap-types.js';
import { FACT_GAP_ANALYSIS_SCHEMA } from './fact-gap-types.js';
import { getLogger } from '../../shared/logger.js';
import { getPromptRegistry } from '../prompts/registry.js';
import type { FactGapAnalysisWriterInput } from '../prompts/writers/fact-gap-analysis.js';

const log = getLogger('section-flow:fact-gap-analysis');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FactGapAnalysisInput {
	readonly todo:     TodoSpec;
	readonly memory:   CloudMemoryView;
	/**
	 * Skill catalog summarised for Stage 0 -- id + description per
	 * skill, NO input schemas (those are injected at execute time by
	 * the shape-resolver). Stage 0 uses this only to suggest skills
	 * for absent facts; suggestions are advisory for Stage 1.
	 */
	readonly catalog:  readonly CatalogSkill[];
	readonly provider: LLMProvider;
}

export interface FactGapAnalysisResult {
	readonly analysis: FactGapAnalysis;
	readonly retried:  boolean;
	/** First-attempt failure reason (telemetry; undefined when first pass succeeded). */
	readonly firstFailureReason?: string | undefined;
}

// Bumped from 2048 to 4096 after the first live IDE run on the
// epsilon cutover hit truncation at ~7400 chars on the warmest TODO.
// The schema's caps (12 facts * (200 fact + 300 why + 6 suggestions * 80 chars))
// can hit ~12k chars in the pathological case; 4096 tokens leaves
// ~10-12k chars at 3 chars/token, which fits even the warmest TODO.
const MAX_ANALYSIS_TOKENS = 4096;

export async function runFactGapAnalysis(
	input: FactGapAnalysisInput,
): Promise<FactGapAnalysisResult> {
	const catalogIds = new Set(input.catalog.map(c => c.id));

	const firstAttempt = await callAnalyzer(input, false, undefined);
	const firstValidation = validate(firstAttempt.raw, catalogIds);
	if (firstValidation.ok) {
		log.info({
			todoId:        input.todo.id,
			factCount:     firstValidation.analysis.requiredFacts.length,
			absentCount:   firstValidation.analysis.requiredFacts.filter(f => f.status === 'absent').length,
			partialCount:  firstValidation.analysis.requiredFacts.filter(f => f.status === 'partial').length,
			presentCount:  firstValidation.analysis.requiredFacts.filter(f => f.status === 'present').length,
		}, 'fact-gap analysis: first-attempt validated');
		return { analysis: firstValidation.analysis, retried: false };
	}

	log.warn({ todoId: input.todo.id, reason: firstValidation.reason }, 'fact-gap analysis: first-attempt rejected; retrying with corrective hint');

	const retry = await callAnalyzer(input, true, firstValidation.reason);
	const retryValidation = validate(retry.raw, catalogIds);
	if (!retryValidation.ok) {
		throw new Error(`fact-gap analysis validation failed after retry: ${retryValidation.reason}`);
	}
	log.info({ todoId: input.todo.id, factCount: retryValidation.analysis.requiredFacts.length }, 'fact-gap analysis: retry validated');
	return {
		analysis: retryValidation.analysis,
		retried:  true,
		firstFailureReason: firstValidation.reason,
	};
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

interface AnalyzerRaw {
	readonly raw: string;
}

async function callAnalyzer(
	input:              FactGapAnalysisInput,
	isRetry:            boolean,
	priorFailureReason: string | undefined,
): Promise<AnalyzerRaw> {
	const writer = getPromptRegistry().get<FactGapAnalysisWriterInput, readonly LLMMessage[]>('fact-gap-analysis');
	const messages = [...writer.build({
		todo:               input.todo,
		memory:             input.memory,
		catalog:            input.catalog,
		isRetry,
		priorFailureReason,
	})];
	const response = await input.provider.complete(messages, {
		maxTokens:       MAX_ANALYSIS_TOKENS,
		temperature:     0,
		responseFormat:  { schema: FACT_GAP_ANALYSIS_SCHEMA },
		disableThinking: true,
	});
	return { raw: response.text };
}

// NOTE: the inline ANALYZER_ROLE + buildAnalyzerUser + renderMemory +
// renderCatalogSummary that used to live here were Phase 0 cruft --
// the prompt now lives in `agent/prompts/writers/fact-gap-analysis.ts`
// and is fetched through the PromptRegistry. Phase 6 batch 6.1 deleted
// the leftover bodies along with the CloudMemoryView migration.

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidationOk {
	readonly ok:       true;
	readonly analysis: FactGapAnalysis;
}

interface ValidationErr {
	readonly ok:     false;
	readonly reason: string;
}

type ValidationResult = ValidationOk | ValidationErr;

function validate(raw: string, catalogIds: ReadonlySet<string>): ValidationResult {
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

	// `reasoning` is telemetry only -- the orchestrator never reads it.
	// qwen3.6 (and other local models) routinely drop the field even
	// when the prompt asks for it explicitly. Don't fail the analysis
	// over a missing field that nothing downstream consumes; default to
	// a placeholder and let validation continue.
	const reasoning = typeof obj['reasoning'] === 'string' && obj['reasoning'].trim().length > 0
		? obj['reasoning'].trim()
		: '(no reasoning emitted)';

	const factsRaw = obj['requiredFacts'];
	if (!Array.isArray(factsRaw)) {
		return { ok: false, reason: '`requiredFacts` must be an array' };
	}
	if (factsRaw.length === 0) {
		return { ok: false, reason: '`requiredFacts` must have at least one entry' };
	}
	if (factsRaw.length > 12) {
		return { ok: false, reason: `requiredFacts has ${factsRaw.length} entries; cap is 12` };
	}

	const seenIds = new Set<string>();
	const facts: RequiredFact[] = [];
	for (let i = 0; i < factsRaw.length; i++) {
		const f = factsRaw[i];
		if (f === null || typeof f !== 'object' || Array.isArray(f)) {
			return { ok: false, reason: `requiredFacts[${i}] is not an object` };
		}
		const factObj = f as Record<string, unknown>;
		const factCheck = coerceRequiredFact(factObj, i, catalogIds);
		if (typeof factCheck === 'string') {
			return { ok: false, reason: factCheck };
		}
		if (seenIds.has(factCheck.id)) {
			return { ok: false, reason: `requiredFacts[${i}].id "${factCheck.id}" duplicates an earlier fact` };
		}
		seenIds.add(factCheck.id);
		facts.push(factCheck);
	}

	return { ok: true, analysis: { requiredFacts: facts, reasoning } };
}

function coerceRequiredFact(
	raw:        Record<string, unknown>,
	idx:        number,
	catalogIds: ReadonlySet<string>,
): RequiredFact | string {
	const id = typeof raw['id'] === 'string' ? raw['id'].trim() : '';
	if (id.length === 0) {
		return `requiredFacts[${idx}].id missing or empty`;
	}
	const fact = typeof raw['fact'] === 'string' ? raw['fact'].trim() : '';
	if (fact.length === 0) {
		return `requiredFacts[${idx}].fact missing or empty`;
	}
	const why = typeof raw['why'] === 'string' ? raw['why'].trim() : '';
	if (why.length === 0) {
		return `requiredFacts[${idx}].why missing or empty`;
	}
	const statusRaw = raw['status'];
	if (statusRaw !== 'present' && statusRaw !== 'partial' && statusRaw !== 'absent') {
		return `requiredFacts[${idx}].status must be one of present|partial|absent (got ${String(statusRaw)})`;
	}
	const status = statusRaw;

	// sourceRef -- required for present / partial; optional for absent
	let sourceRef: RequiredFact['sourceRef'];
	const srRaw = raw['sourceRef'];
	if (srRaw !== undefined && srRaw !== null) {
		if (typeof srRaw !== 'object' || Array.isArray(srRaw)) {
			return `requiredFacts[${idx}].sourceRef must be an object`;
		}
		const sr = srRaw as Record<string, unknown>;
		const kind = sr['kind'];
		if (kind !== 'memory-layer' && kind !== 'prior-todo') {
			return `requiredFacts[${idx}].sourceRef.kind must be memory-layer or prior-todo`;
		}
		const built: { -readonly [K in keyof NonNullable<RequiredFact['sourceRef']>]: NonNullable<RequiredFact['sourceRef']>[K] } = { kind };
		if (kind === 'memory-layer') {
			const layer = sr['layer'];
			if (layer === 'summary' || layer === 'recent' || layer === 'semantic' || layer === 'code') {
				built.layer = layer;
			}
		}
		if (kind === 'prior-todo') {
			const todoId = typeof sr['todoId'] === 'string' ? sr['todoId'].trim() : '';
			if (todoId.length === 0) {
				return `requiredFacts[${idx}].sourceRef.todoId missing for prior-todo`;
			}
			built.todoId = todoId;
		}
		if (typeof sr['excerpt'] === 'string') {
			built.excerpt = sr['excerpt'].trim().slice(0, 200);
		}
		sourceRef = built;
	}
	if ((status === 'present' || status === 'partial') && sourceRef === undefined) {
		return `requiredFacts[${idx}] status=${status} requires sourceRef`;
	}

	// suggestedSkills -- catalog membership check; only fail when ALL are unknown
	let suggestedSkills: readonly string[] | undefined;
	const sugRaw = raw['suggestedSkills'];
	if (Array.isArray(sugRaw)) {
		const ids = sugRaw
			.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
			.map(s => s.trim());
		if (ids.length > 0) {
			const known = ids.filter(s => catalogIds.has(s));
			if (known.length === 0 && status === 'absent') {
				return `requiredFacts[${idx}] suggestedSkills [${ids.join(', ')}] none in catalog; pick from the SKILL CATALOG section`;
			}
			if (known.length > 0) {
				suggestedSkills = known;
			}
		}
	}

	return {
		id, fact, why, status,
		...(sourceRef       !== undefined ? { sourceRef }       : {}),
		...(suggestedSkills !== undefined ? { suggestedSkills } : {}),
	};
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

export const _validateForTest               = validate;
export const _coerceRequiredFactForTest     = coerceRequiredFact;
export const _stripFencesForTest            = stripFences;
