/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * P0 acceptance test -- skeleton + factory dispatch.
 *
 * Verifies:
 *   - shaperFor returns the expected method set per (mode, target)
 *   - generic target is rejected at task scope
 *   - missing target is rejected at run + task scope
 *   - every shaper-stub throws at call time (real driver lands in P3)
 *   - CONTRACT_FOOTER_MD is present + non-empty
 *   - PROMPT_PATHS has the expected five entries
 *
 * No LLM, no I/O, no Ollama dependency. Pure structural test.
 *
 * Run:
 *   npx tsx --test src/insrc/analyze/context/__tests__/p0-skeleton.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	CONTRACT_FOOTER_MD,
	PROMPT_PATHS,
	shaperFor,
} from '../../index.js';
import type {
	AnalyzeScopeRef,
	ClassificationShapeInput,
	ClassifiedIntent,
	PlannedTask,
	AnalyzeTaskTemplate,
	RunShapeInput,
	ShapeOpts,
	TaskShapeInput,
} from '../../index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCOPE_REF: AnalyzeScopeRef = { kind: 'workspace', value: '/tmp/test-ws' };

const INTENT: ClassifiedIntent = {
	target:    'code',
	scope:     'M',
	focused:   false,
	scopeRef:  SCOPE_REF,
	reasoning: 'test fixture',
};

const TASK: PlannedTask = {
	taskId:   't01',
	template: 'code.surface.functional',
	params:   {},
	outputs:  ['surface'],
};

const TEMPLATE: AnalyzeTaskTemplate = {
	id:       'code.surface.functional',
	target:   'code',
	family:   'surface',
	kind:     'leaf',
	revision: 'pre-registry',
};

const OPTS: ShapeOpts = { runId: 'test-run' };

// ---------------------------------------------------------------------------
// Contract footer
// ---------------------------------------------------------------------------

test('CONTRACT_FOOTER_MD is non-empty and references the three citation kinds', () => {
	assert.ok(CONTRACT_FOOTER_MD.length > 0);
	assert.match(CONTRACT_FOOTER_MD, /kind:\s*'source'/);
	assert.match(CONTRACT_FOOTER_MD, /kind:\s*'entity'/);
	assert.match(CONTRACT_FOOTER_MD, /kind:\s*'doc'/);
});

// ---------------------------------------------------------------------------
// PROMPT_PATHS catalog
// ---------------------------------------------------------------------------

test('PROMPT_PATHS has exactly the five expected shapers', () => {
	const keys = Object.keys(PROMPT_PATHS).sort();
	assert.deepEqual(keys, ['classification', 'code', 'data', 'generic', 'infra']);
});

test('PROMPT_PATHS values point at prompts/analyze/<shaper>.system.md', () => {
	for (const [shaperId, path] of Object.entries(PROMPT_PATHS)) {
		assert.equal(path, `prompts/analyze/${shaperId}.system.md`);
	}
});

// ---------------------------------------------------------------------------
// shaperFor -- classification
// ---------------------------------------------------------------------------

test("shaperFor('classification') returns a Shaper with buildClassificationBundle", () => {
	const shaper = shaperFor('classification');
	assert.equal(typeof shaper.buildClassificationBundle, 'function');
});

test("shaperFor('classification') stub throws on call (P3 fills it in)", async () => {
	const shaper = shaperFor('classification');
	const input: ClassificationShapeInput = {
		scopeRef:   SCOPE_REF,
		userPrompt: 'analyze this',
	};
	await assert.rejects(() => shaper.buildClassificationBundle(input, OPTS), {
		message: /P3 stub/,
	});
});

// ---------------------------------------------------------------------------
// shaperFor -- run-mode
// ---------------------------------------------------------------------------

for (const target of ['code', 'data', 'infra', 'generic'] as const) {
	test(`shaperFor('run', '${target}') returns a Shaper with buildRunBundle`, () => {
		const shaper = shaperFor('run', target);
		assert.equal(typeof shaper.buildRunBundle, 'function');
	});

	test(`shaperFor('run', '${target}') stub throws on call`, async () => {
		const shaper = shaperFor('run', target);
		const input: RunShapeInput = { intent: INTENT };
		await assert.rejects(() => shaper.buildRunBundle(input, OPTS), {
			message: /P3 stub/,
		});
	});
}

test("shaperFor('run') without a target throws TypeError", () => {
	assert.throws(
		// @ts-expect-error -- deliberately bypass overload signature
		() => shaperFor('run'),
		{ name: 'TypeError', message: /target is required/ },
	);
});

// ---------------------------------------------------------------------------
// shaperFor -- task-mode
// ---------------------------------------------------------------------------

for (const target of ['code', 'data', 'infra'] as const) {
	test(`shaperFor('task', '${target}') returns a Shaper with buildTaskBundle`, () => {
		const shaper = shaperFor('task', target);
		assert.equal(typeof shaper.buildTaskBundle, 'function');
	});

	test(`shaperFor('task', '${target}') stub throws on call`, async () => {
		const shaper = shaperFor('task', target);
		const input: TaskShapeInput = {
			intent:        INTENT,
			task:          TASK,
			template:      TEMPLATE,
			upstreamTasks: new Map(),
		};
		await assert.rejects(() => shaper.buildTaskBundle(input, OPTS), {
			message: /P3 stub/,
		});
	});
}

test("shaperFor('task') without a target throws TypeError", () => {
	assert.throws(
		// @ts-expect-error -- deliberately bypass overload signature
		() => shaperFor('task'),
		{ name: 'TypeError', message: /target is required/ },
	);
});

test("shaperFor('task', 'generic') is rejected", () => {
	assert.throws(
		// @ts-expect-error -- deliberately bypass overload signature
		() => shaperFor('task', 'generic'),
		{ name: 'TypeError', message: /generic is invalid at task scope/ },
	);
});
