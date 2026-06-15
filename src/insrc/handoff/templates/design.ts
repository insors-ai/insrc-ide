/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * DESIGN template -- architecture decision record.
 *
 * Used when the user wants the external agent to research + write
 * a design / ADR rather than implement code. The deliverable is
 * markdown; no code changes are expected (the audit pipeline
 * still works because the diff is empty, which is fine for this
 * template's verdict floor).
 *
 * Default risk: `low`. The agent reads source + memory; the
 * ratchet doesn't trigger on read-only operations.
 *
 * Deliverable shape (ADR-style, audit matches `^## <Name>` level 2):
 *   - Context       -- the problem we're deciding about
 *   - Decision      -- what we're deciding + the chosen approach
 *   - Alternatives  -- options considered + why we passed
 *   - Consequences  -- tradeoffs, follow-ups, things this enables / blocks
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
	{ name: 'Context',       oneLine: 'the problem we are deciding about; what forces / constraints apply.' },
	{ name: 'Decision',      oneLine: 'the chosen approach, stated as a directive ("we will ...").' },
	{ name: 'Alternatives',  oneLine: 'other options considered; one paragraph each with reason rejected.' },
	{ name: 'Consequences',  oneLine: 'tradeoffs, follow-ups, things this enables / blocks downstream.' },
] as const;

export const DESIGN_REQUIRED_SECTIONS = SECTIONS.map(s => s.name);

function renderSpec(input: RenderSpecInput): string {
	const sections: string[] = [];
	sections.push(`# Design: ${input.intent}`);
	sections.push('');
	sections.push(renderObjective(input));
	sections.push(renderScope(input));
	sections.push(renderMemoryExcerpts(input));
	sections.push(renderAcceptanceCriteria(input));
	sections.push(renderConstraints(input));
	sections.push(renderDiscoveryGuidance({
		extraBullets: [
			'Treat existing implementations as evidence, not authority -- cite + critique rather than parrot.',
			'Use `insrc_entity_search` to enumerate the actually-affected surface before forming Alternatives.',
		],
	}));
	sections.push(renderDeliverableStructureReference({
		sections: SECTIONS,
		leadIn:   "Write the ADR into `spec-deliverable.md` using EXACTLY",
	}));
	return sections.join('\n');
}

function defaultAcceptance(_input: RenderSpecInput): readonly AcceptanceCriterion[] {
	return [
		{ id: 'soft.cites-evidence',  description: 'Context cites at least one concrete file / entity from the repo.', kind: 'soft' },
		{ id: 'soft.alternatives',    description: 'Alternatives section lists at least one option distinct from the Decision.', kind: 'soft' },
		{ id: 'soft.tradeoffs-named', description: 'Consequences names at least one tradeoff or follow-up.', kind: 'soft' },
	];
}

export const designTemplate: TemplateDefinition = {
	id:                          'DESIGN',
	version:                     TEMPLATE_VERSION,
	defaultRisk:                 'low',
	renderSpec,
	renderDeliverableStub:       () => renderDeliverableStub('Design Deliverable', DESIGN_REQUIRED_SECTIONS),
	requiredDeliverableSections: DESIGN_REQUIRED_SECTIONS,
	defaultAcceptance,
};
