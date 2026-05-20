/**
 * Discovery-flow per-section runner -- Phase δ of
 * plans/code-analyzer-discovery-plan-loop.md.
 *
 * Orchestrates one section through:
 *
 *   cycle 1:
 *     cloud.expandDiscoveryPlan(section, tier, cycle=1, emptyMemory)
 *     local.executeStep × N steps
 *     cloud.reviewCycle(stepOutputs, cycleMemory)
 *       -> { keep, new_steps, scratchpad }
 *     retainedLedger += stepOutputs[keep]
 *     cycleMemory.priorAsks += { cycle: 1, steps }
 *     cycleMemory.criteriaCoverage = computeCoverage(retained, criteria)
 *     cycleMemory.scratchpad = response.scratchpad ?? carry-forward
 *
 *   cycle 2 / 3 (if new_steps from prior cycle is non-empty):
 *     local.executeStep × new_steps
 *     cloud.reviewCycle(...)
 *     retainedLedger += newly-kept
 *     cycleMemory update
 *
 *   terminate (cycle == 3 OR empty new_steps):
 *     local.writeSectionFromEvidence(adaptedLedger)
 *     cloud.reviewProse(prose)
 *       if redraft: one redraft attempt; ship the better one
 *
 * Phase δ does NOT modify the writer's input shape. A small adapter
 * converts retained `StepOutput[]` to the legacy `EvidenceEntry[]`
 * the writer already consumes. Phase ε migrates the writer to take
 * structured `Citation[]` directly, at which point the adapter
 * goes away.
 *
 * Feature-gated: orchestrator only enters this path when
 * `process.env.INSRC_ANALYZER_FLOW === 'discovery'`. Default
 * (`gather-write`) keeps using the existing patch-loop flow.
 */

import type { LLMProvider } from '../../../shared/types.js';
import type { Session } from '../../session.js';
import type { ScopeSize } from '../../../shared/classify.js';
import type { PlannedAction } from '../../content-gen/plan-actions.js';
import type {
	Citation,
	CycleMemory,
	DiscoveryStep,
	StepOutput,
} from '../../content-gen/discovery-plan.js';
import { emptyCycleMemory } from '../../content-gen/discovery-plan.js';
import {
	expandDiscoveryPlan,
	reviewCycle,
	reviewProse,
} from '../../content-gen/discovery-plan-actions.js';

import { computeCoverage } from './cycle-memory.js';
import { executeStep } from './execute-step.js';
import { writeSectionFromEvidence } from './write-from-evidence.js';
import type { EvidenceEntry } from './gather-evidence.js';
import { getSkill } from '../../../daemon/skills/registry.js';
import { getLogger } from '../../../shared/logger.js';

const log = getLogger('code-analyzer:discovery-flow');

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface RunDiscoveryFlowInput {
	readonly localProvider:    LLMProvider;
	readonly cloudProvider:    LLMProvider;
	readonly session:          Session;
	readonly action:           PlannedAction;
	readonly request:          string;
	readonly tier:             ScopeSize;
	readonly repoSummary?:     string | undefined;
	readonly repoSizeSummary?: import('../../../daemon/repo-summary.js').RepoSizeSummary | undefined;
	readonly analyzerLabel?:   string | undefined;
	/** Hard cap on cycles. Default 3. */
	readonly maxCycles?:       number | undefined;
	readonly onProgress?:      ((msg: string) => void) | undefined;
}

export interface DiscoveryFlowResult {
	readonly markdown:           string;
	readonly retainedStepCount:  number;
	readonly cyclesRun:           number;
	readonly proseRedraftFired:   boolean;
	readonly proseVerdict:        'accept' | 'redraft';
	readonly perCycleSummary: readonly {
		readonly cycle:        1 | 2 | 3;
		readonly stepsRun:     number;
		readonly keptIds:      readonly string[];
		readonly newStepsAsk:  number;
	}[];
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runDiscoveryFlow(input: RunDiscoveryFlowInput): Promise<DiscoveryFlowResult> {
	const maxCycles = input.maxCycles ?? 3;
	const perCycleSummary: {
		cycle:        1 | 2 | 3;
		stepsRun:     number;
		keptIds:      readonly string[];
		newStepsAsk:  number;
	}[] = [];
	const retainedLedger: StepOutput[] = [];
	const stepsById: Map<string, DiscoveryStep> = new Map();
	let cycleMemory: CycleMemory = emptyCycleMemory(input.action.reviewCriteria);
	let stepsToRun: readonly DiscoveryStep[] = [];

	for (let c = 1; c <= maxCycles; c++) {
		const cycle = c as 1 | 2 | 3;
		input.onProgress?.(`  [${input.action.id}] discovery cycle ${cycle}/${maxCycles}`);

		// Cycle 1: get the initial plan from cloud. Cycle 2/3: use the
		// new_steps the prior cycle's reviewer emitted.
		if (cycle === 1) {
			const plan = await expandDiscoveryPlan({
				section:     input.action,
				tier:        input.tier,
				cycle,
				cycleMemory,
				...(input.repoSummary !== undefined ? { repoSummary: input.repoSummary } : {}),
				...(input.analyzerLabel !== undefined ? { analyzerLabel: input.analyzerLabel } : {}),
			}, input.cloudProvider);
			stepsToRun = plan.steps;
		}
		for (const s of stepsToRun) stepsById.set(s.id, s);

		// Execute each step on the local LLM.
		const cycleOutputs: StepOutput[] = [];
		for (const step of stepsToRun) {
			input.onProgress?.(`  [${input.action.id}/${step.id}] ${step.intent}`);
			const out = await executeStep({
				provider:       input.localProvider,
				session:        input.session,
				step,
				getSkillSchema: (skillId) => {
					const sk = getSkill(skillId);
					return sk?.inputs;
				},
				...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
			});
			cycleOutputs.push(out);
		}

		// Cloud reviews this cycle's outputs.
		const review = await reviewCycle({
			section:     input.action,
			cycle,
			stepOutputs: cycleOutputs,
			cycleMemory,
			...(input.analyzerLabel !== undefined ? { analyzerLabel: input.analyzerLabel } : {}),
		}, input.cloudProvider);

		// Promote kept outputs into the retained ledger.
		const keptSet = new Set(review.keep);
		const keptThisCycle = cycleOutputs.filter(o => keptSet.has(o.stepId));
		retainedLedger.push(...keptThisCycle);

		perCycleSummary.push({
			cycle,
			stepsRun:     stepsToRun.length,
			keptIds:      keptThisCycle.map(o => o.stepId),
			newStepsAsk:  review.new_steps.length,
		});

		// Update CycleMemory for the next cycle.
		const nextScratchpad = review.scratchpad ?? cycleMemory.scratchpad;
		cycleMemory = {
			priorAsks: [
				...cycleMemory.priorAsks,
				{ cycle, steps: stepsToRun.map(s => ({ id: s.id, intent: s.intent })) },
			],
			criteriaCoverage: computeCoverage(retainedLedger, input.action.reviewCriteria, stepsById),
			scratchpad: nextScratchpad,
		};

		log.info({
			actionId:        input.action.id,
			cycle,
			stepsRun:        stepsToRun.length,
			kept:             keptThisCycle.length,
			newStepsAsk:      review.new_steps.length,
			retainedTotal:    retainedLedger.length,
		}, 'discovery-flow: cycle complete');

		// Terminate?
		if (review.new_steps.length === 0) {
			input.onProgress?.(`  [${input.action.id}] cycle ${cycle} terminated -- reviewer accepted current ledger`);
			break;
		}
		if (cycle === maxCycles) {
			input.onProgress?.(`  [${input.action.id}] cycle cap reached (${maxCycles})`);
			break;
		}
		stepsToRun = review.new_steps;
	}

	// Write phase -- adapter converts the retained ledger to the legacy
	// EvidenceEntry shape the writer consumes today. Phase ε removes the
	// adapter and lets the writer take Citation[] directly.
	const evidenceForWriter = adaptStepOutputsForWriter(retainedLedger);
	input.onProgress?.(`  [${input.action.id}] writing prose from ${evidenceForWriter.length} evidence entries`);

	const written = await writeSectionFromEvidence({
		provider:  input.localProvider,
		action:    input.action,
		request:   input.request,
		evidence:  evidenceForWriter,
		...(input.repoSizeSummary !== undefined ? { repoSizeSummary: input.repoSizeSummary } : {}),
	});

	// Prose-only review (cloud).
	const proseReview = await reviewProse({
		section: input.action,
		prose:   written.markdown,
		...(input.analyzerLabel !== undefined ? { analyzerLabel: input.analyzerLabel } : {}),
	}, input.cloudProvider);

	let finalMarkdown      = written.markdown;
	let proseRedraftFired  = false;
	if (proseReview.verdict === 'redraft') {
		proseRedraftFired = true;
		input.onProgress?.(`  [${input.action.id}] prose-review requested redraft (${proseReview.notes.length} notes)`);
		// One redraft attempt: ship whichever has more citations.
		const redrafted = await writeSectionFromEvidence({
			provider:  input.localProvider,
			action:    input.action,
			request:   `${input.request}\n\nREDRAFT requested. Reviewer notes:\n${proseReview.notes.map(n => `- ${n}`).join('\n')}`,
			evidence:  evidenceForWriter,
			...(input.repoSizeSummary !== undefined ? { repoSizeSummary: input.repoSizeSummary } : {}),
		});
		// Pick the version with more citations (citation count is the
		// only quality proxy we have without re-invoking the reviewer).
		if (redrafted.citationsUsed.length > written.citationsUsed.length) {
			finalMarkdown = redrafted.markdown;
		}
	}

	return {
		markdown:           finalMarkdown,
		retainedStepCount:  retainedLedger.length,
		cyclesRun:           perCycleSummary.length,
		proseRedraftFired,
		proseVerdict:        proseReview.verdict,
		perCycleSummary,
	};
}

// ---------------------------------------------------------------------------
// Internal -- adapter (StepOutput[] -> EvidenceEntry[])
// ---------------------------------------------------------------------------

/**
 * Convert retained step outputs into the `EvidenceEntry[]` shape the
 * writer consumes. Phase epsilon of
 * plans/code-analyzer-discovery-plan-loop.md: the structured
 * `Citation` objects pass through directly via `citationObjs`; the
 * legacy string `citations` field stays empty. The writer detects
 * `citationObjs` and renders inline markdown links from the
 * structured fields, so the adapter no longer pre-renders strings.
 *
 * Mapping:
 *   - skillId       -- the stepId (semantically: which step produced this)
 *   - args          -- empty object (the writer doesn't read it)
 *   - facts         -- carried through
 *   - citations     -- empty (legacy field; structured ones live in
 *                      citationObjs)
 *   - citationObjs  -- the structured Citation[] from the step output
 *   - confidence    -- mapped from step status: ok -> high, partial
 *                      -> medium, failed -> low
 */
export function adaptStepOutputsForWriter(outputs: readonly StepOutput[]): EvidenceEntry[] {
	return outputs.map(out => ({
		skillId:       out.stepId,
		args:          {},
		facts:         out.facts,
		citations:     [],
		citationObjs:  out.citations,
		confidence:    out.status === 'ok' ? 'high' as const
			:           out.status === 'partial' ? 'medium' as const
			:           'low' as const,
	}));
}

/** Render a single structured Citation as `[label](path:foo#L1-L20)`.
 *  Phase ε kept this exported for the unit tests that locked in the
 *  string-rendering format before the writer-side migration. After
 *  the migration, this helper is no longer the primary code path
 *  (the writer renders directly from Citation fields); kept for
 *  callers that still want a string form (e.g. for logs / telemetry). */
export function renderCitationAsString(c: Citation): string {
	const range = c.startLine !== undefined && c.endLine !== undefined
		? `#L${c.startLine}-L${c.endLine}`
		: (c.startLine !== undefined ? `#L${c.startLine}` : '');
	const label = c.label ?? c.path.split('/').pop() ?? c.path;
	return `[${label}](path:${c.path}${range})`;
}

// ---------------------------------------------------------------------------
// Feature-flag helper -- consumed by the orchestrator
// ---------------------------------------------------------------------------

/**
 * True when the discovery flow is the active path. Read at function-
 * call time (not module-init) so tests can override `process.env`
 * without re-importing.
 */
export function isDiscoveryFlowEnabled(): boolean {
	return process.env['INSRC_ANALYZER_FLOW'] === 'discovery';
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _adaptStepOutputsForWriterForTest = adaptStepOutputsForWriter;
export const _renderCitationAsStringForTest    = renderCitationAsString;
