/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the scope-helpers module (Phase 1 of
 * plans/skill-closure-scoping.md).
 *
 * The helpers are pure functions over a tiny slice of SkillDeps
 * (`session.closureRepos`, `session.repoPath`), so the tests build a
 * minimal fake `SkillDeps` directly rather than going through
 * `runSkillIsolated`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	resolveSearchScope,
	isRepoInScope,
	DEFAULT_SEARCH_SCOPE,
	SCOPE_SCHEMA_FRAGMENT,
} from '../scope-helpers.js';
import type { SkillDeps } from '../types.js';

function makeDeps(opts: {
	closureRepos?: string[];
	repoPath?: string;
}): SkillDeps {
	const session = {
		repoPath:     opts.repoPath ?? '/repos/active',
		closureRepos: opts.closureRepos ?? [],
	};
	return { session } as unknown as SkillDeps;
}

// ---------------------------------------------------------------------------
// resolveSearchScope
// ---------------------------------------------------------------------------

test('resolveSearchScope: default scope returns the session closure', () => {
	const deps = makeDeps({
		closureRepos: ['/repos/active', '/repos/dep1', '/repos/dep2'],
	});
	const out = resolveSearchScope(deps);
	assert.deepEqual(out, ['/repos/active', '/repos/dep1', '/repos/dep2']);
});

test("resolveSearchScope: default scope is 'closure'", () => {
	assert.equal(DEFAULT_SEARCH_SCOPE, 'closure');
});

test("resolveSearchScope: 'closure' scope explicitly returns the closure", () => {
	const deps = makeDeps({
		closureRepos: ['/repos/a', '/repos/b'],
	});
	const out = resolveSearchScope(deps, 'closure');
	assert.deepEqual(out, ['/repos/a', '/repos/b']);
});

test("resolveSearchScope: 'global' scope returns null (no filter)", () => {
	const deps = makeDeps({
		closureRepos: ['/repos/active'],
	});
	const out = resolveSearchScope(deps, 'global');
	assert.equal(out, null);
});

test('resolveSearchScope: empty closure falls back to [repoPath] (defensive)', () => {
	const deps = makeDeps({
		closureRepos: [],
		repoPath:     '/repos/only-active',
	});
	const out = resolveSearchScope(deps);
	assert.deepEqual(out, ['/repos/only-active']);
});

test('resolveSearchScope: returns the readonly array reference (no copy)', () => {
	const closure = ['/repos/active', '/repos/dep1'];
	const deps = makeDeps({ closureRepos: closure });
	const out = resolveSearchScope(deps);
	// Helper should not deep-copy; callers can pass the result straight
	// through to storage without re-allocating.
	assert.equal(out, closure);
});

// ---------------------------------------------------------------------------
// isRepoInScope
// ---------------------------------------------------------------------------

test('isRepoInScope: active repo is in closure', () => {
	const deps = makeDeps({
		closureRepos: ['/repos/active', '/repos/dep1'],
	});
	assert.equal(isRepoInScope(deps, '/repos/active'), true);
});

test('isRepoInScope: dependent repo is in closure', () => {
	const deps = makeDeps({
		closureRepos: ['/repos/active', '/repos/dep1'],
	});
	assert.equal(isRepoInScope(deps, '/repos/dep1'), true);
});

test('isRepoInScope: unrelated repo is NOT in closure', () => {
	const deps = makeDeps({
		closureRepos: ['/repos/active', '/repos/dep1'],
	});
	assert.equal(isRepoInScope(deps, '/repos/unrelated'), false);
});

test("isRepoInScope: 'global' scope accepts every repo", () => {
	const deps = makeDeps({
		closureRepos: ['/repos/active'],
	});
	assert.equal(isRepoInScope(deps, '/repos/unrelated', 'global'), true);
});

test('isRepoInScope: empty closure -- defensive fallback accepts only repoPath', () => {
	const deps = makeDeps({
		closureRepos: [],
		repoPath:     '/repos/only-active',
	});
	assert.equal(isRepoInScope(deps, '/repos/only-active'),  true);
	assert.equal(isRepoInScope(deps, '/repos/anything-else'), false);
});

// ---------------------------------------------------------------------------
// Schema fragment shape
// ---------------------------------------------------------------------------

test('SCOPE_SCHEMA_FRAGMENT: shape suitable for JSON-Schema inputs.properties', () => {
	const frag = SCOPE_SCHEMA_FRAGMENT as unknown as Record<string, unknown>;
	assert.equal(frag['type'], 'string');
	assert.deepEqual(frag['enum'], ['closure', 'global']);
	assert.ok(typeof frag['description'] === 'string');
	assert.ok((frag['description'] as string).includes('closure'));
	assert.ok((frag['description'] as string).includes('global'));
});

test('SCOPE_SCHEMA_FRAGMENT: is frozen (callers cannot mutate the shared instance)', () => {
	assert.ok(Object.isFrozen(SCOPE_SCHEMA_FRAGMENT));
});
