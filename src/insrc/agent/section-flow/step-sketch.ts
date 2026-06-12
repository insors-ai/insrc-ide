/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Sketch caller -- Phase 4 of plans/section-flow-architecture-redesign.md.
 *
 * `runSketch` is the cloud-tier turn that runs ONCE per TODO, right after
 * the fact-gap analysis. It emits a 3-5 step default trajectory the
 * dynamic decide-next-step loop follows when nothing surprises it.
 *
 * Validation:
 *   - 1 to 5 steps (the prompt teaches 3-5 but a 1-2 step sketch for a
 *     trivial TODO is still acceptable).
 *   - Every `id` unique within the sketch (step-1, step-2, ...).
 *   - Every `skills[].skillId` is in the catalog.
 *   - `targetsCriteria` non-empty, indices in [0, maxFactIdx].
 *   - `dependsOn` follows the shared validator (intra-sketch s1.a OR
 *     cross-sketch step-1.s1.a forms).
 *
 * Bad entries are DROPPED with a log warning (mirrors discovery-plan-
 * expansion's permissive policy); a sketch that ends up empty after
 * coercion triggers the orchestrator's L2 fallback path.
 *
 * Retry: one corrective hint on parse/shape failure. Second failure
 * throws -- the orchestrator catches it and routes to L2.
 */

import type { CatalogSkill } from '../content-gen/plan-tree-runner.js';
import type { DiscoveryStep } from '../content-gen/discovery-plan.js';
import { walkLeaves } from '../content-gen/discovery-plan.js';
import type { LLMMessage, LLMProvider } from '../../shared/types.js';
import type { CloudMemoryView } from '../working-memory/index.js';
import type { RequiredFact } from './fact-gap-types.js';
import type { TodoSpec } from './types.js';
import { coerceStep } from './step-validators.js';
import type { SketchWriterInput } from '../prompts/writers/sketch.js';
import { getPromptRegistry } from '../prompts/registry.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:sketch');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SketchInput {
	readonly todo:     TodoSpec;
	readonly gapFacts: readonly RequiredFact[];
	readonly catalog: readonly CatalogSkill[];
	readonly memory?: CloudMemoryView | undefined;
	readonly provider: LLMProvider;
}

export interface SketchResult {
	readonly steps:         readonly DiscoveryStep[];
	readonly retried:       boolean;
	readonly droppedStepIds: readonly string[];
	readonly firstFailureReason?: string | undefined;
}

const MAX_TOKENS = 2048;
const MAX_STEPS = 5;

export async function runSketch(input: SketchInput): Promise<SketchResult> {
	const catalogIds = new Set(input.catalog.map(c => c.id));
	const maxFactIdx = Math.max(0, input.gapFacts.length - 1);

	const first = await callSketch(input, false, undefined);
	const firstResult = parseAndCoerce(first, catalogIds, maxFactIdx);
	if (firstResult.ok) {
		log.info({
			todoId: input.todo.id,
			stepCount: firstResult.steps.length,
			droppedSteps: firstResult.droppedStepIds.length,
		}, 'sketch: first-attempt validated');
		return {
			steps:          firstResult.steps,
			retried:        false,
			droppedStepIds: firstResult.droppedStepIds,
		};
	}

	log.warn({
		todoId: input.todo.id, reason: firstResult.reason,
	}, 'sketch: first-attempt rejected; retrying with corrective hint');

	const retry = await callSketch(input, true, firstResult.reason);
	const retryResult = parseAndCoerce(retry, catalogIds, maxFactIdx);
	if (!retryResult.ok) {
		throw new Error(`sketch validation failed after retry: ${retryResult.reason}`);
	}
	log.info({
		todoId: input.todo.id,
		stepCount: retryResult.steps.length,
		droppedSteps: retryResult.droppedStepIds.length,
	}, 'sketch: retry validated');
	return {
		steps:              retryResult.steps,
		retried:            true,
		droppedStepIds:     retryResult.droppedStepIds,
		firstFailureReason: firstResult.reason,
	};
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callSketch(
	input:              SketchInput,
	isRetry:            boolean,
	priorFailureReason: string | undefined,
): Promise<string> {
	const writer = getPromptRegistry().get<SketchWriterInput, readonly LLMMessage[]>('sketch');
	const messages = [...writer.build({
		todo:               input.todo,
		gapFacts:           input.gapFacts,
		catalog:            input.catalog,
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
// Parse + coerce
// ---------------------------------------------------------------------------

interface ParseOk {
	readonly ok:             true;
	readonly steps:          readonly DiscoveryStep[];
	readonly droppedStepIds: readonly string[];
}
interface ParseErr {
	readonly ok:     false;
	readonly reason: string;
}
type ParseResult = ParseOk | ParseErr;

function parseAndCoerce(
	raw:        string,
	catalogIds: ReadonlySet<string>,
	maxFactIdx: number,
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
	const stepsRaw = obj['steps'];
	if (!Array.isArray(stepsRaw)) {
		return { ok: false, reason: '`steps` must be an array' };
	}
	if (stepsRaw.length === 0) {
		return { ok: false, reason: '`steps` is empty; a sketch needs at least one step' };
	}
	if (stepsRaw.length > MAX_STEPS) {
		return { ok: false, reason: `\`steps\` has ${stepsRaw.length} entries; cap is ${MAX_STEPS}` };
	}
	const steps: DiscoveryStep[] = [];
	const droppedStepIds: string[] = [];
	const seenIds = new Set<string>();
	// earlierStepSkills is built incrementally so later cross-step
	// dependsOn (`step-1.s1.a`) can resolve.
	const earlierStepSkills = new Map<string, ReadonlySet<string>>();
	for (let i = 0; i < stepsRaw.length; i++) {
		const sRaw = stepsRaw[i];
		if (sRaw === null || typeof sRaw !== 'object' || Array.isArray(sRaw)) {
			log.warn({ idx: i }, 'sketch: dropping steps entry that is not an object');
			droppedStepIds.push(`<idx-${i}>`);
			continue;
		}
		const coerced = coerceStep(sRaw as Record<string, unknown>, i, catalogIds, maxFactIdx, earlierStepSkills);
		if (typeof coerced === 'string') {
			log.warn({ idx: i, reason: coerced }, 'sketch: dropping steps entry');
			const rawId = (sRaw as Record<string, unknown>)['id'];
			droppedStepIds.push(typeof rawId === 'string' ? rawId : `<idx-${i}>`);
			continue;
		}
		if (seenIds.has(coerced.id)) {
			log.warn({ idx: i, id: coerced.id }, 'sketch: dropping duplicate step id');
			droppedStepIds.push(coerced.id);
			continue;
		}
		seenIds.add(coerced.id);
		// Track skill ids across the whole step tree so cross-step
		// `dependsOn` validation in later sketch entries (and in
		// decide-next-step) can resolve references to skills declared
		// inside a branch's leaves.
		const allSkillIds = new Set<string>();
		for (const leaf of walkLeaves(coerced)) {
			for (const sk of leaf.skills) { allSkillIds.add(sk.id); }
		}
		earlierStepSkills.set(coerced.id, allSkillIds);
		steps.push(coerced);
	}
	if (steps.length === 0) {
		return { ok: false, reason: 'every sketch entry failed coercion; nothing usable' };
	}
	return { ok: true, steps, droppedStepIds };
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

export const _parseAndCoerceForTest = parseAndCoerce;
export const _stripFencesForTest    = stripFences;
export const _MAX_STEPS              = MAX_STEPS;
