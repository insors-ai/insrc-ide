/**
 * L2 skill registry -- P7.6.
 *
 * Separate registry from L1's (`daemon/skills/registry.ts`). Per the
 * P7 plan doc: a "unified registry with kind discriminator" was the
 * initial proposal, but the trade-off favours a separate registry
 * here because the registration validation (cycle detection,
 * cross-owner allow-listing, family taxonomy) is orthogonal to L2
 * concerns -- L2 skills don't have `toolDeps` enforcement, don't go
 * through `cross-owner` gates the same way, and have a different
 * `run` method signature. Two registries is less coupling than one
 * heterogeneous registry with `if (kind === 'l2') ...` branches.
 *
 * Cross-tier discovery (an L1 calling an L2 by id, or vice versa)
 * uses `getL2Skill` / `getL1Skill` explicitly. The unified-catalog
 * properties classify-question relies on (filter by owner + family)
 * are preserved by having both registries expose `listSkills()`-style
 * iterators.
 */

import { getLogger } from '../../../shared/logger.js';

import type { L2Skill } from './types.js';

const log = getLogger('l2:registry');

// ---------------------------------------------------------------------------

const byId = new Map<string, L2Skill>();

/**
 * Register an L2 skill. Re-registering the same id replaces the
 * prior entry (warned). Validation is minimal: id format + presence
 * of run + presence of defaultBudget. Heavier validation (schema
 * shape, cycle detection across the call graph) lands when needed.
 */
export function registerL2Skill(skill: L2Skill): void {
	if (!/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/.test(skill.id)) {
		throw new Error(`registerL2Skill: invalid id '${skill.id}' (must match dotted-lowercase grammar)`);
	}
	if (typeof skill.run !== 'function') {
		throw new Error(`registerL2Skill: ${skill.id} has no run() method`);
	}
	if (typeof skill.defaultBudget !== 'object' || skill.defaultBudget === null) {
		throw new Error(`registerL2Skill: ${skill.id} has no defaultBudget`);
	}
	if (byId.has(skill.id)) {
		log.warn({ id: skill.id }, 'overwriting L2 skill registration');
	}
	byId.set(skill.id, skill);
	log.info(
		{ id: skill.id, owner: skill.owner, family: skill.family },
		'l2 skill registered',
	);
}

export function getL2Skill(id: string): L2Skill | undefined {
	return byId.get(id);
}

export function listL2Skills(): readonly L2Skill[] {
	return Array.from(byId.values());
}

/** Test-only: clear the registry. */
export function _resetL2RegistryForTests(): void {
	byId.clear();
}
