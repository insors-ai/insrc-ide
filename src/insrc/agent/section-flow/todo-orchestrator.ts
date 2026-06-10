/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * TODO orchestrator -- Phase epsilon cutover of
 * plans/section-flow-fact-gap-loop.md.
 *
 * Drives one TODO through the fact-gap-driven task loop:
 *
 *   Stage 0  runFactGapAnalysis(todo, memory, catalog)
 *            -> FactGapAnalysis (required facts + present/partial/absent)
 *
 *   Trivial fast-path: every fact present -> straight to Stage 6.
 *
 *   Cycle loop (max 3 cycles):
 *     Stage 1  runDiscoveryPlanExpansion(...) -> DiscoveryStep[]
 *     Stage 2  executeDiscoveryStep(step) per step -> StepOutput
 *     Stage 3  runCycleReview(...) -> { keep, new_steps, scratchpad }
 *     Stage 4  ledger update + cycleMemory recompute (mechanical)
 *     Stage 5  termination check (new_steps empty | cycle cap |
 *              two consecutive zero-keep cycles)
 *
 *   Stage 6  synthesizeSectionFromLedger(retainedLedger, unmet gaps)
 *            -> section markdown (unmet gaps render as structured
 *               handoff blocks per Decision #14)
 *   Stage 7  reviewSection(...) -- existing Q5 reviewer; verdicts
 *            unchanged. revise-major triggers one re-cycle (Stage 0
 *            again with the reviewer's complaint as memory hint).
 *
 * L2 fallback paths (Q10 floor): any Stage throw, OR cycle loop
 * terminates with empty retained ledger AND all facts unmet, OR
 * the section-review revise-major re-cycle also fails -- the
 * orchestrator invokes the caller-supplied L2 fallback.
 *
 * Output: a fully-formed `WorkingMemoryEntry`. On the L2 path,
 * `entry.findings.fallback === 'L2'` and `perRoot` carries a
 * synthetic `L2-fallback` entry so downstream consumers (Q5 / Q7
 * / Q8) can detect the floor was hit.
 */

import type { LLMProvider } from '../../shared/types.js';
import type { MemoryShapeBundle } from '../working-memory/index.js';
import type {
	PerRootFinding,
	TodoOrigin,
	WorkingMemoryEntry,
	WorkingMemoryFindings,
} from '../working-memory/types.js';
import type { TodoSpec } from './types.js';
import type { ExecuteLeaf } from './leaf-executor.js';
import type { CatalogSkill } from '../content-gen/plan-tree-runner.js';
import type {
	CycleMemory,
	DiscoveryStep,
	StepOutput,
} from '../content-gen/discovery-plan.js';
import { emptyCycleMemory } from '../content-gen/discovery-plan.js';
import { runFactGapAnalysis } from './step-fact-gap-analysis.js';
import { runDiscoveryPlanExpansion } from './step-discovery-plan-expansion.js';
import { executeDiscoveryStep } from './step-discovery-execute.js';
import { runCycleReview } from './step-cycle-review.js';
import { synthesizeSectionFromLedger } from './step-synthesis-from-ledger.js';
import { reviewSection } from './step-section-review.js';
import { computeCoverage } from './cycle-memory.js';
import { gapFacts, isTrivialFastPath, type RequiredFact } from './fact-gap-types.js';
import { updateArtifactSummary } from '../../db/lance/artifact-vec.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:todo-orchestrator');

const DEFAULT_MAX_CYCLES = 3;
/** Cap on revise-major-triggered re-runs of Stage 0 + the cycle loop. */
const DEFAULT_MAX_RECYCLES = 1;

// ---------------------------------------------------------------------------
// L2 fallback contract
// ---------------------------------------------------------------------------

export interface L2FallbackInput {
	readonly todo:    TodoSpec;
	readonly memory:  MemoryShapeBundle;
	/** Why the orchestrator fell back; useful as L2 prompt context. */
	readonly reason:  string;
}

/**
 * Caller (run-section-flow) supplies this when wiring the TODO
 * orchestrator. Returns the section markdown the L2 skill produced.
 * Implementations are expected to invoke whichever
 * `<owner>.answer-question` skill matches the pipeline.
 */
export type L2Fallback = (input: L2FallbackInput) => Promise<string>;

// ---------------------------------------------------------------------------
// Public input / output
// ---------------------------------------------------------------------------

export interface TodoOrchestratorInput {
	readonly todo:        TodoSpec;
	readonly memory:      MemoryShapeBundle;
	readonly provider:    LLMProvider;
	readonly executeLeaf: ExecuteLeaf;
	readonly l2Fallback:  L2Fallback;
	/**
	 * Skill catalog the discovery loop composes from. Required for
	 * production (Stage 0 / 1 / 3 validate against it). Empty catalog
	 * forces the orchestrator to L2 immediately -- there's no way to
	 * close any gap without skills.
	 */
	readonly catalog:     readonly CatalogSkill[];
	/** Cycle cap (default 3, matching the canonical discovery-plan-loop design). */
	readonly maxCycles?:  number | undefined;
	/** Cap on revise-major-triggered recycles. Default 1. */
	readonly maxRecycles?: number | undefined;
}

export interface TodoOrchestratorTrace {
	readonly cyclesRun:           number;
	readonly recyclesConsumed:    number;
	readonly l2FallbackUsed:      boolean;
	readonly retainedStepCount:   number;
	readonly unmetGapCount:       number;
	readonly failureChain:        readonly string[];
	readonly perCycleSummary:     readonly {
		readonly cycle:        1 | 2 | 3;
		readonly stepsRun:     number;
		readonly keptIds:      readonly string[];
		readonly newStepsAsk:  number;
	}[];
}

export interface TodoOrchestratorResult {
	readonly entry: WorkingMemoryEntry;
	readonly trace: TodoOrchestratorTrace;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runTodoOrchestrator(
	input: TodoOrchestratorInput,
): Promise<TodoOrchestratorResult> {
	const maxCycles   = input.maxCycles   ?? DEFAULT_MAX_CYCLES;
	const maxRecycles = input.maxRecycles ?? DEFAULT_MAX_RECYCLES;
	const failureChain: string[] = [];
	let perCycleSummary: { cycle: 1 | 2 | 3; stepsRun: number; keptIds: readonly string[]; newStepsAsk: number }[] = [];
	let cyclesRun = 0;
	let recyclesConsumed = 0;
	let l2Reason = 'unknown';

	let retainedLedger: readonly StepOutput[] = [];
	let unmetGaps: readonly RequiredFact[] = [];

	// Outer recycle loop -- revise-major from Stage 7 re-runs the whole
	// thing (Stage 0 + cycle loop) once.
	while (true) {
		// Stage 0: fact-gap analysis.
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
			break;
		}

		// Trivial fast-path: every required fact already present -> skip
		// Stages 1-5, go straight to Stage 6 with an empty ledger.
		if (isTrivialFastPath(analysis.analysis)) {
			log.info({ todoId: input.todo.id, factCount: analysis.analysis.requiredFacts.length }, 'TODO orchestrator: trivial fast-path (all facts present)');
			retainedLedger = [];
			unmetGaps = [];
			// Memory carries everything; synthesize directly.
			const synth = await synthesizeSectionFromLedger({
				todo: input.todo, memory: input.memory, gapAnalysis: analysis.analysis,
				retainedLedger:  [],
				cycleMemory:     emptyCycleMemory(analysis.analysis.requiredFacts.map(f => f.fact)),
				provider:        input.provider,
			});
			const reviewResult = await reviewSection({
				todo: input.todo, memory: input.memory,
				candidate: synth.markdown,
				findings:  ledgerToFindings([], []),
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
				break;
			}
			const entry = buildSuccessEntry({
				todo:               input.todo,
				detail:             reviewResult.finalMarkdown,
				retainedLedger:     [],
				unmetGaps:          [],
				factGapRetried:     analysis.retried,
				sectionExhausted:   reviewResult.exhausted,
				synthFallback:      synth.usedFallback,
				cyclesRun:          0,
				recyclesConsumed,
			});
			return {
				entry,
				trace: {
					cyclesRun: 0,
					recyclesConsumed,
					l2FallbackUsed:   false,
					retainedStepCount: 0,
					unmetGapCount:    0,
					failureChain,
					perCycleSummary:  [],
				},
			};
		}

		// Normal path: cycle loop.
		const gaps = gapFacts(analysis.analysis);
		let cycleMemory: CycleMemory = emptyCycleMemory(gaps.map(f => f.fact));
		const stepsById = new Map<string, DiscoveryStep>();
		const retained: StepOutput[] = [];
		perCycleSummary = [];
		cyclesRun = 0;
		let priorStepOutputs: Record<string, string> = {};
		// Per-TODO cache of raw skill outputs keyed by "stepId.skillId".
		// Accumulates across all steps in all cycles of this TODO. Forwarded
		// SELECTIVELY into the next step's priorOutputs based on what that
		// step's skills declared in their cross-step `dependsOn` field
		// (the "stepId.skillId" form). Bounded growth: only entries that
		// some downstream step has explicitly asked for ever appear in any
		// prior-outputs block. Discarded when the TODO finishes.
		const crossStepRawOutputs: Record<string, string> = {};
		let stepsToRun: readonly DiscoveryStep[] = [];
		let priorCycleKeepCount = -1;   // -1 sentinel = no prior cycle yet
		let cycleLoopFailureReason: string | undefined;

		for (let cycle = 1 as 1 | 2 | 3; cycle <= maxCycles; cycle = (cycle + 1) as 1 | 2 | 3) {
			// Stage 1 (cycle 1) or use prior cycle's new_steps (cycle 2+).
			if (cycle === 1) {
				try {
					const expansion = await runDiscoveryPlanExpansion({
						todo: input.todo, gapFacts: gaps, memory: input.memory, catalog: input.catalog,
						cycle, cycleMemory, provider: input.provider,
					});
					stepsToRun = expansion.steps;
				} catch (err) {
					cycleLoopFailureReason = `discovery-plan expansion (cycle 1) failed: ${(err as Error).message}`;
					failureChain.push(cycleLoopFailureReason);
					break;
				}
			}
			for (const s of stepsToRun) { stepsById.set(s.id, s); }

			// Stage 2: execute each step.
			const cycleOutputs: StepOutput[] = [];
			// Per-cycle mapping `stepId -> { callId -> spillId }`. Populated
			// from each step's `execRes.skillArtifactIds` as the cycle runs;
			// consumed AFTER cycle-review so the reviewer's per-call goal-
			// aware summaries land on the right `artifact_vec` row.
			const cycleArtifactIds: Record<string, Record<string, string>> = {};
			for (const step of stepsToRun) {
				// Selectively forward raw cross-step outputs the step's skills
				// declared as deps. Only entries whose key matches one of this
				// step's cross-step `dependsOn` values are pulled from the
				// per-TODO cache. Everything else stays out of priorOutputs
				// so the shape-resolver's prior-outputs block stays bounded.
				const crossStepPriors = collectCrossStepPriors(step, crossStepRawOutputs);
				const execRes = await executeDiscoveryStep({
					step,
					priorOutputs: { ...priorStepOutputs, ...crossStepPriors },
					deps: {
						todo: input.todo, gapFacts: gaps,
						executeLeaf:       input.executeLeaf,
						summarizeProvider: input.provider,
					},
				});
				cycleOutputs.push(execRes.output);
				// Append this step's aggregate (stringified) so subsequent
				// steps in the SAME cycle can read it via priorOutputs[stepId].
				priorStepOutputs = {
					...priorStepOutputs,
					[step.id]: stringifyStepOutput(execRes.output),
				};
				// Cache raw per-skill outputs keyed by "stepId.skillId" so
				// later steps (this cycle or next) can declare them via
				// cross-step dependsOn and get the literal text -- not the
				// summarized facts the retained ledger keeps.
				for (const [callId, raw] of Object.entries(execRes.skillOutputs)) {
					if (raw.length > 0) {
						crossStepRawOutputs[`${step.id}.${callId}`] = raw;
					}
				}
				// Remember the per-call artifact ids so the cycle-review
				// summaries can be written back to the right Lance row.
				const ids = execRes.skillArtifactIds;
				if (Object.keys(ids).length > 0) {
					cycleArtifactIds[step.id] = { ...ids };
				}
			}

			// Stage 3: cycle review.
			let review;
			try {
				review = await runCycleReview({
					todo: input.todo, gapFacts: gaps,
					stepsThisCycle: stepsToRun, cycleOutputs,
					cycleMemory, cycle, catalog: input.catalog,
					provider: input.provider,
				});
			} catch (err) {
				cycleLoopFailureReason = `cycle review (cycle ${cycle}) failed: ${(err as Error).message}`;
				failureChain.push(cycleLoopFailureReason);
				break;
			}

			// Persist reviewer-emitted goal-aware summaries onto the
			// `artifact_vec` rows so downstream stages (TOC builder, future
			// Phase 3 build-context retriever) read the claim-shaped text
			// instead of the noisy preview. Best-effort: a write failure
			// for one artifact doesn't abort the cycle.
			await persistStepSummaries(review.stepSummaries, cycleArtifactIds);

			// Stage 4: ledger update + cycleMemory recompute.
			const keepSet = new Set(review.response.keep);
			const keptThisCycle = cycleOutputs.filter(o => keepSet.has(o.stepId));
			retained.push(...keptThisCycle);
			cycleMemory = {
				priorAsks: [
					...cycleMemory.priorAsks,
					{ cycle, steps: stepsToRun.map(s => ({ id: s.id, intent: s.intent })) },
				],
				criteriaCoverage: computeCoverage(retained, gaps.map(f => f.fact), stepsById),
				scratchpad:       review.response.scratchpad ?? cycleMemory.scratchpad,
			};
			perCycleSummary.push({
				cycle,
				stepsRun:     stepsToRun.length,
				keptIds:      keptThisCycle.map(o => o.stepId),
				newStepsAsk:  review.response.new_steps.length,
			});
			cyclesRun = cycle;
			log.info({
				todoId: input.todo.id, cycle, stepsRun: stepsToRun.length,
				keptCount: keptThisCycle.length, newStepsAsk: review.response.new_steps.length,
				retainedTotal: retained.length,
			}, 'TODO orchestrator: cycle complete');

			// Stage 5: termination.
			if (review.response.new_steps.length === 0) { break; }
			if (cycle === maxCycles) { break; }
			// No-progress: this cycle kept zero AND prior cycle kept zero too.
			if (keptThisCycle.length === 0 && priorCycleKeepCount === 0) {
				log.warn({ todoId: input.todo.id, cycle }, 'TODO orchestrator: no-progress safety net -> terminating cycle loop');
				break;
			}
			priorCycleKeepCount = keptThisCycle.length;
			stepsToRun = review.response.new_steps;
		}

		retainedLedger = retained;

		// Hard catastrophic failure: cycle loop never produced any cycle
		// summary (Stage 1 cycle-1 threw) -> L2 immediately.
		if (cycleLoopFailureReason !== undefined && perCycleSummary.length === 0) {
			l2Reason = cycleLoopFailureReason;
			break;
		}

		// Cycle loop produced no retained facts at all -> L2 (the
		// orchestrator has no material for synthesis).
		if (retainedLedger.length === 0) {
			l2Reason = `cycle loop produced no retained facts (${cyclesRun} cycles attempted)`;
			failureChain.push(l2Reason);
			break;
		}

		// Stage 6: synthesis.
		let synth;
		try {
			synth = await synthesizeSectionFromLedger({
				todo: input.todo, memory: input.memory, gapAnalysis: analysis.analysis,
				retainedLedger, cycleMemory, provider: input.provider,
			});
		} catch (err) {
			l2Reason = `synthesis failed: ${(err as Error).message}`;
			failureChain.push(l2Reason);
			break;
		}
		unmetGaps = synth.unmetGaps;

		// Stage 7: section review (Q5 verdicts -- existing reviewer).
		const reviewResult = await reviewSection({
			todo: input.todo, memory: input.memory,
			candidate: synth.markdown,
			findings:  ledgerToFindings(retainedLedger, stepsById ? [...stepsById.values()] : []),
			provider:  input.provider,
		});
		if (reviewResult.reopenRequested && recyclesConsumed < maxRecycles) {
			recyclesConsumed += 1;
			failureChain.push(`section review revise-major (cycle path): ${reviewResult.reopenReason ?? ''}`);
			log.info({ todoId: input.todo.id, recyclesConsumed }, 'section review revise-major -> recycling (re-run Stage 0 + cycle loop)');
			continue;
		}
		if (reviewResult.reopenRequested) {
			l2Reason = `section review revise-major (recycle budget exhausted): ${reviewResult.reopenReason ?? ''}`;
			failureChain.push(l2Reason);
			break;
		}

		// Success.
		const entry = buildSuccessEntry({
			todo:             input.todo,
			detail:           reviewResult.finalMarkdown,
			retainedLedger,
			unmetGaps,
			factGapRetried:   analysis.retried,
			sectionExhausted: reviewResult.exhausted,
			synthFallback:    synth.usedFallback,
			cyclesRun,
			recyclesConsumed,
		});
		log.info({
			todoId: input.todo.id, cyclesRun, recyclesConsumed,
			retainedStepCount: retainedLedger.length, unmetGapCount: unmetGaps.length,
			sectionExhausted: reviewResult.exhausted,
		}, 'TODO orchestrator success');
		return {
			entry,
			trace: {
				cyclesRun,
				recyclesConsumed,
				l2FallbackUsed:     false,
				retainedStepCount:  retainedLedger.length,
				unmetGapCount:      unmetGaps.length,
				failureChain,
				perCycleSummary,
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
			cyclesRun,
			recyclesConsumed,
			l2FallbackUsed:     true,
			retainedStepCount:  retainedLedger.length,
			unmetGapCount:      unmetGaps.length,
			failureChain,
			perCycleSummary,
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
 *
 * Only declared deps cross the boundary. Unselected entries stay out of
 * the prior-outputs block so it doesn't balloon as the cycle progresses.
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
 * Walk `stepSummaries[stepId][callId]` and write each summary back to
 * the matching `artifact_vec` row via `updateArtifactSummary`. Quiet
 * skip when:
 *
 *   - The reviewer summarised a (stepId, callId) tuple that didn't
 *     produce an artifact (e.g. the call returned empty -- no spill
 *     happened; `cycleArtifactIds[stepId][callId]` is undefined).
 *   - The artifact id doesn't exist on disk anymore (purged session
 *     -- `updateArtifactSummary` itself soft-fails).
 *
 * Phase 1 of plans/section-flow-architecture-redesign.md. This
 * replaces the standalone `summarizeResult` write that previously
 * lived in `step-discovery-execute.ts` -- the cloud LLM now folds
 * the summary into its review response in one call.
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

function stringifyStepOutput(out: StepOutput): string {
	if (out.facts.length === 0) {
		return `(step ${out.stepId} returned no facts; status=${out.status})`;
	}
	const lines = [`status: ${out.status}`, ...out.facts.map(f => `- ${f}`)];
	if (out.citations.length > 0) {
		lines.push('citations:');
		for (const c of out.citations) {
			const range = c.startLine !== undefined && c.endLine !== undefined
				? `#L${c.startLine}-L${c.endLine}`
				: (c.startLine !== undefined ? `#L${c.startLine}` : '');
			lines.push(`- ${c.path}${range}`);
		}
	}
	return lines.join('\n');
}

/**
 * Convert the retained ledger into the legacy `WorkingMemoryFindings`
 * shape so the existing `step-section-review` reviewer can read it
 * unchanged. Each StepOutput becomes a synthetic `PerRootFinding`
 * with verdict mapped from status.
 */
function ledgerToFindings(
	retainedLedger: readonly StepOutput[],
	_steps:         readonly DiscoveryStep[],
): WorkingMemoryFindings {
	void _steps;
	const perRoot: PerRootFinding[] = retainedLedger.map(o => ({
		rootId:         o.stepId,
		// Status -> RootVerdict mapping. RootVerdict only allows
		// 'accept' | 'force-accept' | 'L2-fallback'; status `ok`/`partial`
		// both indicate the step contributed evidence, `failed` indicates
		// the step ran but returned empty (kept as `force-accept` so the
		// reviewer sees the attempt without treating it as L2 fallback).
		verdict:        o.status === 'failed' ? 'force-accept' as const : 'accept' as const,
		cyclesConsumed: 0,
		exhausted:      o.status === 'failed',
		content:        o.facts.length > 0 ? o.facts.join('\n') : '(no facts)',
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
	readonly unmetGaps:        readonly RequiredFact[];
	readonly factGapRetried:   boolean;
	readonly sectionExhausted: boolean;
	readonly synthFallback:    boolean;
	readonly cyclesRun:        number;
	readonly recyclesConsumed: number;
}

function buildSuccessEntry(input: BuildSuccessEntryInput): WorkingMemoryEntry {
	const detailWithMarkers = appendAnnotations(input.detail, {
		sectionExhausted: input.sectionExhausted,
		factGapRetried:   input.factGapRetried,
		synthFallback:    input.synthFallback,
		unmetGapCount:    input.unmetGaps.length,
	});
	// Synthesize per-root findings from the retained ledger so the
	// existing WorkingMemoryEntry.findings shape stays satisfied; the
	// memory updater + report-review read this downstream.
	const perRoot: PerRootFinding[] = input.retainedLedger.map(o => ({
		rootId:         o.stepId,
		// Status -> RootVerdict mapping. RootVerdict only allows
		// 'accept' | 'force-accept' | 'L2-fallback'; status `ok`/`partial`
		// both indicate the step contributed evidence, `failed` indicates
		// the step ran but returned empty (kept as `force-accept` so the
		// reviewer sees the attempt without treating it as L2 fallback).
		verdict:        o.status === 'failed' ? 'force-accept' as const : 'accept' as const,
		cyclesConsumed: 0,
		exhausted:      o.status === 'failed',
		content:        o.facts.length > 0 ? o.facts.join('\n') : '(no facts)',
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
export const DEFAULT_MAX_CYCLES_VALUE       = DEFAULT_MAX_CYCLES;
export const DEFAULT_MAX_RECYCLES_VALUE     = DEFAULT_MAX_RECYCLES;
