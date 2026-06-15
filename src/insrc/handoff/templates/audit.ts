/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * AUDIT template -- audit an existing artifact against ground truth.
 *
 * Pattern lifted from the manual audit work captured in the
 * design notes (cross-reference an existing doc / config / claim
 * against the actual code + data). The agent verifies each claim
 * one by one and reports findings with verdicts.
 *
 * Default risk: `medium`. Audits read sensitive sources (configs,
 * historical data, secrets references) and may surface findings
 * the team prefers not to publish; the ratchet may raise this
 * further based on the in-scope paths.
 *
 * Deliverable shape:
 *   - Subject        -- what is being audited; file paths, claims, versions
 *   - Method         -- how the audit was conducted; what was checked
 *   - Findings       -- numbered A-1, A-2, ... each [pass|note|fail] with evidence
 *   - Verdict        -- overall: pass | pass-with-notes | fail (+ one-line reason)
 *   - Remediation    -- recommended fixes per failed finding
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
	{ name: 'Subject',     oneLine: 'what is being audited: file paths, claims, versions, time window.' },
	{ name: 'Method',      oneLine: 'how the audit was conducted; what was checked and how.' },
	{ name: 'Findings',    oneLine: 'numbered A-1, A-2, ... each [pass|note|fail] with cited evidence.' },
	{ name: 'Verdict',     oneLine: 'overall: pass | pass-with-notes | fail (+ one-line reason).' },
	{ name: 'Remediation', oneLine: 'recommended fix per failed finding; references A-N from Findings.' },
] as const;

export const AUDIT_REQUIRED_SECTIONS = SECTIONS.map(s => s.name);

function renderSpec(input: RenderSpecInput): string {
	const sections: string[] = [];
	sections.push(`# Audit: ${input.intent}`);
	sections.push('');
	sections.push(renderObjective(input));
	sections.push(renderScope(input));
	sections.push(renderMemoryExcerpts(input));
	sections.push(renderAcceptanceCriteria(input));
	sections.push(renderConstraints(input));
	sections.push(renderDiscoveryGuidance({
		extraBullets: [
			'This is an audit. Treat the subject as a SUSPECT, not a source of truth.',
			'Every finding MUST cite the evidence you used to reach the verdict (file:line, query output, metric).',
			"Don't report 'looks fine' without showing how you checked.",
			'Findings MUST be numbered (A-N) and tagged [pass|note|fail].',
		],
	}));
	sections.push(renderDeliverableStructureReference({
		sections: SECTIONS,
		leadIn:   "Write the audit into `spec-deliverable.md` using EXACTLY",
	}));
	return sections.join('\n');
}

function defaultAcceptance(_input: RenderSpecInput): readonly AcceptanceCriterion[] {
	return [
		{ id: 'soft.findings-numbered',  description: 'Findings section uses A-N numbering.',                            kind: 'soft' },
		{ id: 'soft.findings-cited',     description: 'Every finding cites concrete evidence (file:line, query, etc).',  kind: 'soft' },
		{ id: 'soft.verdict-clear',      description: 'Verdict is exactly one of pass / pass-with-notes / fail.',         kind: 'soft' },
		{ id: 'soft.remediation-tied',   description: 'Every Remediation entry references a Findings entry by A-N id.',   kind: 'soft' },
	];
}

export const auditTemplate: TemplateDefinition = {
	id:                          'AUDIT',
	version:                     TEMPLATE_VERSION,
	defaultRisk:                 'medium',
	renderSpec,
	renderDeliverableStub:       () => renderDeliverableStub('Audit Deliverable', AUDIT_REQUIRED_SECTIONS),
	requiredDeliverableSections: AUDIT_REQUIRED_SECTIONS,
	defaultAcceptance,
};
