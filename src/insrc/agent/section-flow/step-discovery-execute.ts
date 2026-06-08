/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Stage 2 of the fact-gap-driven task loop -- Phase delta of
 * plans/section-flow-fact-gap-loop.md.
 *
 * Adapts a `DiscoveryStep` (a multi-skill investigation) into a series
 * of leaf invocations + a structured `StepOutput`. For each
 * `PlannedSkillCall` in the step:
 *
 *   1. Synthesise a leaf `PlannedNode` (skill + objective + empty
 *      inputs) and dispatch it through the existing `leaf-executor`
 *      (shape-resolver + runSkill + stringify).
 *   2. If the leaf returned non-empty, run `summarizeResult` against
 *      the raw text to extract structured facts + citations.
 *   3. Stash the raw result under the call's `id` so subsequent calls
 *      in the same step can wire from it via `dependsOn` (the shape-
 *      resolver gets a merged priorOutputs map of step-level + skill-
 *      level outputs).
 *
 * Final `StepOutput.status` is derived mechanically:
 *   - `failed`  : all calls returned empty
 *   - `partial` : some calls returned empty
 *   - `ok`      : every call returned non-empty
 *
 * No retry logic at this level -- the shape-resolver and the
 * summarizer each have their own retry; the discovery executor
 * just dispatches and aggregates. Per-call failures don't abort
 * the step; they downgrade its status.
 *
 * The skill catalog's `PlannedSkillCall` validator (Stage 1) already
 * ensures `dependsOn` references earlier-declared call ids within
 * the same step, so we can iterate the `skills` array in order
 * without a topological sort -- the array IS the execution order.
 */

import type { Citation, DiscoveryStep, PlannedSkillCall, StepOutput } from '../content-gen/discovery-plan.js';
import type { PlannedNode } from '../content-gen/plan-tree.js';
import type { ExecuteLeaf } from './leaf-executor.js';
import type { LLMProvider } from '../../shared/types.js';
import type { RequiredFact } from './fact-gap-types.js';
import type { TodoSpec } from './types.js';
import { summarizeResult, type EvidenceEntry } from '../tasks/code-analyzer/summarize-result.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:discovery-execute');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DiscoveryExecuteDeps {
	readonly todo:               TodoSpec;
	/**
	 * The gap-facts the cycle is targeting. The summarizer uses these
	 * as `criteria` so it can score on-topic-ness against the right
	 * coverage axis.
	 */
	readonly gapFacts:           readonly RequiredFact[];
	/** Leaf-executor closure (built by the orchestrator via `buildSkillExecutor`). */
	readonly executeLeaf:        ExecuteLeaf;
	/**
	 * Provider for the per-result summarization call. Same provider
	 * the rest of the section-flow uses (`sectionFlowProvider`); kept
	 * separate from the leaf-executor's shape-resolve provider for
	 * clarity, even though they're the same instance in production.
	 */
	readonly summarizeProvider:  LLMProvider;
}

export interface ExecuteDiscoveryStepInput {
	readonly step:          DiscoveryStep;
	/**
	 * Outputs from prior cycles' retained ledger, keyed by stepId.
	 * Merged with this step's in-progress skill outputs (keyed by
	 * skill call id) before each call so the shape-resolver can read
	 * across both axes.
	 */
	readonly priorOutputs:  Readonly<Record<string, string>>;
	readonly deps:          DiscoveryExecuteDeps;
}

export interface ExecuteDiscoveryStepResult {
	readonly output:        StepOutput;
	/**
	 * Raw outputs from each PlannedSkillCall in this step, keyed by
	 * the call's `id`. Useful for telemetry; the StepOutput itself
	 * is the canonical contract for downstream stages.
	 */
	readonly skillOutputs:  Readonly<Record<string, string>>;
}

export async function executeDiscoveryStep(
	input: ExecuteDiscoveryStepInput,
): Promise<ExecuteDiscoveryStepResult> {
	const t0 = Date.now();
	const skillOutputs: Record<string, string> = {};
	const facts: string[] = [];
	const citations: Citation[] = [];
	let executedCount = 0;
	let emptyCount    = 0;

	for (const call of input.step.skills) {
		// Merge priorOutputs (step-level, from retained ledger) with the
		// in-step skill outputs gathered so far. Skill call ids win on
		// collision (within-step wiring is the more specific signal).
		const mergedPriors: Record<string, string> = {
			...input.priorOutputs,
			...skillOutputs,
		};
		const syntheticLeaf = makeSyntheticLeaf(call);

		let resultText = '';
		try {
			resultText = await input.deps.executeLeaf({
				leaf:         syntheticLeaf,
				priorOutputs: mergedPriors,
			});
		} catch (err) {
			log.warn({
				stepId: input.step.id, callId: call.id, skillId: call.skillId,
				err: (err as Error).message,
			}, 'discovery-execute: executeLeaf threw; treating call as empty');
		}

		skillOutputs[call.id] = resultText;
		executedCount += 1;
		if (resultText.trim().length === 0) {
			emptyCount += 1;
			continue;
		}

		// Summarize non-empty results into structured facts + citations.
		let summary: EvidenceEntry | undefined;
		try {
			summary = await summarizeResult(input.deps.summarizeProvider, {
				skillId:    call.skillId,
				args:       {},   // shape-resolver did the resolution; we don't carry args back here
				resultText,
				objective:  input.step.intent,
				criteria:   input.deps.gapFacts.map(f => f.fact),
			});
		} catch (err) {
			log.warn({
				stepId: input.step.id, callId: call.id, skillId: call.skillId,
				err: (err as Error).message,
			}, 'discovery-execute: summarizeResult threw; skipping summary for this call');
			continue;
		}

		facts.push(...summary.facts);
		for (const c of summary.citations) {
			const parsed = parseCitationString(c);
			if (parsed !== null) { citations.push(parsed); }
		}
	}

	const status = deriveStatus(executedCount, emptyCount);

	return {
		output: {
			stepId:     input.step.id,
			status,
			facts,
			citations,
			durationMs: Date.now() - t0,
		},
		skillOutputs,
	};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeSyntheticLeaf(call: PlannedSkillCall): PlannedNode {
	return {
		id:        call.id,
		title:     call.skillId,
		objective: call.context,
		kind:      'leaf',
		skill:     call.skillId,
		inputs:    {},
		emit:      'intermediate',
	};
}

function deriveStatus(executedCount: number, emptyCount: number): StepOutput['status'] {
	if (executedCount === 0)        { return 'failed'; }
	if (emptyCount === executedCount) { return 'failed'; }
	if (emptyCount > 0)             { return 'partial'; }
	return 'ok';
}

/**
 * Parse a string citation of the form `path:foo.ts#L1-L20`,
 * `path:foo.ts#L42`, or just `path:foo.ts` into a structured
 * `Citation`. Returns null when the input doesn't even contain a
 * non-empty path token.
 *
 * The legacy `summarizeResult` shape returns string citations; this
 * adapter converts them to the structured `Citation` shape the
 * StepOutput type expects.
 */
function parseCitationString(raw: string): Citation | null {
	const trimmed = raw.trim();
	if (trimmed.length === 0) { return null; }
	// Strip a `path:` prefix if present (legacy gather-evidence emitter shape).
	const stripped = trimmed.startsWith('path:') ? trimmed.slice(5) : trimmed;
	// Match an optional `#L<start>(-L<end>)?` suffix.
	const m = /^([^#]+?)(?:#L(\d+)(?:-L(\d+))?)?$/.exec(stripped);
	if (m === null) { return null; }
	const path = m[1]?.trim();
	if (path === undefined || path.length === 0) { return null; }
	const startLine = m[2] !== undefined ? parseInt(m[2], 10) : undefined;
	const endLine   = m[3] !== undefined ? parseInt(m[3], 10) : undefined;
	const out: { -readonly [K in keyof Citation]: Citation[K] } = { path };
	if (startLine !== undefined && Number.isFinite(startLine)) { out.startLine = startLine; }
	if (endLine   !== undefined && Number.isFinite(endLine))   { out.endLine   = endLine; }
	return out;
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _makeSyntheticLeafForTest    = makeSyntheticLeaf;
export const _deriveStatusForTest         = deriveStatus;
export const _parseCitationStringForTest  = parseCitationString;
