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
