/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Template module interface.
 *
 * Each template defines two render functions:
 *
 *   - `renderSpec(input)`     -- builds the spec markdown the external
 *                                agent reads (scope + criteria +
 *                                discovery guidance; light on content
 *                                per design §5.2).
 *   - `renderDeliverableStub` -- documents the deliverable shape the
 *                                agent's output is validated against
 *                                at audit time (Phase 4).
 *
 * Plus an `acceptanceFor(input)` helper so the template author owns
 * the default acceptance-criteria slate (callers can extend / override).
 *
 * Why two render shapes per template: design §5.2's "two-shape"
 * carve-out -- the spec the agent reads and the deliverable shape it
 * returns are different artifacts. The spec is scope+criteria
 * authored by insrc; the deliverable structure is what the agent's
 * output is validated against.
 */

import type {
	AcceptanceCriterion,
	MemoryRef,
	PermissionsBlock,
	RiskTag,
	ScopePayload,
	TemplateId,
} from '../types.js';

/**
 * Input shared by every template's renderSpec function. Template
 * modules MAY narrow this with template-specific extras (e.g. the
 * failing test name for DEBUG-SESSION) via a discriminated union.
 */
export interface RenderSpecInput {
	readonly intent:      string;
	readonly scope:       ScopePayload;
	readonly memoryRefs:  readonly MemoryRef[];
	readonly acceptance:  readonly AcceptanceCriterion[];
	readonly permissions: PermissionsBlock;
	readonly riskTag:     RiskTag;
	readonly worktreePath: string;
	readonly timeBudgetSec: number;
}

/**
 * Per-template-id discriminator. The template id is on the input so
 * registry-level helpers can route to the right module without
 * downcasts.
 */
export interface TemplateDefinition<Input extends RenderSpecInput = RenderSpecInput> {
	readonly id:                   TemplateId;
	readonly version:              number;
	/** Default risk floor; deterministic ratchet may raise it (Phase 3). */
	readonly defaultRisk:          RiskTag;
	/** Build the spec markdown the external agent reads. */
	readonly renderSpec:           (input: Input) => string;
	/** Documents the deliverable shape; rendered into the spec's tail. */
	readonly renderDeliverableStub: () => string;
	/**
	 * Default acceptance criteria for this template. Caller can extend
	 * with extras; this is the floor.
	 */
	readonly defaultAcceptance:    (input: Input) => readonly AcceptanceCriterion[];
}
