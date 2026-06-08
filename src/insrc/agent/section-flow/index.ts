/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Section-flow orchestrator module.
 *
 * Per-TODO task flow runs the fact-gap-driven discovery loop (see
 * plans/section-flow-fact-gap-loop.md). The Phase epsilon cutover
 * (2026-06-09) deleted the linear `step-section-planner` /
 * `step-root-execution` / `step-section-assembly` modules; their
 * roles are now Stages 0-6 of the new flow.
 *
 * Surviving pieces from the prior architecture:
 *   - step-scope + step-investigation-plan        : plan flow (unchanged)
 *   - leaf-executor + shape-resolve               : per-leaf invocation
 *   - step-section-review                         : Stage 7 (Q5 verdicts)
 *   - step-report-assemble + step-report-review   : final report layer
 *   - run-section-flow                            : top-level driver
 */

export type {
	ContextRef,
	ScopeStepResult,
	TodoSpec,
	InvestigationPlanResult,
	SectionFlowState,
} from './types.js';

export {
	runScopeStep,
	extractContextRefs,
	type ScopeStepInput,
} from './step-scope.js';

export {
	runInvestigationPlan,
	type InvestigationPlanInput,
} from './step-investigation-plan.js';

export {
	reviewSection,
	type SectionReviewInput,
	type SectionReviewResult,
} from './step-section-review.js';

export {
	runTodoOrchestrator,
	type TodoOrchestratorInput,
	type TodoOrchestratorResult,
	type TodoOrchestratorTrace,
	type L2Fallback,
	type L2FallbackInput,
} from './todo-orchestrator.js';

export {
	assembleReport,
	type ReportAssembleInput,
	type ReportAssembleResult,
} from './step-report-assemble.js';

export {
	runReportReview,
	type ReportReviewInput,
	type ReportReviewResult,
	type StructuralRevise,
	type StructuralReviseSectionContradiction,
	type StructuralReviseScopeGap,
	type SectionContradictionResolver,
	type ScopeGapResolver,
} from './step-report-review.js';

export {
	runSectionFlow,
	type RunSectionFlowInput,
	type RunSectionFlowResult,
	type RunSectionFlowTrace,
	type ProgressEvent,
} from './run-section-flow.js';

export {
	buildSkillExecutor,
	resolveLeafInputs,
	applyPath,
	stringifySkillValue,
	type LeafExecutorDeps,
	type LeafExecutionInput,
	type ExecuteLeaf,
} from './leaf-executor.js';

export {
	resolveSkillShape,
	type ShapeResolveInput,
	type ShapeResolveResult,
} from './shape-resolve.js';

// ---------------------------------------------------------------------------
// Fact-gap-driven task loop (plans/section-flow-fact-gap-loop.md)
// ---------------------------------------------------------------------------

export {
	summarizeCycleMemory,
	computeCoverage,
} from './cycle-memory.js';

export {
	gapFacts,
	isTrivialFastPath,
	FACT_GAP_ANALYSIS_SCHEMA,
	type RequiredFact,
	type FactGapAnalysis,
	type FactSourceRef,
} from './fact-gap-types.js';

export {
	runFactGapAnalysis,
	type FactGapAnalysisInput,
	type FactGapAnalysisResult,
} from './step-fact-gap-analysis.js';

export {
	runDiscoveryPlanExpansion,
	type DiscoveryPlanExpansionInput,
	type DiscoveryPlanExpansionResult,
} from './step-discovery-plan-expansion.js';

export {
	runCycleReview,
	type CycleReviewInput,
	type CycleReviewResult,
} from './step-cycle-review.js';

export {
	executeDiscoveryStep,
	type DiscoveryExecuteDeps,
	type ExecuteDiscoveryStepInput,
	type ExecuteDiscoveryStepResult,
} from './step-discovery-execute.js';

export {
	synthesizeSectionFromLedger,
	type SynthesisInput,
	type SynthesisResult,
} from './step-synthesis-from-ledger.js';

// Re-export the discovery-plan types so callers don't have to reach
// across modules.
export {
	emptyCycleMemory,
	DISCOVERY_PLAN_SCHEMA,
	CYCLE_REVIEW_RESPONSE_SCHEMA,
	type DiscoveryStep,
	type DiscoveryPlan,
	type PlannedSkillCall,
	type StepOutput,
	type Citation,
	type CycleReviewResponse,
	type CycleMemory,
} from '../content-gen/discovery-plan.js';
