/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * DEBUG-SESSION template tests -- pin both shapes (spec + deliverable
 * stub) per design §5.2's "two-shape" carve-out. Future edits that
 * accidentally drop a required section, leak pre-fetched content into
 * the spec, or drift the deliverable structure fail here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	debugSessionTemplate,
	_renderObjectiveForTest,
	_renderScopeForTest,
	_renderMemoryExcerptsForTest,
	_renderAcceptanceCriteriaForTest,
	_renderConstraintsForTest,
	_renderDiscoveryGuidanceForTest,
	_renderDeliverableStubForTest,
	_defaultAcceptanceForTest,
	type DebugSessionInput,
} from '../templates/debug-session.js';
import {
	findTemplate,
	getTemplate,
	registeredTemplates,
	assertTemplateInvariants,
} from '../templates/registry.js';
import type { ScopePayload, MemoryRef, AcceptanceCriterion, PermissionsBlock } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCOPE: ScopePayload = {
	repoId:               '/Users/me/work/foo',
	repoPath:             '/Users/me/work/foo',
	inScopeGlobs:         ['src/**/*.ts', 'test/**/*.test.ts'],
	outOfScopePaths:      ['migrations/', 'infra/'],
	entryPointHints:      [{ entityId: 'abcdef0123', note: 'foo.test.ts beforeEach' }],
	dependencyClosureRepos: ['/Users/me/work/lib-bar'],
	riskHints:            'low',
};

const MEM_REFS: MemoryRef[] = [
	{ kind: 'turn',     id: 'turn-42',  oneLineSummary: 'Earlier fix attempt: rewrote setUp mock; reverted.' },
	{ kind: 'artifact', id: 'art-7',    oneLineSummary: 'CI log span showing the flaky test name.' },
];

const ACCEPTANCE: AcceptanceCriterion[] = [
	{ id: 'machine.test-passes', description: 'foo.test.ts passes 50/50 runs', kind: 'machine',
		verifier: { type: 'shell-exit', command: 'npm test -- --grep foo' } },
	{ id: 'soft.root-cause', description: 'Fix targets the root cause identified in Conclude.', kind: 'soft' },
];

const PERMS: PermissionsBlock = {
	allow:  [{ tool: 'Edit', paths: ['src/**'] }],
	prompt: [{ tool: 'Bash', commands: ['git push', 'npm publish'] }],
	deny:   [{ tool: 'WebFetch' }],
};

function input(over: Partial<DebugSessionInput> = {}): DebugSessionInput {
	return {
		intent:        'Fix the flaky test in foo.test.ts',
		scope:         SCOPE,
		memoryRefs:    MEM_REFS,
		acceptance:    ACCEPTANCE,
		permissions:   PERMS,
		riskTag:       'low',
		worktreePath:  '/tmp/insrc/handoffs/sess-1/worktree',
		timeBudgetSec: 600,
		failingTest:   'foo.test.ts',
		...over,
	};
}

// ---------------------------------------------------------------------------
// renderObjective
// ---------------------------------------------------------------------------

test('renderObjective: surfaces intent + failing test', () => {
	const md = _renderObjectiveForTest(input());
	assert.match(md, /## Objective/);
	assert.match(md, /Fix the flaky test in foo\.test\.ts/);
	assert.match(md, /Failing test \(hint\): `foo\.test\.ts`/);
});

test('renderObjective: omits failing-test line when unset', () => {
	const md = _renderObjectiveForTest(input({ failingTest: undefined }));
	assert.doesNotMatch(md, /Failing test \(hint\)/);
});

// ---------------------------------------------------------------------------
// renderScope
// ---------------------------------------------------------------------------

test('renderScope: includes repo + globs + out-of-scope + entry-point + dependency closure', () => {
	const md = _renderScopeForTest(input());
	assert.match(md, /## Scope/);
	assert.match(md, /Repo: `\/Users\/me\/work\/foo`/);
	assert.match(md, /In-scope paths: `src\/\*\*\/\*\.ts`, `test\/\*\*\/\*\.test\.ts`/);
	assert.match(md, /Out-of-scope.*`migrations\/`, `infra\/`/);
	assert.match(md, /Entry point hints/);
	assert.match(md, /`abcdef0123` -- foo\.test\.ts beforeEach/);
	assert.match(md, /Dependency closure.*`\/Users\/me\/work\/lib-bar`/);
});

test('renderScope: omits entry-point + dep-closure sections when absent', () => {
	const minimal: ScopePayload = {
		repoId: '/r', repoPath: '/r', inScopeGlobs: ['**'], outOfScopePaths: [], riskHints: 'low',
	};
	const md = _renderScopeForTest(input({ scope: minimal }));
	assert.doesNotMatch(md, /Entry point hints/);
	assert.doesNotMatch(md, /Dependency closure/);
});

// ---------------------------------------------------------------------------
// renderMemoryExcerpts (critical: no pre-fetched content leaks)
// ---------------------------------------------------------------------------

test('renderMemoryExcerpts: surfaces refs as POINTERS with the explicit no-prefetch caveat', () => {
	const md = _renderMemoryExcerptsForTest(input());
	assert.match(md, /Memory excerpts/);
	assert.match(md, /\[turn:turn-42\]/);
	assert.match(md, /\[artifact:art-7\]/);
	// The "discovery is the agent's job" rule (design §4.0) -- pin its
	// presence in every spec so it can't silently drift out.
	assert.match(md, /POINTERS, not content/i);
	assert.match(md, /insrc_memory_recall|insrc_artifact_get/);
	assert.match(md, /didn't pre-fetch/);
});

test('renderMemoryExcerpts: empty when no refs (no "memory excerpts" section at all)', () => {
	const md = _renderMemoryExcerptsForTest(input({ memoryRefs: [] }));
	assert.equal(md, '');
});

// ---------------------------------------------------------------------------
// renderAcceptanceCriteria
// ---------------------------------------------------------------------------

test('renderAcceptanceCriteria: machine criteria carry their verifier inline', () => {
	const md = _renderAcceptanceCriteriaForTest(input());
	assert.match(md, /machine.*passes 50\/50/);
	assert.match(md, /verifier: `npm test -- --grep foo` exits 0/);
	assert.match(md, /soft.*root cause/);
});

test('renderAcceptanceCriteria: file-exists and regex-match verifiers each render their specifics', () => {
	const acc: AcceptanceCriterion[] = [
		{ id: 'a', description: 'output exists', kind: 'machine',
			verifier: { type: 'file-exists', path: 'dist/x.js' } },
		{ id: 'b', description: 'banner present', kind: 'machine',
			verifier: { type: 'regex-match', path: 'README.md', pattern: '^# insrc' } },
	];
	const md = _renderAcceptanceCriteriaForTest(input({ acceptance: acc }));
	assert.match(md, /verifier: file `dist\/x\.js` exists/);
	assert.match(md, /verifier: `\^# insrc` matches in `README.md`/);
});

// ---------------------------------------------------------------------------
// renderConstraints
// ---------------------------------------------------------------------------

test('renderConstraints: surfaces worktree, risk, budget, and the out-of-scope deny list', () => {
	const md = _renderConstraintsForTest(input());
	assert.match(md, /Sandbox: `\/tmp\/insrc\/handoffs\/sess-1\/worktree`/);
	assert.match(md, /Risk: low/);
	assert.match(md, /Time budget: 600s/);
	assert.match(md, /May NOT modify: `migrations\/`, `infra\/`/);
});

// ---------------------------------------------------------------------------
// renderDiscoveryGuidance (critical: forces the use of MCP, not pre-fetch)
// ---------------------------------------------------------------------------

test('renderDiscoveryGuidance: points the agent at insrc_entity_search with the failing test name', () => {
	const md = _renderDiscoveryGuidanceForTest(input());
	assert.match(md, /insrc_entity_search\("foo\.test\.ts", repo="\/Users\/me\/work\/foo"\)/);
	assert.match(md, /insrc_entity_callers/);
	assert.match(md, /insrc_memory_recall/);
	// Design §5.2 rationale -- pin it in the spec so the agent reads it.
	assert.match(md, /scope is deliberately light/);
});

test('renderDiscoveryGuidance: falls back to <failing test name> placeholder when unknown', () => {
	const md = _renderDiscoveryGuidanceForTest(input({ failingTest: undefined }));
	assert.match(md, /insrc_entity_search\("<failing test name>"/);
});

// ---------------------------------------------------------------------------
// Deliverable stub
// ---------------------------------------------------------------------------

test('renderDeliverableStub: five required sections in order', () => {
	const md = _renderDeliverableStubForTest();
	const required = ['Reproduce', 'Localize', 'Hypothesize', 'Test', 'Conclude'];
	let lastIdx = -1;
	for (const sec of required) {
		const idx = md.indexOf(`## ${sec}`);
		assert.notEqual(idx, -1, `deliverable stub missing section '${sec}'`);
		assert.ok(idx > lastIdx, `deliverable stub section '${sec}' out of order`);
		lastIdx = idx;
	}
});

// ---------------------------------------------------------------------------
// Default acceptance + end-to-end renderSpec
// ---------------------------------------------------------------------------

test('defaultAcceptance: includes the soft root-cause + no-regression criteria', () => {
	const list = _defaultAcceptanceForTest(input());
	const ids = list.map(c => c.id);
	assert.ok(ids.includes('soft.root-cause'));
	assert.ok(ids.includes('soft.no-regression'));
	for (const c of list) assert.equal(c.kind, 'soft');
});

test('renderSpec end-to-end: every top-level section is present in order', () => {
	const md = debugSessionTemplate.renderSpec(input());
	const required = [
		'# Debug Session: Fix the flaky test in foo.test.ts',
		'## Objective',
		'## Scope',
		'## Memory excerpts (related prior conversation)',
		'## Acceptance Criteria',
		'## Constraints',
		'## Discovery guidance',
		'## Deliverable structure',
	];
	let lastIdx = -1;
	for (const sec of required) {
		const idx = md.indexOf(sec);
		assert.notEqual(idx, -1, `renderSpec missing '${sec}'`);
		assert.ok(idx > lastIdx, `renderSpec section '${sec}' out of order`);
		lastIdx = idx;
	}
});

test('renderSpec: NEVER includes raw code blocks pre-fetched from source files (anti-leak guard)', () => {
	const md = debugSessionTemplate.renderSpec(input());
	// Spec uses inline code spans for IDs and paths but no fenced
	// code blocks. The presence of a fenced ``` block would be a
	// regression toward pre-fetched content.
	assert.equal(md.includes('\n```'), false,
		'spec must not embed fenced code blocks; that path is pre-fetched content (design §4.0 violation)');
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('registry: DEBUG-SESSION is the only registered template in Phase 2a', () => {
	assert.deepEqual(registeredTemplates(), ['DEBUG-SESSION']);
});

test('registry: findTemplate / getTemplate', () => {
	assert.equal(findTemplate('DEBUG-SESSION')?.id, 'DEBUG-SESSION');
	assert.equal(findTemplate('SPEC'), undefined);
	assert.throws(() => getTemplate('SPEC'), /Unknown handoff template/);
});

test('registry: assertTemplateInvariants passes on the Phase-2a surface', () => {
	assertTemplateInvariants();
});
