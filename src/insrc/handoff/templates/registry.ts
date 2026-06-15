/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Template registry -- single point of truth for "which templates
 * exist in this build".
 *
 * Phase 7 fills out the remaining seven slots alongside the
 * Phase-2a DEBUG-SESSION wedge. Each is registered via its module
 * export below; the registry assertion enumerates the full set so
 * adding or removing one is a deliberate, reviewable edit.
 */

import type { TemplateId } from '../types.js';
import type { TemplateDefinition } from './types.js';
import { debugSessionTemplate } from './debug-session.js';
import { specTemplate }         from './spec.js';
import { designTemplate }       from './design.js';
import { requirementsTemplate } from './requirements.js';
import { testPlanTemplate }     from './test-plan.js';
import { reviewTemplate }       from './review.js';
import { migrationTemplate }    from './migration.js';
import { auditTemplate }        from './audit.js';

const REGISTERED: Partial<Record<TemplateId, TemplateDefinition>> = {
	'DEBUG-SESSION': debugSessionTemplate as TemplateDefinition,
	'SPEC':          specTemplate         as TemplateDefinition,
	'DESIGN':        designTemplate,
	'REQUIREMENTS':  requirementsTemplate,
	'TEST-PLAN':     testPlanTemplate,
	'REVIEW':        reviewTemplate,
	'MIGRATION':     migrationTemplate,
	'AUDIT':         auditTemplate,
};

/**
 * Look up a template by id. Returns `undefined` if not registered;
 * callers decide how to surface (CLI error, audit fall-through, etc.).
 */
export function findTemplate(id: TemplateId): TemplateDefinition | undefined {
	return REGISTERED[id];
}

/**
 * Get a template by id or throw. Use when the caller can't proceed
 * without one.
 */
export function getTemplate(id: TemplateId): TemplateDefinition {
	const t = findTemplate(id);
	if (t === undefined) {
		throw new Error(`Unknown handoff template id '${id}'. Registered: ${Object.keys(REGISTERED).join(', ')}.`);
	}
	return t;
}

/** Currently-registered template ids (deterministic order). */
export function registeredTemplates(): readonly TemplateId[] {
	return Object.keys(REGISTERED) as TemplateId[];
}

/**
 * Phase-7 invariants -- registry surface is now the full set:
 *
 *   DEBUG-SESSION  (Phase 2a wedge)
 *   SPEC           (Phase 7)
 *   DESIGN         (Phase 7)
 *   REQUIREMENTS   (Phase 7)
 *   TEST-PLAN      (Phase 7)
 *   REVIEW         (Phase 7)
 *   MIGRATION      (Phase 7, default risk=high)
 *   AUDIT          (Phase 7, default risk=medium)
 *
 * Adding or removing a template requires updating this set
 * deliberately -- the assertion catches accidental drift.
 */
export function assertTemplateInvariants(): void {
	const expected = new Set<TemplateId>([
		'DEBUG-SESSION',
		'SPEC',
		'DESIGN',
		'REQUIREMENTS',
		'TEST-PLAN',
		'REVIEW',
		'MIGRATION',
		'AUDIT',
	]);
	const actual = new Set(Object.keys(REGISTERED) as TemplateId[]);
	for (const id of actual) {
		if (!expected.has(id)) {
			throw new Error(`Template '${id}' is registered but not in the Phase-7 expected set. Update assertTemplateInvariants() if intentional.`);
		}
		const t = REGISTERED[id]!;
		if (t.id !== id) {
			throw new Error(`Template registered as '${id}' but its definition reports id='${t.id}'.`);
		}
	}
	for (const id of expected) {
		if (!actual.has(id)) {
			throw new Error(`Template '${id}' is in the Phase-7 expected set but missing from the registry.`);
		}
	}
}
