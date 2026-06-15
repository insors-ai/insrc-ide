/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 7 template contract tests.
 *
 * Every template registered in `registry.ts` is asserted against
 * the same shared shape: it returns a spec markdown with the
 * canonical leading sections, declares a list of required
 * deliverable sections, and emits a stub whose `## <Name>`
 * headers exactly match that list in order. Adding a new
 * template that violates any of these contracts fails here.
 *
 * Per-template assertions then pin the unique pieces (default
 * risk tag, presence of template-specific guidance bullets) so
 * the templates can't silently lose their identity.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
	findTemplate,
	registeredTemplates,
	assertTemplateInvariants,
} from '../templates/registry.js';
import type { TemplateDefinition } from '../templates/types.js';
import type {
	AcceptanceCriterion,
	MemoryRef,
	PermissionsBlock,
	ScopePayload,
	TemplateId,
} from '../types.js';

// ---------------------------------------------------------------------------
// Shared fixture for every template's renderSpec
// ---------------------------------------------------------------------------

const SCOPE: ScopePayload = {
	repoId: '/r', repoPath: '/r',
	inScopeGlobs: ['src/**'], outOfScopePaths: ['secrets/**'],
	riskHints: 'low',
};
const MEMORY: readonly MemoryRef[] = [
	{ kind: 'turn',     id: 't-1', oneLineSummary: 'prior debugging attempt' },
	{ kind: 'artifact', id: 'a-1', oneLineSummary: 'related design note' },
];
const ACCEPTANCE: readonly AcceptanceCriterion[] = [
	{ id: 'soft.X', description: 'X must hold', kind: 'soft' },
];
const PERMISSIONS: PermissionsBlock = { allow: [], prompt: [], deny: [] };

function fixtureInput(): Parameters<TemplateDefinition['renderSpec']>[0] {
	return {
		intent:        'do the thing',
		scope:         SCOPE,
		memoryRefs:    MEMORY,
		acceptance:    ACCEPTANCE,
		permissions:   PERMISSIONS,
		riskTag:       'low',
		worktreePath:  '/tmp/wt',
		timeBudgetSec: 600,
	};
}

// ---------------------------------------------------------------------------
// Registry-level invariants
// ---------------------------------------------------------------------------

test('Phase 7 registry: assertTemplateInvariants holds (registered set matches expected)', () => {
	assertTemplateInvariants();
});

test('Phase 7 registry: contains all 8 known template ids', () => {
	const got = new Set(registeredTemplates());
	assert.deepStrictEqual(
		[...got].sort(),
		['AUDIT', 'DEBUG-SESSION', 'DESIGN', 'MIGRATION', 'REQUIREMENTS', 'REVIEW', 'SPEC', 'TEST-PLAN'].sort(),
	);
});

// ---------------------------------------------------------------------------
// Per-template shared contract
// ---------------------------------------------------------------------------

const PHASE7_TEMPLATES: readonly TemplateId[] = [
	'SPEC', 'DESIGN', 'REQUIREMENTS', 'TEST-PLAN', 'REVIEW', 'MIGRATION', 'AUDIT',
];

for (const id of PHASE7_TEMPLATES) {
	test(`template ${id}: registers + reports its own id`, () => {
		const t = findTemplate(id);
		assert.ok(t !== undefined, `${id} should be registered`);
		assert.equal(t!.id, id);
	});

	test(`template ${id}: requiredDeliverableSections is a non-empty array`, () => {
		const t = findTemplate(id)!;
		assert.ok(t.requiredDeliverableSections.length > 0);
	});

	test(`template ${id}: deliverable stub headers match requiredDeliverableSections in order`, () => {
		const t = findTemplate(id)!;
		const stub = t.renderDeliverableStub();
		const headers = [...stub.matchAll(/^## (.+)$/gm)].map(m => m[1]!.trim());
		assert.deepStrictEqual(headers, t.requiredDeliverableSections);
	});

	test(`template ${id}: spec includes all canonical leading sections`, () => {
		const t = findTemplate(id)!;
		const spec = t.renderSpec(fixtureInput());
		assert.match(spec, /^## Objective$/m,            `${id} spec must have ## Objective`);
		assert.match(spec, /^## Scope$/m,                `${id} spec must have ## Scope`);
		assert.match(spec, /^## Memory excerpts/m,       `${id} spec must have ## Memory excerpts`);
		assert.match(spec, /^## Acceptance Criteria$/m,  `${id} spec must have ## Acceptance Criteria`);
		assert.match(spec, /^## Constraints$/m,          `${id} spec must have ## Constraints`);
		assert.match(spec, /^## Discovery guidance$/m,   `${id} spec must have ## Discovery guidance`);
		assert.match(spec, /^## Deliverable structure$/m, `${id} spec must have ## Deliverable structure`);
	});

	test(`template ${id}: spec embeds every required deliverable section header in document order`, () => {
		const t = findTemplate(id)!;
		const spec = t.renderSpec(fixtureInput());
		// The deliverable-structure-reference block lists them as
		// `## <Name>` literals inside backticks. Pull them out and
		// compare to the canonical list.
		const referenceMatches = [...spec.matchAll(/`## ([^`]+)`/g)].map(m => m[1]!.trim());
		// The literal list must appear AS A SUFFIX of the doc
		// (the reference block sits at the spec's tail).
		const required = t.requiredDeliverableSections;
		assert.ok(
			referenceMatches.length >= required.length,
			`expected at least ${required.length} reference matches, got ${referenceMatches.length}`,
		);
		const tail = referenceMatches.slice(referenceMatches.length - required.length);
		assert.deepStrictEqual(tail, [...required]);
	});

	test(`template ${id}: spec respects intent + repoId substitutions`, () => {
		const t = findTemplate(id)!;
		const spec = t.renderSpec(fixtureInput());
		assert.ok(spec.includes('do the thing'),  `${id} spec must include the intent`);
		assert.ok(spec.includes('/r'),            `${id} spec must include the repoId`);
		assert.ok(spec.includes('secrets/**'),    `${id} spec must include out-of-scope paths`);
	});

	test(`template ${id}: defaultAcceptance returns a non-empty list of soft criteria`, () => {
		const t = findTemplate(id)!;
		const accept = t.defaultAcceptance(fixtureInput());
		assert.ok(accept.length > 0, `${id} must declare at least one default acceptance criterion`);
		for (const c of accept) {
			assert.match(c.id, /^soft\./, `${id}'s default criteria ids should be 'soft.<name>'`);
			assert.equal(c.kind, 'soft', `${id} should ship soft defaults; templates can extend with machine criteria`);
		}
	});

	test(`template ${id}: empty memoryRefs produces a spec without a Memory excerpts heading`, () => {
		const t = findTemplate(id)!;
		const inp = fixtureInput();
		(inp as { memoryRefs: readonly MemoryRef[] }).memoryRefs = [];
		const spec = t.renderSpec(inp);
		assert.equal(
			/^## Memory excerpts/m.test(spec),
			false,
			`${id} spec should omit the Memory excerpts header when no refs are passed`,
		);
	});
}

// ---------------------------------------------------------------------------
// Per-template unique invariants
// ---------------------------------------------------------------------------

test('SPEC: default risk is low', () => {
	assert.equal(findTemplate('SPEC')!.defaultRisk, 'low');
});

test('DESIGN: default risk is low', () => {
	assert.equal(findTemplate('DESIGN')!.defaultRisk, 'low');
});

test('REQUIREMENTS: default risk is low; requires FR / NFR numbering in guidance', () => {
	const t = findTemplate('REQUIREMENTS')!;
	assert.equal(t.defaultRisk, 'low');
	const spec = t.renderSpec(fixtureInput());
	assert.match(spec, /FR-1/);
	assert.match(spec, /NFR-1/);
});

test('TEST-PLAN: default risk is low; Scenarios require TS-N numbering', () => {
	const t = findTemplate('TEST-PLAN')!;
	assert.equal(t.defaultRisk, 'low');
	assert.match(t.renderSpec(fixtureInput()), /TS-N/);
});

test('REVIEW: default risk is low; findings tagged with severity', () => {
	const t = findTemplate('REVIEW')!;
	assert.equal(t.defaultRisk, 'low');
	const spec = t.renderSpec(fixtureInput());
	assert.match(spec, /blocker.*major.*minor.*nit/);
});

test('MIGRATION: default risk is HIGH (per plan)', () => {
	const t = findTemplate('MIGRATION')!;
	assert.equal(t.defaultRisk, 'high');
	const spec = t.renderSpec(fixtureInput());
	assert.match(spec, /Rollback/);
});

test('AUDIT: default risk is medium; findings tagged pass/note/fail', () => {
	const t = findTemplate('AUDIT')!;
	assert.equal(t.defaultRisk, 'medium');
	const spec = t.renderSpec(fixtureInput());
	assert.match(spec, /pass.*note.*fail/);
});

test('SPEC: anchorEntityId is surfaced in discovery guidance when provided', () => {
	const t = findTemplate('SPEC')!;
	const inp: Parameters<typeof t.renderSpec>[0] & { anchorEntityId?: string } = {
		...fixtureInput(),
		anchorEntityId: 'fn:add#abc123',
	};
	const spec = t.renderSpec(inp);
	assert.match(spec, /fn:add#abc123/);
});

test('DEBUG-SESSION still registers (Phase 2a wedge) alongside the Phase 7 set', () => {
	const t = findTemplate('DEBUG-SESSION');
	assert.ok(t !== undefined);
	assert.equal(t!.defaultRisk, 'low');
});
