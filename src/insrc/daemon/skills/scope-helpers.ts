/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Scope helpers for the entity-lookup skills -- Phase 1 of
 * plans/skill-closure-scoping.md.
 *
 * Skills that take a name or entityId arg (locate-by-name,
 * extract-fields, locate-references, entity.summary, entity.callers,
 * orm.resolve-model) need to scope their lookups to the active repo's
 * transitive DEPENDS_ON closure -- otherwise they leak matches from
 * unrelated workspace repos. See the live-run incident where an
 * `insors-extraction` analysis cited paths from `insors/hadoop`
 * because both happened to be indexed.
 *
 * The closure is already computed once at session init
 * (`session.closureRepos`). This module is the uniform read path so
 * (a) skill bodies stay terse and (b) tests can stub the resolution
 * with a known fixture closure.
 */

import type { SkillDeps } from './types.js';

/**
 * Discriminator for skill-side scope filtering. Callers pass this on
 * their input; skills resolve it to a concrete `string[]` of repo
 * paths via `resolveSearchScope()` below.
 *
 *   - `'closure'`: search the active session repo + every repo in its
 *     transitive DEPENDS_ON closure. The DEFAULT for every
 *     name/id-arg skill (per plans/skill-closure-scoping.md). Genuine
 *     sibling/dependent repos are kept in; unrelated indexed repos
 *     are filtered out.
 *   - `'global'`: no repo filter -- search every indexed repo. Opt-in
 *     only, for cases where the LLM explicitly wants cross-project
 *     name resolution.
 */
export type SearchScope = 'closure' | 'global';

/**
 * Default scope when the caller doesn't specify. Exported so test
 * fixtures can assert against the policy directly.
 */
export const DEFAULT_SEARCH_SCOPE: SearchScope = 'closure';

/**
 * Resolve a `SearchScope` against the active session's closure.
 *
 *   - `'closure'` -> `session.closureRepos`. If that's empty (defensive
 *     case the session loader shouldn't hit but might in tests / IPC
 *     failure paths), falls back to `[session.repoPath]` so the
 *     resolved scope is always non-empty.
 *   - `'global'` -> `null` (meaning "no repo filter"). Callers branch
 *     on `null` to skip the filter argument when calling the storage
 *     primitive.
 *
 * Returns `null` only for the explicit `'global'` opt-in. Every other
 * path returns a non-empty `string[]`.
 */
export function resolveSearchScope(
	deps: SkillDeps,
	scope: SearchScope = DEFAULT_SEARCH_SCOPE,
): readonly string[] | null {
	if (scope === 'global') {
		return null;
	}
	const session = deps.session;
	// `closureRepos` is declared on `Session` with a `[]` default so
	// production sessions always have it; the optional-chain is purely
	// defensive against synthetic test sessions that omit the field.
	const closure = session.closureRepos ?? [];
	if (closure.length > 0) {
		return closure;
	}
	// Defensive: session not initialised or closure resolution failed.
	// Fall back to the active repo only so the skill still works. When
	// `repoPath` is also empty (smoke-fixture default), returns `['']`
	// which the storage primitive treats as an unknown repo -> no
	// matches. Same semantic as the pre-Plan-SCS behaviour when the
	// session repoPath wasn't registered.
	return [session.repoPath ?? ''];
}

/**
 * Check whether a repo path is in scope for the current session.
 * Used by entityId-based skills (entity.summary, entity.callers) to
 * reject cross-closure entityIds with a typed refusal rather than
 * silently resolving cross-repo entities.
 *
 * `'global'` scope always returns true (no filtering).
 */
export function isRepoInScope(
	deps: SkillDeps,
	repoPath: string,
	scope: SearchScope = DEFAULT_SEARCH_SCOPE,
): boolean {
	if (scope === 'global') {
		return true;
	}
	const resolved = resolveSearchScope(deps, scope);
	if (resolved === null) {
		return true;
	}
	return resolved.includes(repoPath);
}

/**
 * JSON Schema fragment for the `scope?` arg, suitable to spread into
 * a skill's `inputs.properties`. Keeps the description text uniform
 * across skills so the LLM sees the same explanation everywhere.
 */
export const SCOPE_SCHEMA_FRAGMENT = Object.freeze({
	type: 'string',
	enum: ['closure', 'global'],
	description:
		"Search scope. 'closure' (DEFAULT) limits matches to the active repo plus its " +
		"transitive DEPENDS_ON closure -- so genuine sibling/dependent repos stay in but " +
		"unrelated indexed repos are filtered out. 'global' searches every indexed repo " +
		"(rare; opt-in only when you need cross-project name resolution).",
});
