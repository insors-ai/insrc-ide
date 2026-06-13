/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Template registry -- single point of truth for "which templates
 * exist in this build".
 *
 * Phase 2a ships ONE template (DEBUG-SESSION). The other seven slots
 * (SPEC, DESIGN, REQUIREMENTS, TEST-PLAN, REVIEW, MIGRATION, AUDIT)
 * are declared in TemplateId but not yet registered; Phase 7 fills
 * those in. The registry's invariant assertion enumerates ONLY what's
 * shipped so adding a new template is a deliberate registry edit.
 */

import type { TemplateId } from '../types.js';
import type { TemplateDefinition } from './types.js';
import { debugSessionTemplate } from './debug-session.js';

const REGISTERED: Partial<Record<TemplateId, TemplateDefinition>> = {
	'DEBUG-SESSION': debugSessionTemplate as TemplateDefinition,
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
 * Phase-2a invariants -- the registry surface is pinned at:
 *   DEBUG-SESSION (Phase 2a wedge)
 *
 * Phase 7's rollout (SPEC, DESIGN, REQUIREMENTS, TEST-PLAN, REVIEW,
 * MIGRATION, AUDIT) updates this assertion alongside each addition.
 */
export function assertTemplateInvariants(): void {
	const expected = new Set<TemplateId>(['DEBUG-SESSION']);
	const actual   = new Set(Object.keys(REGISTERED) as TemplateId[]);
	for (const id of actual) {
		if (!expected.has(id)) {
			throw new Error(`Template '${id}' is registered but not in the Phase-2a expected set. Update assertTemplateInvariants() if intentional.`);
		}
		const t = REGISTERED[id]!;
		if (t.id !== id) {
			throw new Error(`Template registered as '${id}' but its definition reports id='${t.id}'.`);
		}
	}
	for (const id of expected) {
		if (!actual.has(id)) {
			throw new Error(`Template '${id}' is in the Phase-2a expected set but missing from the registry.`);
		}
	}
}
