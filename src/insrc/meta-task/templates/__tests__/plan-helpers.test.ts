/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for /plan template helpers (M4.a Phase 2).
 *
 * Plan ref: `plans/meta-task-plan.md` Phase 2.
 *
 * Covers:
 *   - parseStepsJson handles raw arrays, fenced JSON, mixed-markdown,
 *     malformed input.
 *   - extractJson parity with the legacy version's branch coverage.
 *   - validateAnalysisShape accepts well-formed analyses; rejects
 *     unknown category, invalid sub-category, missing required fields.
 *   - buildPlan produces stable ids, drops self-dependencies, drops
 *     out-of-range dependsOnIdx, preserves intra-array edges.
 *   - PLAN_CATEGORIES + PLAN_SUB_CATEGORIES are well-formed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	PLAN_CATEGORIES,
	PLAN_SUB_CATEGORIES,
	isPlanCategory,
	isValidSubCategory,
} from '../plan-types.js';
import {
	buildPlan,
	extractJson,
	parseStepsJson,
	validateAnalysisShape,
	type RawStep,
} from '../plan-helpers.js';


// ---------------------------------------------------------------------------
// Taxonomy + type guards
// ---------------------------------------------------------------------------

test('PLAN_CATEGORIES: 6 closed-enum values + isPlanCategory guard', () => {
	assert.equal(PLAN_CATEGORIES.length, 6);
	for (const c of PLAN_CATEGORIES) {
		assert.equal(isPlanCategory(c), true);
	}
	assert.equal(isPlanCategory('other'), false);
	assert.equal(isPlanCategory(undefined), false);
});

test('PLAN_SUB_CATEGORIES: every top-level has at least 4 sub-categories', () => {
	for (const c of PLAN_CATEGORIES) {
		assert.ok(PLAN_SUB_CATEGORIES[c].length >= 4, `${c} should have >= 4 sub-categories`);
	}
});

test('isValidSubCategory: positive + negative cases per category', () => {
	assert.equal(isValidSubCategory('implementation', 'new-feature'), true);
	assert.equal(isValidSubCategory('implementation', 'data-migration'), false);
	assert.equal(isValidSubCategory('test', 'unit'), true);
	assert.equal(isValidSubCategory('test', 'system-design'), false);
});


// ---------------------------------------------------------------------------
// parseStepsJson
// ---------------------------------------------------------------------------

test('parseStepsJson: raw JSON array', () => {
	const r = parseStepsJson('[{"title":"a","description":"A"},{"title":"b","description":"B"}]');
	assert.equal(r.length, 2);
	assert.equal(r[0]!.title, 'a');
});

test('parseStepsJson: fenced ```json block', () => {
	const r = parseStepsJson('```json\n[{"title":"x","description":"X"}]\n```');
	assert.equal(r.length, 1);
	assert.equal(r[0]!.title, 'x');
});

test('parseStepsJson: fenced bare ``` block', () => {
	const r = parseStepsJson('```\n[{"title":"y","description":"Y"}]\n```');
	assert.equal(r.length, 1);
});

test('parseStepsJson: array embedded in surrounding markdown', () => {
	const r = parseStepsJson('Here is the plan:\n\n[{"title":"z","description":"Z"}]\n\nDone.');
	assert.equal(r.length, 1);
	assert.equal(r[0]!.title, 'z');
});

test('parseStepsJson: malformed -> single-step fallback', () => {
	const r = parseStepsJson('not json at all');
	assert.equal(r.length, 1);
	assert.equal(r[0]!.title, 'Implementation');
	assert.equal(r[0]!.description, 'not json at all');
});

test('parseStepsJson: empty array -> empty result', () => {
	const r = parseStepsJson('[]');
	assert.equal(r.length, 0);
});

test('parseStepsJson: drops entries missing title', () => {
	const r = parseStepsJson('[{"title":"a","description":"A"},{"description":"no-title"}]');
	assert.equal(r.length, 1);
});


// ---------------------------------------------------------------------------
// extractJson
// ---------------------------------------------------------------------------

test('extractJson: fenced block takes precedence', () => {
	const r = extractJson('preface\n```json\n{"k":1}\n```\nrest');
	assert.equal(r.trim(), '{"k":1}');
});

test('extractJson: bare JSON object', () => {
	const r = extractJson('here is {"x":2} the body');
	assert.equal(r, '{"x":2}');
});

test('extractJson: bare JSON array', () => {
	const r = extractJson('list: [1,2,3]');
	assert.equal(r, '[1,2,3]');
});

test('extractJson: no JSON shape -> returns input', () => {
	const r = extractJson('plain text');
	assert.equal(r, 'plain text');
});


// ---------------------------------------------------------------------------
// validateAnalysisShape
// ---------------------------------------------------------------------------

test('validateAnalysisShape: accepts well-formed analysis', () => {
	const r = validateAnalysisShape({
		category:    'implementation',
		subCategory: 'new-feature',
		goals:       ['ship rate limiter', 'document behaviour'],
		constraints: ['use existing redis'],
		scope:       'medium',
	});
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.value.category,    'implementation');
		assert.equal(r.value.subCategory, 'new-feature');
		assert.equal(r.value.goals.length, 2);
	}
});

test('validateAnalysisShape: rejects unknown category', () => {
	const r = validateAnalysisShape({
		category:    'optimisation',                       // not in PLAN_CATEGORIES
		subCategory: 'new-feature',
		goals:       ['x'], constraints: [], scope: 'small',
	});
	assert.equal(r.ok, false);
	if (!r.ok) { assert.ok(r.errors.some(e => e.includes('category'))); }
});

test('validateAnalysisShape: rejects sub-category mismatched to category', () => {
	const r = validateAnalysisShape({
		category:    'implementation',
		subCategory: 'unit',                                // belongs to 'test'
		goals:       ['x'], constraints: [], scope: 'small',
	});
	assert.equal(r.ok, false);
	if (!r.ok) { assert.ok(r.errors.some(e => e.includes("'unit' not valid for category 'implementation'"))); }
});

test('validateAnalysisShape: rejects missing required fields', () => {
	const r1 = validateAnalysisShape({ category: 'test', subCategory: 'unit' });
	assert.equal(r1.ok, false);
	if (!r1.ok) {
		assert.ok(r1.errors.some(e => e.includes('goals')));
		assert.ok(r1.errors.some(e => e.includes('constraints')));
		assert.ok(r1.errors.some(e => e.includes('scope')));
	}
});

test('validateAnalysisShape: rejects null + non-object', () => {
	assert.equal(validateAnalysisShape(null).ok, false);
	assert.equal(validateAnalysisShape('a string').ok, false);
	assert.equal(validateAnalysisShape(42).ok, false);
});


// ---------------------------------------------------------------------------
// buildPlan
// ---------------------------------------------------------------------------

const raw3: readonly RawStep[] = [
	{ title: 'a', description: 'A', dependsOnIdx: [] },
	{ title: 'b', description: 'B', dependsOnIdx: [0] },
	{ title: 'c', description: 'C', dependsOnIdx: [0, 1] },
];

test('buildPlan: produces unique step ids and resolves dependsOnIdx -> id refs', () => {
	const plan = buildPlan('/r', 'Test plan', raw3, 'implementation');
	assert.equal(plan.steps.length, 3);
	const ids = plan.steps.map(s => s.id);
	assert.equal(new Set(ids).size, 3, 'all step ids unique');
	assert.deepEqual(plan.steps[1]!.dependencies, [ids[0]]);
	assert.deepEqual(plan.steps[2]!.dependencies, [ids[0], ids[1]]);
});

test('buildPlan: drops self-dependencies', () => {
	const plan = buildPlan('/r', 'Self-dep', [
		{ title: 'a', description: 'A', dependsOnIdx: [0] },        // depends on itself -> drop
	], 'implementation');
	assert.deepEqual(plan.steps[0]!.dependencies, []);
});

test('buildPlan: drops out-of-range dependsOnIdx', () => {
	const plan = buildPlan('/r', 'OOB', [
		{ title: 'a', description: 'A', dependsOnIdx: [99, -1] },
	], 'implementation');
	assert.deepEqual(plan.steps[0]!.dependencies, []);
});

test('buildPlan: title truncated to 200 chars', () => {
	const long = 'x'.repeat(500);
	const plan = buildPlan('/r', long, [], 'implementation');
	assert.equal(plan.title.length, 200);
});

test('buildPlan: description records category', () => {
	const plan = buildPlan('/r', 'Cat test', [], 'migration');
	assert.equal(plan.description, 'migration plan');
});

test('buildPlan: fileHint becomes notes', () => {
	const plan = buildPlan('/r', 'Notes', [
		{ title: 'a', description: 'A', fileHint: 'src/foo.ts' },
	], 'implementation');
	assert.equal(plan.steps[0]!.notes, 'File: src/foo.ts');
});

test('buildPlan: empty rawSteps -> empty steps array, plan still valid', () => {
	const plan = buildPlan('/r', 'Empty', [], 'documentation');
	assert.equal(plan.steps.length, 0);
	assert.equal(plan.status, 'active');
	assert.ok(plan.metadata.createdAt);
});
