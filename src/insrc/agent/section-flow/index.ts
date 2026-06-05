/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
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
