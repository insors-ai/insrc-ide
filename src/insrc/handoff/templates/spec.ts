/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * SPEC template -- code change request.
 *
 * Used when the user wants the external agent to implement a
 * concrete feature / refactor / change against a defined scope.
 * The DEBUG-SESSION template's "evidence" framing doesn't apply;
 * SPEC instead requires the agent to declare a plan before
 * implementing, walk through the changes it made, document tests,
 * and call out residual risks / follow-ups.
 *
 * Default risk: `low`. Path-based ratchet (Phase 3) may raise it
 * for migrations / infra / push-type bash commands.
 *
 * Deliverable shape (audit pipeline matches `^## <Name>` at level 2):
 *   - Plan        -- proposed approach + file list, *before* edits
 *   - Implement   -- what changed, file by file, with rationale
 *   - Test        -- new / modified tests + actual run output
 *   - Notes       -- residual risks, follow-ups, anything skipped
 */

import type { AcceptanceCriterion } from '../types.js';
import type { RenderSpecInput, TemplateDefinition } from './types.js';
import {
	renderObjective,
	renderScope,
	renderMemoryExcerpts,
	renderAcceptanceCriteria,
	renderConstraints,
	renderDiscoveryGuidance,
	renderDeliverableStructureReference,
	renderDeliverableStub,
} from './shared.js';

const TEMPLATE_VERSION = 1;

export interface SpecInput extends RenderSpecInput {
	/**
	 * Optional pointer to the entity the change is centered on
	 * (function, class, module). Surfacing it in the spec keeps
	 * the agent from guessing; falls back to entity_search when
	 * absent.
	 */
	readonly anchorEntityId?: string | undefined;
}

const SECTIONS = [
	{ name: 'Plan',      oneLine: 'proposed approach + file list, BEFORE you edit anything.' },
	{ name: 'Implement', oneLine: 'what changed file by file, with one-line rationale per edit.' },
	{ name: 'Test',      oneLine: 'tests added/modified + the exact command + verbatim output tail.' },
	{ name: 'Notes',     oneLine: 'residual risks, follow-ups, anything you skipped + why.' },
] as const;

export const SPEC_REQUIRED_SECTIONS = SECTIONS.map(s => s.name);

function renderSpec(input: SpecInput): string {
	const sections: string[] = [];
	sections.push(`# Spec: ${input.intent}`);
	sections.push('');
	sections.push(renderObjective(input));
	sections.push(renderScope(input));
	sections.push(renderMemoryExcerpts(input));
	sections.push(renderAcceptanceCriteria(input));
	sections.push(renderConstraints(input));
	const anchorBullet = input.anchorEntityId !== undefined && input.anchorEntityId.length > 0
		? `Start with \`insrc_entity_get(\"${input.anchorEntityId}\")\` to anchor on the change site.`
		: 'Start with `insrc_entity_search("<feature name>")` to locate the change site.';
	sections.push(renderDiscoveryGuidance({ extraBullets: [anchorBullet] }));
	sections.push(renderDeliverableStructureReference({ sections: SECTIONS }));
	return sections.join('\n');
}

function defaultAcceptance(_input: SpecInput): readonly AcceptanceCriterion[] {
	return [
		{ id: 'soft.matches-plan',  description: 'Implementation matches the Plan section it declared.', kind: 'soft' },
		{ id: 'soft.has-tests',     description: 'At least one new or updated test covers the change.', kind: 'soft' },
		{ id: 'soft.no-regression', description: 'No new test failures introduced outside the change area.', kind: 'soft' },
	];
}

export const specTemplate: TemplateDefinition<SpecInput> = {
	id:                          'SPEC',
	version:                     TEMPLATE_VERSION,
	defaultRisk:                 'low',
	renderSpec,
	renderDeliverableStub:       () => renderDeliverableStub('Spec Deliverable', SPEC_REQUIRED_SECTIONS),
	requiredDeliverableSections: SPEC_REQUIRED_SECTIONS,
	defaultAcceptance,
};
