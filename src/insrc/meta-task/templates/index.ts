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

import type { AssertionInterest, OwnerId } from '../../daemon/substrate/types.js';
import { getSubstrateRuntime, hasSubstrateRuntime } from '../../daemon/substrate/singleton.js';
import type { Plan, ScopeManifest, WorktreeMode } from '../types.js';

export interface TemplateMemoryNamespace {
	readonly namespace: string;
	readonly kind:      'fact' | 'hint' | 'constraint';
}

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

	// ------------------------------------------------------------------
	// memory-context M3: substrate owner declaration. Optional -- templates
	// that opt in get assertion routing for their declared interests; chat-
	// side preference capture fans out to this template's owner namespace
	// automatically when the user's preference subject matches an interest.
	// ------------------------------------------------------------------

	/** Substrate owner id for this template. Convention: `agent:meta-task:<id>`. */
	readonly ownerId?: OwnerId | undefined;
	/** Memory namespace schema version. Bumped on backward-incompatible
	 *  changes to the owner's stored payloads. Default 1. */
	readonly schemaVersion?: number | undefined;
	/** Subjects this template wants preferences routed to. Closed-enum
	 *  per `taxonomy/preference-subjects.ts`; substrate's AssertionIndex
	 *  exact-matches on subjectPattern. */
	readonly assertionInterests?: readonly AssertionInterest[] | undefined;
	/** Namespaces this template uses. Currently advisory -- the substrate
	 *  creates namespaces on-demand. Surfacing here lets future indexer /
	 *  Lance integration discover the schema without runtime probes. */
	readonly memorySchema?: readonly TemplateMemoryNamespace[] | undefined;
}

const REGISTRY = new Map<string, MetaTaskTemplate>();
let bootstrapped = false;
const SUBSTRATE_REGISTERED = new Set<string>();

export function registerTemplate(template: MetaTaskTemplate): void {
	if (REGISTRY.has(template.id)) {
		throw new Error(`meta-task template '${template.id}' already registered`);
	}
	REGISTRY.set(template.id, template);
	registerTemplateSubstrate(template);
}

/**
 * memory-context M3.3. When the substrate runtime is initialised, register
 * the template's `ownerId` + `assertionInterests` so chat-captured preferences
 * with matching subjects fan out to this owner's `user-assertions` namespace.
 * Silently no-ops when the substrate isn't initialised (test paths that
 * bootstrap templates without a daemon) -- substrate boot picks up any
 * deferred registrations via `registerKnownTemplatesWithSubstrate()`.
 *
 * Idempotent on the (template.id) axis: re-registering an already-registered
 * template is a no-op, so the daemon boot path's catch-up call is safe.
 */
function registerTemplateSubstrate(template: MetaTaskTemplate): void {
	if (template.ownerId === undefined) { return; }
	if (template.assertionInterests === undefined || template.assertionInterests.length === 0) { return; }
	if (SUBSTRATE_REGISTERED.has(template.id)) { return; }
	try {
		if (!hasSubstrateRuntime()) { return; }
		const runtime = getSubstrateRuntime();
		runtime.assertionIndex.register(template.ownerId, template.assertionInterests);
		SUBSTRATE_REGISTERED.add(template.id);
	} catch {
		// Substrate not wired (e.g. test environments that bootstrap templates
		// without a daemon). Defer until the daemon boot path catches up.
	}
}

/**
 * memory-context M3.3 (daemon boot). After `initSubstrateRuntime()` runs,
 * the daemon calls this to register any template owners that were declared
 * before the substrate was ready. Called from `daemon/index.ts` right after
 * `registerAgentChatOwner()`. Idempotent.
 */
export function registerKnownTemplatesWithSubstrate(): void {
	ensureBootstrapped();
	for (const template of REGISTRY.values()) {
		registerTemplateSubstrate(template);
	}
}

/** Reset for tests. Drops the substrate-registered set too. */
export function _clearSubstrateRegistrationsForTests(): void {
	SUBSTRATE_REGISTERED.clear();
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
	SUBSTRATE_REGISTERED.clear();
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
		if (!REGISTRY.has(t.id)) {
			REGISTRY.set(t.id, t);
			registerTemplateSubstrate(t);
		}
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
