/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MIGRATION template -- staged migration plan.
 *
 * Used when the user wants the external agent to PLAN (not
 * execute) a multi-stage migration: schema changes, library
 * swaps, version bumps, etc. Each phase must declare its own
 * rollback so partial failures can be unwound.
 *
 * Default risk: **`high`** (per plans/external-agent-integration.md
 * §7). Migration paths frequently touch infra / migrations
 * directories the Phase-3 risk ratchet flags anyway; we set the
 * floor at `high` so even read-only migration *plans* require
 * explicit Mode A approval before the spawn lands.
 *
 * Deliverable shape:
 *   - CurrentState     -- where we are today: counts, versions, dependencies
 *   - TargetState      -- where we're going + acceptance signal per phase
 *   - Phases           -- ordered list, one ## sub-section per phase
 *   - Rollback         -- mirror of Phases: how to undo each one
 *   - Verification     -- gates between phases (check N before phase N+1)
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
	{ name: 'CurrentState',  oneLine: 'where we are today: counts, versions, dependencies, traffic.' },
	{ name: 'TargetState',   oneLine: 'where we are going + the per-phase acceptance signal.' },
	{ name: 'Phases',        oneLine: 'ordered phases; each one independently shippable + reversible.' },
	{ name: 'Rollback',      oneLine: 'mirror of Phases: how to undo each phase, in reverse order.' },
	{ name: 'Verification',  oneLine: 'gates between phases (what to check before advancing).' },
] as const;

export const MIGRATION_REQUIRED_SECTIONS = SECTIONS.map(s => s.name);

function renderSpec(input: RenderSpecInput): string {
	const sections: string[] = [];
	sections.push(`# Migration: ${input.intent}`);
	sections.push('');
	sections.push(renderObjective(input));
	sections.push(renderScope(input));
	sections.push(renderMemoryExcerpts(input));
	sections.push(renderAcceptanceCriteria(input));
	sections.push(renderConstraints(input));
	sections.push(renderDiscoveryGuidance({
		extraBullets: [
			'Migrations are risk:high by default. Use `insrc_repo_dependency_closure` to enumerate every consumer before proposing phases.',
			'Every phase MUST have a paired Rollback entry that explicitly says how to undo it.',
			'Verification entries MUST be runnable -- a query, a metric, a shell command -- not just prose.',
			'When in doubt, prefer MORE phases. Shrink each phase until it can be reverted in under 5 minutes.',
		],
	}));
	sections.push(renderDeliverableStructureReference({
		sections: SECTIONS,
		leadIn:   "Write the migration plan into `spec-deliverable.md` using EXACTLY",
	}));
	return sections.join('\n');
}

function defaultAcceptance(_input: RenderSpecInput): readonly AcceptanceCriterion[] {
	return [
		{ id: 'soft.phases-ordered',   description: 'Phases section is an ordered list (1, 2, ...) with at least 2 phases.',     kind: 'soft' },
		{ id: 'soft.rollback-mirrors', description: 'Rollback has one entry per Phases entry, in matching order.',                kind: 'soft' },
		{ id: 'soft.verification-cmds', description: 'Verification entries are runnable (query / metric / shell), not just prose.', kind: 'soft' },
		{ id: 'soft.consumers-named',  description: 'CurrentState names at least one downstream consumer the migration affects.', kind: 'soft' },
	];
}

export const migrationTemplate: TemplateDefinition = {
	id:                          'MIGRATION',
	version:                     TEMPLATE_VERSION,
	defaultRisk:                 'high',
	renderSpec,
	renderDeliverableStub:       () => renderDeliverableStub('Migration Deliverable', MIGRATION_REQUIRED_SECTIONS),
	requiredDeliverableSections: MIGRATION_REQUIRED_SECTIONS,
	defaultAcceptance,
};
