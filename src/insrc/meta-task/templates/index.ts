/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Meta-task template registry.
 *
 * A template is a recipe: name, worktree mode, plan-builder, optional synthesis step.
 * The orchestrator looks up a template by id, calls its `plan()` to get the step list,
 * then runs each step through the two-phase loop.
 *
 * Templates are static / declarative -- they don't carry runtime state. Step
 * acceptance criteria + intent strings are baked in; plan() can vary only on the
 * scope manifest the orchestrator hands it.
 *
 * Per-template design docs live at `design/meta-task-<id>.html` (M6.0 prerequisite).
 *
 * Plan ref: [`plans/meta-tasks.md`](../../../../plans/meta-tasks.md) M2.6.
 */

import type { Plan, ScopeManifest, WorktreeMode } from '../types.js';

export interface MetaTaskTemplate {
	readonly id: string;
	/** Human-readable name shown in the chat card + dashboard header. */
	readonly displayName: string;
	readonly worktreeMode: WorktreeMode;
	/** Build a plan from a scope manifest. Pure function; deterministic for a
	 *  given scope. */
	readonly plan: (scope: ScopeManifest) => Plan;
	/** Optional: phase-2 system prompt prelude, applied to every step's phase-2 call.
	 *  Templates that need different prompts per step bake that into the step
	 *  descriptors instead. */
	readonly phase2SystemPrelude?: string | undefined;
	/** Optional synthesis step intent. When set, the orchestrator runs one
	 *  extra phase-2 call after the last step to compose the final artifact. */
	readonly synthesizeIntent?: string | undefined;
}

const REGISTRY = new Map<string, MetaTaskTemplate>();
let bootstrapped = false;

export function registerTemplate(template: MetaTaskTemplate): void {
	if (REGISTRY.has(template.id)) {
		throw new Error(`meta-task template '${template.id}' already registered`);
	}
	REGISTRY.set(template.id, template);
}

export function getTemplate(id: string): MetaTaskTemplate | undefined {
	ensureBootstrapped();
	return REGISTRY.get(id);
}

export function listTemplates(): readonly MetaTaskTemplate[] {
	ensureBootstrapped();
	return [...REGISTRY.values()];
}

/** Reset between tests. */
export function _clearRegistryForTests(): void {
	REGISTRY.clear();
	bootstrapped = false;
}

/**
 * Lazy bootstrap: registers every built-in template on first registry lookup.
 * Lazy (rather than top-of-module side-effect) so circular ESM hoisting doesn't
 * race the `const REGISTRY = new Map()` initializer.
 */
async function ensureBootstrappedAsync(): Promise<void> {
	if (bootstrapped) { return; }
	bootstrapped = true;
	const { reviewTemplate } = await import('./review.js');
	if (!REGISTRY.has(reviewTemplate.id)) {
		REGISTRY.set(reviewTemplate.id, reviewTemplate);
	}
}

// Synchronous wrapper: ESM dynamic imports are async, but the orchestrator
// calls getTemplate synchronously. We pre-register the built-ins through a
// statically-imported manifest -- avoids the async hop without re-introducing
// the circular static-import problem.
function ensureBootstrapped(): void {
	if (bootstrapped) { return; }
	bootstrapped = true;
	for (const t of BUILTIN_TEMPLATES) {
		if (!REGISTRY.has(t.id)) { REGISTRY.set(t.id, t); }
	}
}

// Static manifest. New templates land here on registration.
// The bottom-of-file import is safe because by the time it evaluates, the
// `const REGISTRY = new Map()` line has already run -- but the imported
// `reviewTemplate` is a pure value (not a self-registration side effect),
// so the previous "Cannot access REGISTRY before initialization" race is gone.
import { reviewTemplate } from './review.js';
const BUILTIN_TEMPLATES: readonly MetaTaskTemplate[] = [reviewTemplate];

void ensureBootstrappedAsync;   // silence unused-export warning
