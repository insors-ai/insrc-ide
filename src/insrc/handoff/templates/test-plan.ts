/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * TEST-PLAN template -- test strategy for a feature / system.
 *
 * Used when the user wants the external agent to enumerate what
 * tests SHOULD exist, not write them. The deliverable is a
 * markdown plan the team (or a follow-up SPEC handoff) executes.
 *
 * Default risk: `low` (read-only).
 *
 * Deliverable shape:
 *   - Scope        -- what's in / out of scope for testing
 *   - Approach     -- unit / integration / e2e split + tooling
 *   - Scenarios    -- numbered TS-1, TS-2, ... each one a concrete test case
 *   - Risks        -- gaps + mitigations the test plan can't fully address
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
	{ name: 'Scope',     oneLine: 'what is in and out of scope for this test plan.' },
	{ name: 'Approach',  oneLine: 'unit / integration / e2e split + the test runner(s) used.' },
	{ name: 'Scenarios', oneLine: 'numbered TS-1, TS-2, ... each one a concrete pass / fail case.' },
	{ name: 'Risks',     oneLine: 'gaps this plan does NOT cover + proposed mitigation per gap.' },
] as const;

export const TEST_PLAN_REQUIRED_SECTIONS = SECTIONS.map(s => s.name);

function renderSpec(input: RenderSpecInput): string {
	const sections: string[] = [];
	sections.push(`# Test Plan: ${input.intent}`);
	sections.push('');
	sections.push(renderObjective(input));
	sections.push(renderScope(input));
	sections.push(renderMemoryExcerpts(input));
	sections.push(renderAcceptanceCriteria(input));
	sections.push(renderConstraints(input));
	sections.push(renderDiscoveryGuidance({
		extraBullets: [
			'Use `insrc_entity_search` to enumerate the surface under test (callers, callees, public API).',
			'Scenarios MUST be numbered (TS-N) so a follow-up SPEC can reference them.',
			'Risks MUST name at least one gap; "no gaps" is almost always wrong.',
		],
	}));
	sections.push(renderDeliverableStructureReference({
		sections: SECTIONS,
		leadIn:   "Write the test plan into `spec-deliverable.md` using EXACTLY",
	}));
	return sections.join('\n');
}

function defaultAcceptance(_input: RenderSpecInput): readonly AcceptanceCriterion[] {
	return [
		{ id: 'soft.scenarios-numbered', description: 'Scenarios section uses TS-N numbering.',            kind: 'soft' },
		{ id: 'soft.approach-concrete',  description: 'Approach names a concrete test runner + tier mix.', kind: 'soft' },
		{ id: 'soft.risks-named',        description: 'Risks names at least one explicit gap.',            kind: 'soft' },
	];
}

export const testPlanTemplate: TemplateDefinition = {
	id:                          'TEST-PLAN',
	version:                     TEMPLATE_VERSION,
	defaultRisk:                 'low',
	renderSpec,
	renderDeliverableStub:       () => renderDeliverableStub('Test Plan Deliverable', TEST_PLAN_REQUIRED_SECTIONS),
	requiredDeliverableSections: TEST_PLAN_REQUIRED_SECTIONS,
	defaultAcceptance,
};
