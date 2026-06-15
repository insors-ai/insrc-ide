/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * REQUIREMENTS template -- structured requirements doc.
 *
 * Used to capture *what* a system / feature must do BEFORE design
 * or implementation begins. The agent reads the repo + memory to
 * surface implicit requirements; the deliverable is a structured
 * requirements document the team can use as the basis for design
 * and acceptance.
 *
 * Default risk: `low` (read-only; the deliverable is markdown).
 *
 * Deliverable shape:
 *   - Stakeholders     -- who's affected; one bullet per role
 *   - Goals            -- outcomes the system must produce
 *   - Functional       -- numbered FR-1, FR-2, ... each one testable
 *   - NonFunctional    -- NFR-1, NFR-2, ... performance / security / ops
 *   - Acceptance       -- how the team will know the requirements are met
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

const SECTIONS = [
	{ name: 'Stakeholders',  oneLine: 'who is affected; one bullet per role + their interest.' },
	{ name: 'Goals',         oneLine: 'outcomes the system must produce, in business terms.' },
	{ name: 'Functional',    oneLine: 'numbered FR-1, FR-2, ... each one independently testable.' },
	{ name: 'NonFunctional', oneLine: 'numbered NFR-1, NFR-2, ... performance / security / ops constraints.' },
	{ name: 'Acceptance',    oneLine: 'how the team will know each requirement is met.' },
] as const;

export const REQUIREMENTS_REQUIRED_SECTIONS = SECTIONS.map(s => s.name);

function renderSpec(input: RenderSpecInput): string {
	const sections: string[] = [];
	sections.push(`# Requirements: ${input.intent}`);
	sections.push('');
	sections.push(renderObjective(input));
	sections.push(renderScope(input));
	sections.push(renderMemoryExcerpts(input));
	sections.push(renderAcceptanceCriteria(input));
	sections.push(renderConstraints(input));
	sections.push(renderDiscoveryGuidance({
		extraBullets: [
			'Use `insrc_entity_search` to find existing implementations that hint at implicit requirements.',
			'Functional + NonFunctional requirements MUST be numbered (FR-1, NFR-1, ...) and individually testable.',
		],
	}));
	sections.push(renderDeliverableStructureReference({
		sections: SECTIONS,
		leadIn:   "Write the requirements doc into `spec-deliverable.md` using EXACTLY",
	}));
	return sections.join('\n');
}

function defaultAcceptance(_input: RenderSpecInput): readonly AcceptanceCriterion[] {
	return [
		{ id: 'soft.requirements-numbered', description: 'Functional + NonFunctional sections use FR-N / NFR-N numbering.', kind: 'soft' },
		{ id: 'soft.acceptance-mapped',     description: 'Each requirement has at least one corresponding acceptance hook.', kind: 'soft' },
		{ id: 'soft.stakeholders-named',    description: 'Stakeholders names at least one concrete role.', kind: 'soft' },
	];
}

export const requirementsTemplate: TemplateDefinition = {
	id:                          'REQUIREMENTS',
	version:                     TEMPLATE_VERSION,
	defaultRisk:                 'low',
	renderSpec,
	renderDeliverableStub:       () => renderDeliverableStub('Requirements Deliverable', REQUIREMENTS_REQUIRED_SECTIONS),
	requiredDeliverableSections: REQUIREMENTS_REQUIRED_SECTIONS,
	defaultAcceptance,
};
