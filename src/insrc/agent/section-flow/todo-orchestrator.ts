/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * TODO orchestrator -- Phase 4 batch 4.2 of
 * plans/section-flow-architecture-redesign.md.
 *
 * Drives one TODO through the DYNAMIC decide-next-step loop. The
 * cycle loop (`runDiscoveryPlanExpansion` -> N steps -> cycle review
 * -> ... over <=3 cycles) is gone. Each iteration runs one cloud
 * `decide-next-step` turn that emits an action + the goal-aware
 * summary for the previous iteration's step in one round-trip.
 *
 * Flow per TODO:
 *
 *   Stage 0  runFactGapAnalysis(...)              -- unchanged
 *   Fast-path: all facts present -> straight to Stage 6 with an
 *              empty ledger.
 *   Stage 1  runSketch(...)                        -- emits a 3-5 step
 *              default trajectory (cloud).
 *   Stage 2  Dynamic loop:
 *     a. buildToc + renderToc(sessionId)
 *     b. runDecideNextStep(... lastStep ...)
 *     c. persist lastStep's summaries onto artifact_vec
 *     d. update closure markers + convergence accounting
 *        - allClosed -> terminate `covered`
 *        - N consecutive no-progress steps -> terminate `unrecoverable`
 *     e. honor decision:
 *        - terminate -> break out
 *        - replan-sketch -> regenerate sketch, continue
 *        - execute-step -> executeDiscoveryStep + push to ledger
 *     f. safety ceiling backstop (default 50 steps per TODO) -- only
 *        fires when the convergence signals fail; log loudly.
 *   Stage 6  synthesizeSectionFromLedger(...)      -- now takes
 *              priorAttempts instead of cycleMemory.
 *   Stage 7  reviewSection(...)                    -- unchanged.
 *              revise-major triggers one re-run of the whole TODO.
 *
 * L2 fallback paths (Q10 floor): any Stage throws, OR the dynamic
 * loop terminates with empty retainedLedger, OR the section-review
 * revise-major recycle also fails -- the orchestrator invokes the
 * caller-supplied L2 fallback.
 *
 * Output: a fully-formed `WorkingMemoryEntry`. On the L2 path,
 * `entry.findings.fallback === 'L2'` and `perRoot` carries a
 * synthetic `L2-fallback` entry so downstream consumers (Q5 / Q7
 * / Q8) can detect the floor was hit.
 */

import type { LLMProvider } from '../../shared/types.js';
import type { CloudMemoryView, LocalMemoryView } from '../working-memory/index.js';
import { enforceLocalViewBudget } from '../working-memory/index.js';
import { renderFactGaps } from '../prompts/composers/fact-gaps.js';
import { renderToc } from '../prompts/composers/toc.js';
import { buildToc } from '../artifacts/toc-builder.js';
import type {
	PerRootFinding,
	TodoOrigin,
	WorkingMemoryEntry,
	WorkingMemoryFindings,
} from '../working-memory/types.js';
import type { TodoSpec } from './types.js';
import type { ExecuteLeaf, LeafBuildContext } from './leaf-executor.js';
import type { CatalogSkill } from '../content-gen/plan-tree-runner.js';
import type { DiscoveryStep, StepOutput } from '../content-gen/discovery-plan.js';
import { runFactGapAnalysis } from './step-fact-gap-analysis.js';
import { executeDiscoveryStep } from './step-discovery-execute.js';
import { runSketch } from './step-sketch.js';
import { runDecideNextStep, type DecideNextStepResult } from './step-decide-next-step.js';
import type {
	DecideLastStepRawOutputs,
	DecidePriorAttempt,
} from '../prompts/writers/decide-next-step.js';
import { synthesizeSectionFromLedger } from './step-synthesis-from-ledger.js';
import type { PriorAttempt } from '../prompts/writers/section-synth.js';
import { reviewSection } from './step-section-review.js';
import {
	DEFAULT_NO_PROGRESS_BUDGET,
	DEFAULT_SAFETY_CEILING,
	computeCoverage,
	scanAllClosureMarkers,
	stepContributedEvidence,
	type ClosureClaim,
} from './convergence.js';
import { gapFacts, isTrivialFastPath, type RequiredFact } from './fact-gap-types.js';
import { getArtifactById, updateArtifactSummary } from '../../db/lance/artifact-vec.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:todo-orchestrator');

/** Cap on section-review revise-major re-runs of the whole TODO. */
const DEFAULT_MAX_RECYCLES = 1;

// ---------------------------------------------------------------------------
// L2 fallback contract
// ---------------------------------------------------------------------------

export interface L2FallbackInput {
	readonly todo:    TodoSpec;
	readonly memory:  CloudMemoryView;
	/** Why the orchestrator fell back; useful as L2 prompt context. */
	readonly reason:  string;
}

export type L2Fallback = (input: L2FallbackInput) => Promise<string>;

// ---------------------------------------------------------------------------
// Public input / output
// ---------------------------------------------------------------------------

export interface TodoOrchestratorInput {
	readonly todo:        TodoSpec;
	/**
	 * Cloud-tier memory view (Phase 2 batch 2b + Phase 6 batch 6.1).
	 * The orchestrator threads this through every cloud-tier prompt
	 * (fact-gap, sketch, decide-next-step, synth, section-review).
	 * Each prompt renders only what it needs; the unused fields cost
	 * nothing.
	 *
	 * Callers wrap their legacy `MemoryShapeBundle` via
	 * `legacyBundleToCloudView(bundle)` -- which leaves `toc` /
	 * `factLedger` empty. The orchestrator fills `factLedger` (from
	 * the just-completed fact-gap analysis) into the views threaded
	 * to sketch + decide-next-step + synth.
	 */
	readonly memory:      CloudMemoryView;
	readonly provider:    LLMProvider;
	readonly executeLeaf: ExecuteLeaf;
	readonly l2Fallback:  L2Fallback;
	/**
	 * Skill catalog the dynamic loop composes from. Required for
	 * production. Empty catalog forces the orchestrator to L2
	 * immediately -- there's no way to close any gap without skills.
	 */
	readonly catalog:     readonly CatalogSkill[];
	/**
	 * Optional session id for the build-context sub-step (Phase 3) +
	 * the per-step TOC (Phase 4). When supplied, the orchestrator
	 * builds the artifact TOC from `artifact_vec` before each
	 * `decide-next-step` turn AND before each leaf execution. When
	 * undefined, both stages run with an empty TOC -- a unit-test
	 * convenience; production wiring MUST supply `session.id`.
	 */
	readonly sessionId?:  string | undefined;
	/** Optional local-tier memory view for the build-context turn. */
	readonly localMemory?: LocalMemoryView | undefined;
	/** Hard cap on steps per TODO. Default DEFAULT_SAFETY_CEILING (50). */
	readonly safetyCeiling?: number | undefined;
	/** Consecutive no-progress steps that trigger termination. Default DEFAULT_NO_PROGRESS_BUDGET (3). */
	readonly noProgressBudget?: number | undefined;
	/** Cap on section-review revise-major restarts. Default 1. */
	readonly maxRecycles?: number | undefined;
}

export interface PerStepTrace {
	readonly stepId:               string;
	readonly intent:                string;
	readonly status:                'ok' | 'partial' | 'failed';
	readonly contributedEvidence:   boolean;
}

export interface TodoOrchestratorTrace {
	readonly stepsRun:              number;
	readonly recyclesConsumed:      number;
	readonly l2FallbackUsed:        boolean;
	readonly retainedStepCount:     number;
	readonly unmetGapCount:         number;
	readonly failureChain:          readonly string[];
	readonly perStepTrace:          readonly PerStepTrace[];
	readonly sketchReplans:         number;
	readonly terminationVerdict?:   'covered' | 'unrecoverable' | 'safety-ceiling' | 'reviewer-accept' | 'l2' | undefined;
}

export interface TodoOrchestratorResult {
	readonly entry: WorkingMemoryEntry;
	readonly trace: TodoOrchestratorTrace;
}

// ---------------------------------------------------------------------------
// Orchestrator (dynamic loop)
// ---------------------------------------------------------------------------

export async function runTodoOrchestrator(
	input: TodoOrchestratorInput,
): Promise<TodoOrchestratorResult> {
	const safetyCeiling    = input.safetyCeiling    ?? DEFAULT_SAFETY_CEILING;
	const noProgressBudget = input.noProgressBudget ?? DEFAULT_NO_PROGRESS_BUDGET;
	const maxRecycles      = input.maxRecycles      ?? DEFAULT_MAX_RECYCLES;
	const failureChain: string[] = [];
	let recyclesConsumed = 0;
	let l2Reason = 'unknown';

	let retainedLedger: readonly StepOutput[] = [];
	let unmetGaps: readonly RequiredFact[] = [];

	let perStepTrace: PerStepTrace[] = [];
	let stepsRun = 0;
	let sketchReplans = 0;
	let terminationVerdict: TodoOrchestratorTrace['terminationVerdict'];

	while (true) {
		// Stage 0: fact-gap analysis (unchanged from prior orchestrator).
		let analysis;
		try {
			analysis = await runFactGapAnalysis({
				todo: input.todo, memory: input.memory, catalog: input.catalog, provider: input.provider,
			});
		} catch (err) {
			const reason = `fact-gap analysis failed: ${(err as Error).message}`;
			failureChain.push(reason);
			log.warn({ todoId: input.todo.id, reason }, 'fact-gap analysis exhausted -> L2 fallback');
			l2Reason = reason;
			terminationVerdict = 'l2';
			break;
		}

		// Trivial fast-path: every required fact already present -> skip
		// the dynamic loop entirely, go straight to Stage 6 with an
		// empty ledger.
		if (isTrivialFastPath(analysis.analysis)) {
			log.info({ todoId: input.todo.id, factCount: analysis.analysis.requiredFacts.length }, 'TODO orchestrator: trivial fast-path (all facts present)');
			retainedLedger = [];
			unmetGaps = [];
			const fastPathSummaries = new Map<string, string>();
			const fastPathPriorAttempts: PriorAttempt[] = [];
			const synth = await synthesizeSectionFromLedger({
				todo: input.todo, memory: input.memory, gapAnalysis: analysis.analysis,
				retainedLedger:  [],
				summariesByStep: fastPathSummaries,
				priorAttempts:   fastPathPriorAttempts,
				provider:        input.provider,
			});
			const reviewResult = await reviewSection({
				todo: input.todo, memory: input.memory,
				candidate: synth.markdown,
				findings:  ledgerToFindings([], fastPathSummaries),
				provider:  input.provider,
			});
			if (reviewResult.reopenRequested && recyclesConsumed < maxRecycles) {
				recyclesConsumed += 1;
				failureChain.push(`section review revise-major (fast-path): ${reviewResult.reopenReason ?? ''}`);
				log.info({ todoId: input.todo.id, recyclesConsumed }, 'section review revise-major in fast-path -> recycling');
				continue;
			}
			if (reviewResult.reopenRequested) {
				l2Reason = `fast-path section review revise-major (recycle budget exhausted): ${reviewResult.reopenReason ?? ''}`;
				failureChain.push(l2Reason);
				terminationVerdict = 'l2';
				break;
			}
			const entry = buildSuccessEntry({
				todo:               input.todo,
				detail:             reviewResult.finalMarkdown,
				retainedLedger:     [],
				summariesByStep:    fastPathSummaries,
				unmetGaps:          [],
				factGapRetried:     analysis.retried,
				sectionExhausted:   reviewResult.exhausted,
				synthFallback:      synth.usedFallback,
			});
			return {
				entry,
				trace: {
					stepsRun: 0,
					recyclesConsumed,
					l2FallbackUsed:    false,
					retainedStepCount: 0,
					unmetGapCount:     0,
					failureChain,
					perStepTrace:      [],
					sketchReplans:     0,
					terminationVerdict: 'reviewer-accept',
				},
			};
		}

		// Normal path: dynamic loop.
		const gaps = gapFacts(analysis.analysis);
		const gapIdSet = new Set(gaps.map(g => g.id));
		const gapIdList = gaps.map(g => g.id);

		// Cloud-tier memory view threaded into post-fact-gap stages. Phase 6
		// batch 6.1: `factLedger` carries the just-rendered gap-facts block
		// so sketch / decide-next-step / synth all see the SAME coverage
		// picture the gap-analysis emitted. TOC stays empty here -- each
		// decide-next-step iteration builds its own TOC at the boundary.
		const memoryWithLedger: CloudMemoryView = {
			...input.memory,
			factLedger: renderFactGaps(gaps),
		};

		// Stage 1: sketch.
		let sketch: readonly DiscoveryStep[];
		try {
			const sketchResult = await runSketch({
				todo: input.todo, gapFacts: gaps, catalog: input.catalog,
				memory: memoryWithLedger,
				provider: input.provider,
			});
			sketch = sketchResult.steps;
		} catch (err) {
			l2Reason = `sketch failed: ${(err as Error).message}`;
			failureChain.push(l2Reason);
			terminationVerdict = 'l2';
			break;
		}

		// Per-TODO ledger + bookkeeping.
		retainedLedger = [];
		perStepTrace = [];
		stepsRun = 0;
		sketchReplans = 0;
		const priorAttempts: PriorAttempt[] = [];
		const decidePriorAttempts: DecidePriorAttempt[] = [];
		const closureClaims: ClosureClaim[] = [];
		const allArtifactIds: Record<string, Record<string, string>> = {};
		const crossStepRawOutputs: Record<string, string> = {};
		let priorStepOutputs: Record<string, string> = {};
		let lastStep: DecideLastStepRawOutputs | undefined;
		let noProgressCount = 0;
		let loopFailureReason: string | undefined;

		while (stepsRun < safetyCeiling) {
			// 2a. Build the TOC for THIS decide turn.
			const tocText = await safeRenderToc(input.sessionId);

			// 2b. Cloud decide-next-step. The cloud view is rebuilt each
			//     iteration with the freshly-rendered TOC so the prompt
			//     sees the SAME artifact index the decide-next-step
			//     writer renders directly below.
			let decision: DecideNextStepResult;
			try {
				decision = await runDecideNextStep({
					todo: input.todo, gapFacts: gaps, sketch, catalog: input.catalog,
					toc: tocText, lastStep,
					priorAttempts: decidePriorAttempts,
					memory: { ...memoryWithLedger, toc: tocText },
					provider: input.provider,
				});
			} catch (err) {
				loopFailureReason = `decide-next-step failed at step ${stepsRun + 1}: ${(err as Error).message}`;
				log.warn({ todoId: input.todo.id, reason: loopFailureReason }, 'TODO orchestrator: decide-next-step threw');
				break;
			}

			// 2c. Persist the prior step's summaries the decider just emitted.
			//     The decide turn READ lastStep and produced summaries for it;
			//     we write them to artifact_vec rows now so the TOC + downstream
			//     stages see the goal-aware claims.
			if (lastStep !== undefined && Object.keys(decision.lastStepSummaries).length > 0) {
				const priorIds = allArtifactIds[lastStep.stepId];
				if (priorIds !== undefined) {
					await persistStepSummaries(
						{ [lastStep.stepId]: decision.lastStepSummaries },
						{ [lastStep.stepId]: priorIds },
					);
				}
				// Convergence accounting against the PRIOR step's summary set.
				const newClaims = scanAllClosureMarkers(
					{ [lastStep.stepId]: decision.lastStepSummaries },
					gapIdSet,
				);
				for (const c of newClaims) { closureClaims.push(c); }
				const contributed = stepContributedEvidence(newClaims);
				const traceIdx = perStepTrace.findIndex(t => t.stepId === lastStep!.stepId);
				if (traceIdx >= 0) {
					perStepTrace[traceIdx] = { ...perStepTrace[traceIdx]!, contributedEvidence: contributed };
				}
				if (contributed) {
					noProgressCount = 0;
				} else {
					noProgressCount += 1;
					if (noProgressCount >= noProgressBudget) {
						terminationVerdict = 'unrecoverable';
						loopFailureReason = `${noProgressBudget} consecutive no-progress steps`;
						log.warn({ todoId: input.todo.id, noProgressCount }, 'TODO orchestrator: no-progress budget exhausted -> terminate unrecoverable');
						break;
					}
				}
			}

			// 2d. Structural convergence check (signal 1). Pure scan over
			//     accepted closure claims; no LLM call.
			const coverage = computeCoverage(gapIdList, closureClaims);
			if (coverage.allClosed) {
				terminationVerdict = 'covered';
				log.info({ todoId: input.todo.id, stepsRun }, 'TODO orchestrator: TOC coverage closes every gap -> terminate covered');
				break;
			}

			// 2e. Honor the LLM's decision.
			if (decision.action === 'terminate') {
				terminationVerdict = decision.verdict;
				log.info({
					todoId: input.todo.id, stepsRun,
					verdict: decision.verdict, reasoning: decision.reasoning.slice(0, 200),
				}, 'TODO orchestrator: decide-next-step requested terminate');
				break;
			}

			if (decision.action === 'replan-sketch') {
				sketchReplans += 1;
				log.info({ todoId: input.todo.id, sketchReplans, reasoning: decision.reasoning.slice(0, 200) }, 'TODO orchestrator: regenerating sketch');
				try {
					const sketchResult = await runSketch({
						todo: input.todo, gapFacts: gaps, catalog: input.catalog, provider: input.provider,
					});
					sketch = sketchResult.steps;
				} catch (err) {
					loopFailureReason = `sketch replan failed: ${(err as Error).message}`;
					terminationVerdict = 'unrecoverable';
					break;
				}
				// Next decide turn sees no last step -- the replan is a hard
				// reset; the previous trajectory is discarded.
				lastStep = undefined;
				continue;
			}

			// decision.action === 'execute-step'
			const step = decision.step;
			priorAttempts.push({ stepId: step.id, intent: step.intent });
			const crossStepPriors = collectCrossStepPriors(step, crossStepRawOutputs);
			const buildContext = await maybeBuildContext(input, step, retainedLedger);
			let execRes;
			try {
				execRes = await executeDiscoveryStep({
					step,
					priorOutputs: { ...priorStepOutputs, ...crossStepPriors },
					deps: {
						todo: input.todo, gapFacts: gaps,
						executeLeaf: input.executeLeaf,
						...(buildContext !== undefined ? { buildContext } : {}),
					},
				});
			} catch (err) {
				loopFailureReason = `executeDiscoveryStep failed at step ${step.id}: ${(err as Error).message}`;
				terminationVerdict = 'unrecoverable';
				break;
			}
			retainedLedger = [...retainedLedger, execRes.output];
			decidePriorAttempts.push({
				stepId:   step.id,
				intent:   step.intent,
				skillIds: step.skills.map(s => s.skillId),
				status:   execRes.output.status,
			});
			priorStepOutputs = {
				...priorStepOutputs,
				[step.id]: stringifyStepOutput(execRes.output),
			};
			for (const [callId, raw] of Object.entries(execRes.skillOutputs)) {
				if (raw.length > 0) {
					crossStepRawOutputs[`${step.id}.${callId}`] = raw;
				}
			}
			if (Object.keys(execRes.skillArtifactIds).length > 0) {
				allArtifactIds[step.id] = { ...execRes.skillArtifactIds };
			}
			perStepTrace.push({
				stepId:               step.id,
				intent:                step.intent,
				status:                execRes.output.status,
				contributedEvidence:   false,   // updated by the NEXT decide turn's summaries
			});
			lastStep = {
				stepId:     step.id,
				stepIntent: step.intent,
				skills:     step.skills.map(sk => ({
					callId:  sk.id,
					skillId: sk.skillId,
					context: sk.context,
					rawText: execRes.output.rawOutputs[sk.id] ?? '',
				})),
			};
			stepsRun += 1;
		}

		// Safety ceiling backstop. If we get here without a verdict, the
		// while-condition was the exit -- log loudly per the plan.
		if (terminationVerdict === undefined) {
			if (stepsRun >= safetyCeiling) {
				terminationVerdict = 'safety-ceiling';
				loopFailureReason = `safety ceiling (${safetyCeiling}) reached without convergence -- THIS IS A BUG`;
				log.error({ todoId: input.todo.id, stepsRun }, '!!! TODO orchestrator hit safety ceiling -- check convergence signals');
			} else if (loopFailureReason !== undefined) {
				// A loop iteration broke out without a verdict (e.g. decide
				// threw, sketch replan threw). Convert to terminal verdict.
				if (terminationVerdict === undefined) {
					terminationVerdict = 'unrecoverable';
				}
			}
		}

		if (loopFailureReason !== undefined) {
			failureChain.push(loopFailureReason);
		}

		// Empty ledger -> nothing for synthesis to work with.
		if (retainedLedger.length === 0) {
			l2Reason = loopFailureReason ?? `dynamic loop produced no retained facts (verdict=${terminationVerdict ?? 'unknown'})`;
			failureChain.push(l2Reason);
			terminationVerdict = 'l2';
			break;
		}

		// Resolve summaries from artifact_vec (Phase 1 batch 3b).
		const summariesByStep = await resolveStepSummaries(retainedLedger);

		// Stage 6: synthesis.
		let synth;
		try {
			synth = await synthesizeSectionFromLedger({
				todo: input.todo, memory: memoryWithLedger, gapAnalysis: analysis.analysis,
				retainedLedger, summariesByStep, priorAttempts,
				provider: input.provider,
			});
		} catch (err) {
			l2Reason = `synthesis failed: ${(err as Error).message}`;
			failureChain.push(l2Reason);
			terminationVerdict = 'l2';
			break;
		}
		unmetGaps = synth.unmetGaps;

		// Stage 7: section review.
		const reviewResult = await reviewSection({
			todo: input.todo, memory: memoryWithLedger,
			candidate: synth.markdown,
			findings:  ledgerToFindings(retainedLedger, summariesByStep),
			provider:  input.provider,
		});
		if (reviewResult.reopenRequested && recyclesConsumed < maxRecycles) {
			recyclesConsumed += 1;
			failureChain.push(`section review revise-major (dynamic loop): ${reviewResult.reopenReason ?? ''}`);
			log.info({ todoId: input.todo.id, recyclesConsumed }, 'section review revise-major -> re-running the whole TODO');
			terminationVerdict = undefined;   // will be re-derived in the next outer-loop iteration
			continue;
		}
		if (reviewResult.reopenRequested) {
			l2Reason = `section review revise-major (recycle budget exhausted): ${reviewResult.reopenReason ?? ''}`;
			failureChain.push(l2Reason);
			terminationVerdict = 'l2';
			break;
		}

		// Success.
		const entry = buildSuccessEntry({
			todo:             input.todo,
			detail:           reviewResult.finalMarkdown,
			retainedLedger,
			summariesByStep,
			unmetGaps,
			factGapRetried:   analysis.retried,
			sectionExhausted: reviewResult.exhausted,
			synthFallback:    synth.usedFallback,
		});
		log.info({
			todoId: input.todo.id, stepsRun, recyclesConsumed,
			retainedStepCount: retainedLedger.length, unmetGapCount: unmetGaps.length,
			sectionExhausted: reviewResult.exhausted,
			terminationVerdict,
		}, 'TODO orchestrator success');
		return {
			entry,
			trace: {
				stepsRun,
				recyclesConsumed,
				l2FallbackUsed:    false,
				retainedStepCount: retainedLedger.length,
				unmetGapCount:     unmetGaps.length,
				failureChain,
				perStepTrace,
				sketchReplans,
				terminationVerdict: terminationVerdict ?? 'reviewer-accept',
			},
		};
	}

	// L2 fallback path.
	const l2Markdown = await input.l2Fallback({
		todo: input.todo, memory: input.memory, reason: l2Reason,
	});
	const entry = buildL2Entry({
		todo: input.todo, detail: l2Markdown, l2Reason,
	});
	return {
		entry,
		trace: {
			stepsRun,
			recyclesConsumed,
			l2FallbackUsed:    true,
			retainedStepCount: retainedLedger.length,
			unmetGapCount:     unmetGaps.length,
			failureChain,
			perStepTrace,
			sketchReplans,
			terminationVerdict: 'l2',
		},
	};
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/**
 * Build the selective cross-step priors block for a step about to execute.
 *
 * A skill call's `dependsOn` field can be:
 *   - intra-step: a bare skill id (e.g. `"s1.a"`) -- handled inside
 *     executeDiscoveryStep by the within-step skillOutputs merge.
 *   - cross-step: "stepId.skillId" -- handled here. We pull the matching
 *     raw output from the per-TODO `crossStepRawOutputs` cache so the
 *     dependent step's shape-resolver sees the literal entityId / hash /
 *     other lookup-derived value, not the summarized ledger paraphrase.
 */
function collectCrossStepPriors(
	step:               DiscoveryStep,
	crossStepRawOutputs: Readonly<Record<string, string>>,
): Record<string, string> {
	const wanted: Record<string, string> = {};
	for (const sk of step.skills) {
		const dep = sk.dependsOn;
		if (typeof dep !== 'string' || !dep.includes('.')) {
			continue;   // intra-step dep -- handled by executeDiscoveryStep
		}
		const raw = crossStepRawOutputs[dep];
		if (raw !== undefined) {
			wanted[dep] = raw;
		}
	}
	return wanted;
}

/**
 * Build the per-step `LeafBuildContext` payload when the orchestrator
 * has a sessionId wired (Phase 3 of plans/section-flow-architecture-
 * redesign.md). Pulls the artifact_vec rows for the session, renders
 * them via the existing TOC composer, and packs the result + the
 * caller-supplied LocalMemoryView into a payload the leaf-executor
 * threads into `runBuildContext`. Returns `undefined` when no
 * sessionId is set.
 */
async function maybeBuildContext(
	input:          TodoOrchestratorInput,
	step:           DiscoveryStep,
	retainedLedger: readonly StepOutput[],
): Promise<LeafBuildContext | undefined> {
	if (input.sessionId === undefined || input.sessionId.length === 0) {
		return undefined;
	}
	void step;
	try {
		const toc = await buildToc({ sessionId: input.sessionId });
		const rendered = renderToc(toc);
		const tocIds = new Set(toc.entries.map(e => e.id));
		// Fold the latest 2 retained steps into LocalMemoryView.recentSteps
		// so the build-context turn sees what just happened. This is the
		// piece that makes the local view actually informative -- without
		// it the field stays empty for the whole TODO. The whole view
		// then passes through `enforceLocalViewBudget` so a pathological
		// recentSteps render can't blow the local context budget.
		const memory = input.localMemory !== undefined
			? enforceLocalViewBudget({
				...input.localMemory,
				toc: rendered,
				recentSteps: renderRecentSteps(retainedLedger),
			})
			: undefined;
		const payload: LeafBuildContext = {
			todoObjective: input.todo.objective,
			toc:           rendered,
			tocIds,
			...(memory !== undefined ? { memory } : {}),
		};
		return payload;
	} catch (err) {
		log.warn({
			todoId: input.todo.id, stepId: step.id,
			err: (err as Error).message,
		}, 'todo-orchestrator: TOC build failed; skipping build-context for this step');
		return undefined;
	}
}

/**
 * Render the last 2 retained steps as a compact `recentSteps` block
 * for the LocalMemoryView. Each step gets one line: `<stepId>
 * (<status>): <truncated rawOutput digest>`. Empty when the ledger
 * has no entries yet (first decide turn, replan-sketch reset, etc.).
 */
function renderRecentSteps(retainedLedger: readonly StepOutput[]): string {
	if (retainedLedger.length === 0) { return ''; }
	const last = retainedLedger.slice(-2);
	const lines: string[] = [];
	for (const out of last) {
		const callDigests: string[] = [];
		for (const [callId, raw] of Object.entries(out.rawOutputs)) {
			const clean = raw.trim().replace(/\s+/g, ' ');
			if (clean.length === 0) {
				callDigests.push(`${callId}=(empty)`);
				continue;
			}
			const head = clean.slice(0, 120);
			const tail = clean.length > 120 ? '...' : '';
			callDigests.push(`${callId}=${head}${tail}`);
		}
		lines.push(`- ${out.stepId} (${out.status}): ${callDigests.join('; ')}`);
	}
	return lines.join('\n');
}

/**
 * Render the TOC for the decide-next-step turn. Returns an empty-TOC
 * placeholder when no sessionId is wired OR when the Lance read fails
 * -- the decider still runs (it'll emit a step from the sketch).
 */
async function safeRenderToc(sessionId: string | undefined): Promise<string> {
	if (sessionId === undefined || sessionId.length === 0) {
		return '## TABLE OF CONTENTS\n(no artifacts persisted yet)';
	}
	try {
		const toc = await buildToc({ sessionId });
		return renderToc(toc);
	} catch (err) {
		log.warn({ sessionId, err: (err as Error).message }, 'todo-orchestrator: TOC render failed; using empty placeholder');
		return '## TABLE OF CONTENTS\n(toc render failed)';
	}
}

/**
 * Walk `stepSummaries[stepId][callId]` and write each summary back to
 * the matching `artifact_vec` row via `updateArtifactSummary`. Quiet
 * skip when:
 *
 *   - The decider emitted a summary for a (stepId, callId) tuple that
 *     didn't produce an artifact (e.g. the call returned empty -- no
 *     spill happened).
 *   - The artifact id doesn't exist on disk anymore (purged session
 *     -- `updateArtifactSummary` itself soft-fails).
 *
 * Phase 4 batch 4.2 reuses the helper from Phase 1: the dynamic loop's
 * decide-next-step emits summaries with the same shape the cycle-
 * review v2 writer used to produce.
 */
async function persistStepSummaries(
	stepSummaries:    Readonly<Record<string, Readonly<Record<string, string>>>>,
	cycleArtifactIds: Readonly<Record<string, Readonly<Record<string, string>>>>,
): Promise<void> {
	for (const [stepId, callMap] of Object.entries(stepSummaries)) {
		const stepArtifactIds = cycleArtifactIds[stepId];
		if (stepArtifactIds === undefined) { continue; }
		for (const [callId, summary] of Object.entries(callMap)) {
			const artifactId = stepArtifactIds[callId];
			if (artifactId === undefined) { continue; }
			try {
				await updateArtifactSummary(artifactId, summary);
			} catch (err) {
				log.warn({
					stepId, callId, artifactId,
					err: (err as Error).message,
				}, 'persistStepSummaries: updateArtifactSummary threw; continuing');
			}
		}
	}
}

/**
 * Cap on raw-output rendering inside the prompt-bound digest. The
 * full payload is on disk + indexed in `artifact_vec`; the digest
 * is just enough for the next leaf's shape-resolver to recognise
 * what happened.
 */
const RAW_OUTPUT_DIGEST_CHARS = 400;

/**
 * Per-step digest the orchestrator threads into the NEXT step's
 * shape-resolver via `priorStepOutputs[stepId]`. Each call gets a
 * single line: `<callId> (<truncated raw text>)`.
 */
function stringifyStepOutput(out: StepOutput): string {
	const callIds = Object.keys(out.rawOutputs);
	if (callIds.length === 0) {
		return `(step ${out.stepId} ran no skill calls; status=${out.status})`;
	}
	const lines = [`status: ${out.status}`];
	for (const callId of callIds) {
		const raw = (out.rawOutputs[callId] ?? '').trim().replace(/\s+/g, ' ');
		if (raw.length === 0) {
			lines.push(`- ${callId}: (empty)`);
			continue;
		}
		const head = raw.slice(0, RAW_OUTPUT_DIGEST_CHARS);
		const tail = raw.length > RAW_OUTPUT_DIGEST_CHARS ? '...' : '';
		lines.push(`- ${callId}: ${head}${tail}`);
	}
	return lines.join('\n');
}

/**
 * Pre-resolve the decider-emitted goal-aware summary for each step in
 * the retained ledger by reading `artifact_vec.summary`. Falls back to
 * a digest of the raw output when the row's summary never landed
 * (e.g. the loop terminated before the next decide turn that would
 * have summarised that step) -- the section-review/synthesis prompt
 * always has SOMETHING, never "(no facts)".
 */
async function resolveStepSummaries(
	retainedLedger: readonly StepOutput[],
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const stepOutput of retainedLedger) {
		const parts: string[] = [];
		for (const callId of Object.keys(stepOutput.rawOutputs)) {
			const artifactId = stepOutput.artifactIds[callId];
			let summary: string | undefined;
			if (artifactId !== undefined) {
				try {
					const row = await getArtifactById(artifactId);
					const fromRow = row?.summary?.trim();
					if (fromRow !== undefined && fromRow.length > 0) {
						summary = fromRow;
					}
				} catch (err) {
					log.warn({
						stepId: stepOutput.stepId, callId, artifactId,
						err: (err as Error).message,
					}, 'resolveStepSummaries: getArtifactById threw; falling back to raw digest');
				}
			}
			if (summary === undefined) {
				const raw = (stepOutput.rawOutputs[callId] ?? '').trim().replace(/\s+/g, ' ');
				if (raw.length === 0) {
					summary = '(empty)';
				} else {
					const head = raw.slice(0, RAW_OUTPUT_DIGEST_CHARS);
					const tail = raw.length > RAW_OUTPUT_DIGEST_CHARS ? '...' : '';
					summary = `${head}${tail}`;
				}
			}
			parts.push(`- ${callId}: ${summary}`);
		}
		out.set(stepOutput.stepId, parts.length > 0 ? parts.join('\n') : '(no calls)');
	}
	return out;
}

/**
 * Convert the retained ledger into the legacy `WorkingMemoryFindings`
 * shape so the existing `step-section-review` reviewer can read it
 * unchanged. Each StepOutput becomes a synthetic `PerRootFinding`
 * with verdict mapped from status and content sourced from the
 * pre-resolved per-step summary map.
 */
function ledgerToFindings(
	retainedLedger:    readonly StepOutput[],
	summariesByStep:   ReadonlyMap<string, string>,
): WorkingMemoryFindings {
	const perRoot: PerRootFinding[] = retainedLedger.map(o => ({
		rootId:         o.stepId,
		verdict:        o.status === 'failed' ? 'force-accept' as const : 'accept' as const,
		cyclesConsumed: 0,
		exhausted:      o.status === 'failed',
		content:        summariesByStep.get(o.stepId) ?? '(no summary)',
	}));
	return { perRoot };
}

// ---------------------------------------------------------------------------
// Entry construction
// ---------------------------------------------------------------------------

interface BuildSuccessEntryInput {
	readonly todo:             TodoSpec;
	readonly detail:           string;
	readonly retainedLedger:   readonly StepOutput[];
	readonly summariesByStep:  ReadonlyMap<string, string>;
	readonly unmetGaps:        readonly RequiredFact[];
	readonly factGapRetried:   boolean;
	readonly sectionExhausted: boolean;
	readonly synthFallback:    boolean;
}

function buildSuccessEntry(input: BuildSuccessEntryInput): WorkingMemoryEntry {
	const detailWithMarkers = appendAnnotations(input.detail, {
		sectionExhausted: input.sectionExhausted,
		factGapRetried:   input.factGapRetried,
		synthFallback:    input.synthFallback,
		unmetGapCount:    input.unmetGaps.length,
	});
	const perRoot: PerRootFinding[] = input.retainedLedger.map(o => ({
		rootId:         o.stepId,
		verdict:        o.status === 'failed' ? 'force-accept' as const : 'accept' as const,
		cyclesConsumed: 0,
		exhausted:      o.status === 'failed',
		content:        input.summariesByStep.get(o.stepId) ?? '(no summary)',
	}));
	return {
		todoId:      input.todo.id,
		objective:   input.todo.objective,
		detail:      detailWithMarkers,
		findings:    { perRoot },
		completedAt: Date.now(),
		origin:      input.todo.origin as TodoOrigin,
	};
}

interface BuildL2EntryInput {
	readonly todo:     TodoSpec;
	readonly detail:   string;
	readonly l2Reason: string;
}

function buildL2Entry(input: BuildL2EntryInput): WorkingMemoryEntry {
	const l2Finding: PerRootFinding = {
		rootId:         'l2-fallback',
		verdict:        'L2-fallback',
		cyclesConsumed: 0,
		exhausted:      false,
		content:        `L2 fallback invoked. Reason: ${input.l2Reason}`,
	};
	return {
		todoId:      input.todo.id,
		objective:   input.todo.objective,
		detail:      input.detail,
		findings:    { perRoot: [l2Finding], fallback: 'L2' },
		completedAt: Date.now(),
		origin:      input.todo.origin as TodoOrigin,
	};
}

interface Annotations {
	readonly sectionExhausted: boolean;
	readonly factGapRetried:   boolean;
	readonly synthFallback:    boolean;
	readonly unmetGapCount:    number;
}

function appendAnnotations(detail: string, a: Annotations): string {
	const notes: string[] = [];
	if (a.sectionExhausted)        { notes.push('section-review-exhausted'); }
	if (a.factGapRetried)          { notes.push('fact-gap-corrected'); }
	if (a.synthFallback)           { notes.push('synthesis-fallback'); }
	if (a.unmetGapCount > 0)       { notes.push(`unmet-gaps:${a.unmetGapCount}`); }
	if (notes.length === 0)        { return detail; }
	return `${detail}\n\n<!-- section-flow: ${notes.join(', ')} -->`;
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _buildSuccessEntryForTest      = buildSuccessEntry;
export const _buildL2EntryForTest           = buildL2Entry;
export const _appendAnnotationsForTest      = appendAnnotations;
export const _ledgerToFindingsForTest       = ledgerToFindings;
export const _stringifyStepOutputForTest    = stringifyStepOutput;
export const _collectCrossStepPriorsForTest = collectCrossStepPriors;
export const _persistStepSummariesForTest   = persistStepSummaries;
export const _resolveStepSummariesForTest   = resolveStepSummaries;
export const DEFAULT_MAX_RECYCLES_VALUE     = DEFAULT_MAX_RECYCLES;
