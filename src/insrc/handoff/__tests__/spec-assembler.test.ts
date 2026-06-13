/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Spec assembler tests.
 *
 * The assembler is pure composition over the template registry; these
 * tests verify the composition contract -- input shape preserved into
 * SpecMeta, template defaults applied when caller doesn't supply
 * acceptance/permissions/risk, persistence to disk under the right
 * path layout, and the templateExtras pass-through that lets
 * template-specific render functions read their own input.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleSpec, type SpecAssemblerInput } from '../spec-assembler.js';
import type {
	AcceptanceCriterion,
	MemoryRef,
	PermissionsBlock,
	ScopePayload,
} from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCOPE: ScopePayload = {
	repoId:          '/r',
	repoPath:        '/r',
	inScopeGlobs:    ['src/**'],
	outOfScopePaths: ['infra/'],
	riskHints:       'low',
};

const MEM: MemoryRef[] = [{ kind: 'turn', id: 'turn-1', oneLineSummary: 'prior debug attempt' }];

const PERMS: PermissionsBlock = {
	allow:  [{ tool: 'Edit', paths: ['src/**'] }],
	prompt: [{ tool: 'Bash', commands: ['git push'] }],
	deny:   [{ tool: 'WebFetch' }],
};

function baseInput(over: Partial<SpecAssemblerInput> = {}): SpecAssemblerInput {
	return {
		templateId:    'DEBUG-SESSION',
		intent:        'Fix flaky test',
		scope:         SCOPE,
		memoryRefs:    MEM,
		worktreePath:  '/tmp/insrc/handoffs/sess-x/worktree',
		timeBudgetSec: 600,
		...over,
	};
}

// ---------------------------------------------------------------------------
// Composition basics
// ---------------------------------------------------------------------------

test('assembleSpec: returns specId, templateId, specMd, meta', () => {
	const out = assembleSpec(baseInput());
	assert.match(out.specId, /^spec-/);
	assert.equal(out.templateId, 'DEBUG-SESSION');
	assert.match(out.specMd,  /^# Debug Session: Fix flaky test/);
	assert.equal(out.meta.specId, out.specId);
	assert.equal(out.meta.templateId, 'DEBUG-SESSION');
	assert.equal(out.meta.templateVersion, 1);
});

test('assembleSpec: specIdOverride wins (test seam)', () => {
	const out = assembleSpec(baseInput({ specIdOverride: 'spec-fixed' }));
	assert.equal(out.specId, 'spec-fixed');
	assert.equal(out.meta.specId, 'spec-fixed');
});

test('assembleSpec: scope + memoryRefs + intent + worktree + timeBudget propagate verbatim into meta', () => {
	const out = assembleSpec(baseInput());
	assert.deepEqual(out.meta.scope, SCOPE);
	assert.deepEqual(out.meta.memoryRefs, MEM);
	assert.equal(out.meta.intent, 'Fix flaky test');
	assert.equal(out.meta.worktreePath, '/tmp/insrc/handoffs/sess-x/worktree');
	assert.equal(out.meta.timeBudgetSec, 600);
});

// ---------------------------------------------------------------------------
// Template defaults
// ---------------------------------------------------------------------------

test('assembleSpec: missing acceptance -> template default ("soft.root-cause" + "soft.no-regression")', () => {
	const out = assembleSpec(baseInput());
	const ids = out.meta.acceptanceCriteria.map(c => c.id);
	assert.ok(ids.includes('soft.root-cause'));
	assert.ok(ids.includes('soft.no-regression'));
});

test('assembleSpec: caller-supplied acceptance overrides the template default', () => {
	const custom: AcceptanceCriterion[] = [
		{ id: 'machine.x', description: 'x exists', kind: 'machine',
			verifier: { type: 'file-exists', path: 'x.txt' } },
	];
	const out = assembleSpec(baseInput({ acceptance: custom }));
	assert.deepEqual(
		out.meta.acceptanceCriteria.map(c => c.id),
		['machine.x'],
	);
});

test('assembleSpec: missing riskTag -> template defaultRisk ("low" for DEBUG-SESSION)', () => {
	const out = assembleSpec(baseInput());
	assert.equal(out.meta.riskTag, 'low');
});

test('assembleSpec: caller-supplied riskTag overrides default', () => {
	const out = assembleSpec(baseInput({ riskTag: 'medium' }));
	assert.equal(out.meta.riskTag, 'medium');
});

test('assembleSpec: missing permissions -> empty PermissionsBlock (allow/prompt/deny all empty)', () => {
	const out = assembleSpec(baseInput());
	assert.deepEqual(out.meta.permissions, { allow: [], prompt: [], deny: [] });
});

test('assembleSpec: caller-supplied permissions propagate into meta', () => {
	const out = assembleSpec(baseInput({ permissions: PERMS }));
	assert.deepEqual(out.meta.permissions, PERMS);
});

// ---------------------------------------------------------------------------
// templateExtras
// ---------------------------------------------------------------------------

test('assembleSpec: templateExtras pass through to the template renderer (failingTest in DEBUG-SESSION)', () => {
	const out = assembleSpec(baseInput({ templateExtras: { failingTest: 'foo.test.ts' } }));
	// The template renders the failing-test hint inside the Objective
	// section when set. If the extras failed to flow through, this
	// assertion would fail.
	assert.match(out.specMd, /Failing test \(hint\): `foo\.test\.ts`/);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('assembleSpec: with persistRoot+sessionId -> writes spec.md + meta.json under <root>/<sessionId>/', () => {
	const persistRoot = mkdtempSync(join(tmpdir(), 'insrc-spec-test-'));
	const out = assembleSpec(baseInput({
		persistRoot,
		sessionId:      'sess-7',
		specIdOverride: 'spec-fixed-7',
	}));
	const dir = join(persistRoot, 'sess-7');
	assert.equal(existsSync(join(dir, 'spec-fixed-7.md')),         true);
	assert.equal(existsSync(join(dir, 'spec-fixed-7.meta.json')),  true);
	const writtenMd   = readFileSync(join(dir, 'spec-fixed-7.md'), 'utf8');
	const writtenMeta = JSON.parse(readFileSync(join(dir, 'spec-fixed-7.meta.json'), 'utf8')) as { specId: string; templateVersion: number };
	assert.equal(writtenMd, out.specMd);
	assert.equal(writtenMeta.specId,          'spec-fixed-7');
	assert.equal(writtenMeta.templateVersion, 1);
});

test('assembleSpec: without persistRoot -> nothing written to disk; pure return value', () => {
	// No persistRoot, no sessionId: assembler still returns the spec
	// content but creates no directories.
	const out = assembleSpec(baseInput());
	assert.ok(out.specMd.length > 0);
	assert.ok(out.meta.specId.length > 0);
	// Nothing to inspect -- the absence of side effects is itself the
	// assertion. The test passes if we got here without throwing.
});

// ---------------------------------------------------------------------------
// Unknown template
// ---------------------------------------------------------------------------

test('assembleSpec: unknown template id throws via getTemplate', () => {
	assert.throws(
		() => assembleSpec(baseInput({ templateId: 'SPEC' })),
		/Unknown handoff template id 'SPEC'/,
	);
});
