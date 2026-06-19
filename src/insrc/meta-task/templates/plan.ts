/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `/plan` meta-task template (M4.a Phase 4).
 *
 * Six steps -- P1 analyze, P2 gather, P3 draft, P4 validate, P5 detail,
 * P6 synth -- composed via the meta-task framework's two-phase loop.
 * Per-step phase-2 system preludes flow from the legacy planner's
 * prompts (verbatim ports in `plan-prompts.ts`). P4 + P6 use the
 * Phase2Runner escape hatch from M4.a Phase 1 to skip the cloud LLM.
 *
 * Plan ref: plans/meta-task-plan.md Phase 4.
 * Design ref: design/meta-task-plan.html §4.
 *
 * User-facing entry: the IDE's chat panel routes `/plan <intent>`
 * directly to `meta-task.run` with templateId='plan' via the existing
 * regex in `chatView.ts` (M2 work); landing this template makes that
 * route actually succeed instead of returning "unknown template".
 *
 * Memory-context M3 registration: the template's owner is
 * `agent:meta-task:plan` and declares assertion-interests for the
 * five subjects most relevant to planning. Chat-side preference
 * captures with matching subjects fan out here automatically via the
 * substrate's AssertionIndex.
 */

import type { AssertionInterest } from '../../daemon/substrate/types.js';
import type { Plan, ScopeManifest, StepDescriptor } from '../types.js';
import type { MetaTaskTemplate } from './index.js';
import {
	PLAN_ANALYZE,
	PLAN_DETAIL,
	PLAN_DRAFT_COMBINED,
	PLAN_GATHER,
} from './plan-prompts.js';
import { planSynthRunner }   from './plan-step-synth.js';
import { planValidateRunner } from './plan-step-validate.js';


/**
 * memory-context M3.2 -- subjects this template wants preferences routed to.
 * Per design/memory-context.html §G3 + the M3 design plan: a planning step
 * reflects test policy + documentation expectations + code style +
 * architectural patterns + workflow conventions. Other subjects (commit,
 * dependency, security, data, communication, escalation) route to other
 * owners.
 */
const PLAN_ASSERTION_INTERESTS: readonly AssertionInterest[] = [
	{ subjectPattern: 'test-policy',          description: 'Test coverage + style reflected in plan steps' },
	{ subjectPattern: 'documentation-policy', description: 'Doc requirements per plan step' },
	{ subjectPattern: 'code-style',           description: 'Code conventions reflected in plan steps' },
	{ subjectPattern: 'architecture-policy',  description: 'Architectural patterns per plan step' },
	{ subjectPattern: 'workflow-policy',      description: 'Workflow conventions baked into the plan' },
];


function planFn(scope: ScopeManifest): Plan {
	const steps: StepDescriptor[] = [
		{
			name:                 'P1 analyze',
			intent:               `Classify the planning request and emit the typed analysis (category, subCategory, goals, constraints, scope). Source intent: ${scope.intent}`,
			acceptance: [
				{
					id:          'hard.analysis-shape',
					description: 'Deliverable body parses to { category, subCategory, goals[], constraints[], scope } per the closed-enum taxonomy.',
					kind:        'hard',
				},
			],
			phase2SystemPrelude:  PLAN_ANALYZE,
		},
		{
			name:                 'P2 gather',
			intent:               'Synthesize the fetcher chunks into a focused codebase context summary for P3 to draft against.',
			acceptance: [
				{
					id:          'soft.gather-body',
					description: 'Deliverable body is non-empty markdown describing relevant entities, memory, and configuration.',
					kind:        'soft',
				},
			],
			phase2SystemPrelude:  PLAN_GATHER,
		},
		{
			name:                 'P3 draft',
			intent:               'Produce a refined ordered step list from the P1 analysis + P2 codebase context. One-pass refined output (per design O3).',
			acceptance: [
				{
					id:          'hard.draft-steps',
					description: 'Deliverable body parses to a non-empty array of RawStep objects.',
					kind:        'hard',
				},
			],
			phase2SystemPrelude:  PLAN_DRAFT_COMBINED,
		},
		{
			name:                 'P4 validate',
			intent:               'Deterministically check the drafted plan for cycles, missing dependencies, and shape issues.',
			acceptance: [
				{
					id:          'hard.no-cycles',
					description: 'Plan has no dependency cycles; missing-dep or empty-plan triggers abort plan-revisable.',
					kind:        'hard',
				},
			],
			phase2:               planValidateRunner,    // M4.a Phase 1 escape hatch -- no LLM call.
		},
		{
			name:                 'P5 detail',
			intent:               'Enrich each step with category-specific data. Emits the (skipped) sentinel when the category lacks a domain schema (documentation / operational / design).',
			acceptance: [
				{
					id:          'soft.detail-body',
					description: 'Deliverable body is a JSON array of enrichments OR the (skipped) sentinel.',
					kind:        'soft',
				},
			],
			phase2SystemPrelude:  PLAN_DETAIL,
		},
		{
			name:                 'P6 synth',
			intent:               'Assemble the final Plan from the P1 analysis + P3 draft + P5 detail and serialize to round-trippable markdown via toMarkdown.',
			acceptance: [
				{
					id:          'hard.round-trip',
					description: 'Body is round-trippable via fromMarkdown.',
					kind:        'hard',
				},
			],
			phase2:               planSynthRunner,       // M4.a Phase 1 escape hatch -- no LLM call.
		},
	];
	return { revision: 0, steps };
}


export const planTemplate: MetaTaskTemplate = {
	id:                 'plan',
	displayName:        'Plan',
	worktreeMode:       'none',
	plan:               planFn,
	// Per-step preludes (P1, P2, P3, P5) override the template-level slot;
	// P4 + P6 bypass the LLM via Phase2Runner so no prelude needed.
	// No template-level prelude shared across steps.
	// memory-context M3 owner declaration.
	ownerId:            'agent:meta-task:plan',
	schemaVersion:      1,
	assertionInterests: PLAN_ASSERTION_INTERESTS,
	memorySchema: [
		{ namespace: 'user-assertions', kind: 'constraint' },
	],
};
