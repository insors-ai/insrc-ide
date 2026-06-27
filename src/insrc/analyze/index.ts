/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Analyze framework -- top-level barrel.
 *
 * See: design/analyze-framework.md
 */

export { CONTRACT_FOOTER_MD } from './contract.js';
export { shaperFor, PROMPT_PATHS } from './context/index.js';
export { validateAnalyzePrompts, AnalyzePromptValidationError } from './context/boot-validator.js';
export type * from './context/types.js';

// Classifier surface -- consumed by the framework outer-loop after
// the classification shaper has built the workspace bundle.
export {
	classify,
	CLASSIFY_PROMPT_PATH,
	ClassifierLlmUnavailableError,
	ClassifierPromptMissingError,
	ClassifierSchemaUnrecoverable,
	ClassifierValidationExhausted,
	isKindCompatibleWithTarget,
	validateIntentSemantics,
	validateIntentShape,
	validateIntentShapeWithErrors,
	CLASSIFIED_INTENT_SCHEMA,
	CLASSIFIER_SCHEMA_VERSION,
	TARGET_ENUM,
	SCOPE_BUCKET_ENUM,
	SCOPE_REF_KIND_ENUM,
} from './classifier/index.js';
export type {
	ClassifyInput,
	ClassifyOpts,
	ClassifyResponse,
	ClassifyErrorCode,
	ClassifyErrorPayload,
	ValidationFailure,
} from './classifier/index.js';

// Planner surface -- types + validator + template registry + driver.
export {
	validatePlan,
	SCOPE_BAND,
	PLAN_TASK_SCHEMA,
	PLANNED_TASK_SCHEMA,
	registerTemplate,
	registerBuiltinTemplates,
	getTemplateCatalog,
	getTemplatesForTarget,
	getTemplate,
	getAggregatorFor,
	TemplateRegistrationError,
	runPlanner,
	PLANNER_PROMPT_PATH,
	PlanBuilderExhausted,
	PlanBuilderLlmUnavailableError,
	PlanBuilderPromptMissingError,
	PlanBuilderSchemaUnrecoverable,
	MaxPlanDepthExceededError,
	renderCatalog,
	renderDepthPolicy,
} from './planner/index.js';
export type { MaxPlanDepthMap } from './planner/index.js';
export type {
	PlanBuilderInput,
	PlanBuilderOpts,
	PlanBuilderResponse,
	PlanBuilderErrorCode,
	PlanBuilderErrorPayload,
	PlanTask,
	PlannedTask,
	PlanInvariantId,
	PlanValidationFailure,
} from './planner/index.js';
