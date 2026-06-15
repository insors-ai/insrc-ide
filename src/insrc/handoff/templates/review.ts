/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * REVIEW template -- code / artifact review checklist.
 *
 * Used to get the external agent to review an existing artifact
 * (a PR, a branch, a design doc, a config) and produce a
 * structured set of findings ranked by severity. No code changes
 * are expected; this is a read-only critique.
 *
 * Default risk: `low` (read-only).
 *
 * Deliverable shape:
 *   - Summary           -- what's being reviewed; one paragraph
 *   - Findings          -- numbered F-1, F-2, ... each with severity
 *   - Recommendations   -- proposed actions per finding
 *   - Verdict           -- accept / accept-with-changes / reject
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
	{ name: 'Summary',         oneLine: 'one paragraph: what was reviewed + the headline verdict.' },
	{ name: 'Findings',        oneLine: 'numbered F-1, F-2, ... each tagged [blocker|major|minor|nit].' },
	{ name: 'Recommendations', oneLine: 'one action per finding; the verb that closes the gap.' },
	{ name: 'Verdict',         oneLine: 'one of: accept | accept-with-changes | reject (+ one-line reason).' },
] as const;

export const REVIEW_REQUIRED_SECTIONS = SECTIONS.map(s => s.name);

function renderSpec(input: RenderSpecInput): string {
	const sections: string[] = [];
	sections.push(`# Review: ${input.intent}`);
	sections.push('');
	sections.push(renderObjective(input));
	sections.push(renderScope(input));
	sections.push(renderMemoryExcerpts(input));
	sections.push(renderAcceptanceCriteria(input));
	sections.push(renderConstraints(input));
	sections.push(renderDiscoveryGuidance({
		extraBullets: [
			'This is a read-only critique. DO NOT modify the reviewed artifact.',
			'Findings MUST cite file:line or entity id; opinion without evidence is not a finding.',
			'Each finding MUST be tagged with one of [blocker | major | minor | nit].',
		],
	}));
	sections.push(renderDeliverableStructureReference({
		sections: SECTIONS,
		leadIn:   "Write the review into `spec-deliverable.md` using EXACTLY",
	}));
	return sections.join('\n');
}

function defaultAcceptance(_input: RenderSpecInput): readonly AcceptanceCriterion[] {
	return [
		{ id: 'soft.findings-cited',  description: 'Every finding cites a file:line or entity id.',                   kind: 'soft' },
		{ id: 'soft.findings-tagged', description: 'Every finding carries a severity tag.',                            kind: 'soft' },
		{ id: 'soft.verdict-set',     description: 'Verdict is exactly one of accept / accept-with-changes / reject.', kind: 'soft' },
	];
}

export const reviewTemplate: TemplateDefinition = {
	id:                          'REVIEW',
	version:                     TEMPLATE_VERSION,
	defaultRisk:                 'low',
	renderSpec,
	renderDeliverableStub:       () => renderDeliverableStub('Review Deliverable', REVIEW_REQUIRED_SECTIONS),
	requiredDeliverableSections: REVIEW_REQUIRED_SECTIONS,
	defaultAcceptance,
};
