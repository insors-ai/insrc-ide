/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Stage 2 of the fact-gap-driven task loop -- Phase delta of
 * plans/section-flow-fact-gap-loop.md, reworked in Phase 1 batch 3b of
 * plans/section-flow-architecture-redesign.md.
 *
 * Adapts a `DiscoveryStep` (a multi-skill investigation) into a series
 * of leaf invocations + a structured `StepOutput`. For each
 * `PlannedSkillCall` in the step:
 *
 *   1. Synthesise a leaf `PlannedNode` (skill + objective + empty
 *      inputs) and dispatch it through the existing `leaf-executor`
 *      (shape-resolver + runSkill + stringify).
 *   2. Stash the raw stringified result under the call's `id`. This
 *      becomes `StepOutput.rawOutputs[callId]` so cycle-review v2 can
 *      render what the skill literally produced.
 *   3. Stash the spill-writer's `<sessionId>:<ts>:<skillId>` artifact
 *      id when present. This becomes `StepOutput.artifactIds[callId]`
 *      so the orchestrator can write the reviewer-emitted goal-aware
 *      summary onto the matching `artifact_vec` row.
 *
 * The previous flow ran a dedicated `summarizeResult` cloud call per
 * non-empty leaf output to extract `EvidenceEntry { facts, citations }`.
 * Phase 1 batch 3b deletes that call entirely -- the cloud cycle-review
 * (Stage 3) now folds summary emission into the same turn that judges
 * keep/new_steps, so per-step cloud round-trips collapse from N+1 to 1.
 *
 * Final `StepOutput.status` is derived mechanically:
 *   - `failed`  : all calls returned empty
 *   - `partial` : some calls returned empty
 *   - `ok`      : every call returned non-empty
 *
 * No retry logic at this level -- the shape-resolver has its own
 * retry; the discovery executor just dispatches and aggregates.
 * Per-call failures don't abort the step; they downgrade its status.
 *
 * The skill catalog's `PlannedSkillCall` validator (Stage 1) already
 * ensures `dependsOn` references earlier-declared call ids within the
 * same step, so we can iterate the `skills` array in order without a
 * topological sort -- the array IS the execution order.
 */

import type { DiscoveryStep, PlannedSkillCall, StepOutput } from '../content-gen/discovery-plan.js';
import type { PlannedNode } from '../content-gen/plan-tree.js';
import type { ExecuteLeaf, LeafBuildContext } from './leaf-executor.js';
import type { RequiredFact } from './fact-gap-types.js';
import type { TodoSpec } from './types.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:discovery-execute');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DiscoveryExecuteDeps {
	readonly todo:               TodoSpec;
	/**
	 * The gap-facts the cycle is targeting. Kept on the deps for
	 * parity with cycle-review (the reviewer reads the same list) and
	 * for telemetry; this stage doesn't consume them directly anymore
	 * now that summarizeResult is gone.
	 */
	readonly gapFacts:           readonly RequiredFact[];
	/** Leaf-executor closure (built by the orchestrator via `buildSkillExecutor`). */
	readonly executeLeaf:        ExecuteLeaf;
	/**
	 * Optional per-step build-context payload (Phase 3 of
	 * plans/section-flow-architecture-redesign.md). When supplied, the
	 * leaf executor runs a local-tier build-context turn BEFORE
	 * shape-resolve, fetches the named artifacts from `artifact_vec`
	 * (full body from disk), and merges them into `priorOutputs` keyed
	 * by artifact id. Omit to skip build-context entirely (legacy
	 * path; still exercised by unit tests).
	 */
	readonly buildContext?:      LeafBuildContext | undefined;
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
	 * the call's `id`. A view into `output.rawOutputs` kept for
	 * telemetry-style consumers that want to ignore the `StepOutput`
	 * envelope.
	 */
	readonly skillOutputs:  Readonly<Record<string, string>>;
	/**
	 * Per-call mapping `callId -> spillId`. A view into
	 * `output.artifactIds` for the same reason.
	 */
	readonly skillArtifactIds: Readonly<Record<string, string>>;
}

export async function executeDiscoveryStep(
	input: ExecuteDiscoveryStepInput,
): Promise<ExecuteDiscoveryStepResult> {
	const t0 = Date.now();
	const skillOutputs: Record<string, string> = {};
	const skillArtifactIds: Record<string, string> = {};
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
		let resultSpillId: string | undefined;
		try {
			const leafCall: Parameters<typeof input.deps.executeLeaf>[0] = {
				leaf:         syntheticLeaf,
				priorOutputs: mergedPriors,
				...(input.deps.buildContext !== undefined ? { buildContext: input.deps.buildContext } : {}),
			};
			const leafResult = await input.deps.executeLeaf(leafCall);
			resultText    = leafResult.text;
			resultSpillId = leafResult.spillId;
		} catch (err) {
			log.warn({
				stepId: input.step.id, callId: call.id, skillId: call.skillId,
				err: (err as Error).message,
			}, 'discovery-execute: executeLeaf threw; treating call as empty');
		}

		skillOutputs[call.id] = resultText;
		if (resultSpillId !== undefined) {
			skillArtifactIds[call.id] = resultSpillId;
		}
		executedCount += 1;
		if (resultText.trim().length === 0) {
			emptyCount += 1;
		}
	}

	const status = deriveStatus(executedCount, emptyCount);

	return {
		output: {
			stepId:      input.step.id,
			status,
			rawOutputs:  skillOutputs,
			artifactIds: skillArtifactIds,
			durationMs:  Date.now() - t0,
		},
		skillOutputs,
		skillArtifactIds,
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

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _makeSyntheticLeafForTest = makeSyntheticLeaf;
export const _deriveStatusForTest      = deriveStatus;
