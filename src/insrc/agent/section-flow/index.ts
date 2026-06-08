/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Section-flow orchestrator module (planner-section-task-separation
 * P2-P5). P2 lands Step 1 (Scope) + Step 2 (Investigation Plan);
 * P3-P5 land the per-TODO section orchestrator + final report
 * assembler + cutover. All exports are dormant until the cutover
 * commit wires them into the data-analyzer orchestrator entrypoint.
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
	runSectionPlanner,
	type SectionPlannerInput,
	type SectionPlannerResult,
} from './step-section-planner.js';

export {
	executeReviewableRoots,
	type PerRootExecutorInput,
	type PerRootExecutorResult,
	type LeafExecutionInput,
	type ExecuteLeaf,
} from './step-root-execution.js';

export {
	assembleSection,
	type SectionAssemblyInput,
	type SectionAssemblyResult,
} from './step-section-assembly.js';

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
} from './leaf-executor.js';

export {
	resolveSkillShape,
	type ShapeResolveInput,
	type ShapeResolveResult,
} from './shape-resolve.js';

// ---------------------------------------------------------------------------
// Fact-gap-driven task loop (Phase alpha of section-flow-fact-gap-loop.md)
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

// Re-export the discovery-plan types so callers don't have to reach
// across modules. These were originally designed for the code-analyzer's
// per-section loop; the fact-gap-loop resurrects them for the per-TODO
// task flow.
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
