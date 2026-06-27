/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Planner driver pure-function unit tests.
 *
 * Covers the bits of driver.ts that DON'T touch the LLM:
 *   - renderCatalog / renderDepthPolicy formatting
 *   - error classification (Ollama unavailability vs schema)
 *   - typed-error message shapes
 *
 * End-to-end behaviour against real Ollama lives in
 * planner.live.test.ts (next phase).
 *
 * Run:
 *   npx tsx --test src/insrc/analyze/planner/__tests__/driver-unit.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	PlanBuilderExhausted,
	PlanBuilderLlmUnavailableError,
	PlanBuilderPromptMissingError,
	PlanBuilderSchemaUnrecoverable,
	renderCatalog,
	renderDepthPolicy,
} from '../index.js';
import {
	_appendCorrectionTurnForTest,
	_buildInitialMessagesForTest,
	_classifyErrorForTest,
} from '../driver.js';
import type {
	AnalyzeTaskTemplate,
	ClassifiedIntent,
	PlanTask,
	PlanValidationFailure,
} from '../types.js';

// ---------------------------------------------------------------------------
// renderCatalog
// ---------------------------------------------------------------------------

const SAMPLE_TEMPLATE: AnalyzeTaskTemplate = {
	id:           'code.discovery.modules',
	target:       'code',
	family:       'discovery',
	kind:         'leaf',
	revision:     'r1',
	description:  'enumerate modules in scope',
	inputSchema:  { type: 'object', properties: { scopeRef: { type: 'object' } } },
	produces:     ['modules'],
};

const SAMPLE_AGGREGATOR: AnalyzeTaskTemplate = {
	id:           'code.aggregate.report',
	target:       'code',
	family:       'aggregate',
	kind:         'leaf',
	revision:     'r1',
	description:  'aggregate task outputs into the final report',
	inputSchema:  { type: 'object', additionalProperties: true },
	produces:     ['report'],
	isAggregator: true,
};

test('renderCatalog: empty catalog renders the no-templates marker', () => {
	const out = renderCatalog([]);
	assert.match(out, /no templates registered/);
});

test('renderCatalog: single template renders id + target + family + description + produces', () => {
	const out = renderCatalog([SAMPLE_TEMPLATE]);
	assert.match(out, /code\.discovery\.modules/);
	assert.match(out, /target.*code/);
	assert.match(out, /family.*discovery/);
	assert.match(out, /kind.*leaf/);
	assert.match(out, /enumerate modules in scope/);
	assert.match(out, /produces.*modules/);
	assert.match(out, /inputSchema/);
});

test('renderCatalog: aggregator template flags itself with INV-12 hint', () => {
	const out = renderCatalog([SAMPLE_AGGREGATOR]);
	assert.match(out, /aggregator.*yes/);
	assert.match(out, /INV-12/);
});

test('renderCatalog: catalog order is preserved', () => {
	const out = renderCatalog([SAMPLE_TEMPLATE, SAMPLE_AGGREGATOR]);
	const discoveryIdx  = out.indexOf('code.discovery.modules');
	const aggregatorIdx = out.indexOf('code.aggregate.report');
	assert.ok(discoveryIdx >= 0);
	assert.ok(aggregatorIdx >= 0);
	assert.ok(discoveryIdx < aggregatorIdx);
});

// ---------------------------------------------------------------------------
// renderDepthPolicy
// ---------------------------------------------------------------------------

test('renderDepthPolicy: M scope reports 20-40 band', () => {
	const out = renderDepthPolicy('M', false);
	assert.match(out, /scope.*M/);
	assert.match(out, /expected task count.*20-40/);
});

test('renderDepthPolicy: focused intent halves the lower bound only', () => {
	const out = renderDepthPolicy('M', true);
	assert.match(out, /expected task count.*10-40/);
	assert.match(out, /focused intent reduces the lower bound to half/);
});

test('renderDepthPolicy: XS depth hint mentions detailed per-unit', () => {
	const out = renderDepthPolicy('XS', false);
	assert.match(out, /scope.*XS/);
	assert.match(out, /expected task count.*3-8/);
	assert.match(out, /most detailed/i);
});

test('renderDepthPolicy: XL depth hint mentions structural breadth + child plans', () => {
	const out = renderDepthPolicy('XL', false);
	assert.match(out, /expected task count.*40-80/);
	assert.match(out, /most structural/i);
	assert.match(out, /child plans?/i);
});

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

test('classifyError(ECONNREFUSED) -> PlanBuilderLlmUnavailableError', () => {
	const err = new Error('connect ECONNREFUSED 127.0.0.1:11434');
	const out = _classifyErrorForTest(err);
	assert.ok(out instanceof PlanBuilderLlmUnavailableError);
	assert.match(out.message, /ECONNREFUSED/);
});

test('classifyError("Ollama is not running") -> PlanBuilderLlmUnavailableError', () => {
	const err = new Error('Ollama is not running. Start it with: ollama serve');
	const out = _classifyErrorForTest(err);
	assert.ok(out instanceof PlanBuilderLlmUnavailableError);
});

test('classifyError("Model not found") -> PlanBuilderLlmUnavailableError', () => {
	const err = new Error('Model not found in Ollama.');
	const out = _classifyErrorForTest(err);
	assert.ok(out instanceof PlanBuilderLlmUnavailableError);
});

test('classifyError(arbitrary error) -> PlanBuilderSchemaUnrecoverable', () => {
	const err = new Error('json parse failed');
	const out = _classifyErrorForTest(err);
	assert.ok(out instanceof PlanBuilderSchemaUnrecoverable);
});

test('classifyError(non-Error) -> wraps in PlanBuilderSchemaUnrecoverable', () => {
	const out = _classifyErrorForTest('thrown string');
	assert.ok(out instanceof Error);
});

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

test('PlanBuilderLlmUnavailableError carries cause in message', () => {
	const e = new PlanBuilderLlmUnavailableError('ECONNREFUSED');
	assert.equal(e.name, 'PlanBuilderLlmUnavailableError');
	assert.match(e.message, /Local Ollama unavailable for Plan Builder/);
	assert.match(e.message, /ECONNREFUSED/);
});

test('PlanBuilderSchemaUnrecoverable carries error list in message', () => {
	const e = new PlanBuilderSchemaUnrecoverable(['missing field foo', 'bad type bar']);
	assert.equal(e.name, 'PlanBuilderSchemaUnrecoverable');
	assert.match(e.message, /missing field foo/);
	assert.match(e.message, /bad type bar/);
});

test('PlanBuilderPromptMissingError carries the absolute path', () => {
	const e = new PlanBuilderPromptMissingError('/abs/path/planner.system.md');
	assert.equal(e.name, 'PlanBuilderPromptMissingError');
	assert.match(e.message, /\/abs\/path\/planner\.system\.md/);
});

test('PlanBuilderExhausted carries attempts + failures + lastFailure', () => {
	const attempts: PlanTask[] = [
		{ planId: 'p-root', goal: 'g', target: 'code', scope: 'M',
		  tasks: [], reasoning: 'r' },
	];
	const failures: PlanValidationFailure[] = [
		{ invariantId: 'INV-1', message: 'tasks list empty' },
	];
	const e = new PlanBuilderExhausted(attempts, failures);
	assert.equal(e.name, 'PlanBuilderExhausted');
	assert.equal(e.attempts.length, 1);
	assert.equal(e.failures.length, 1);
	assert.equal(e.lastFailure.invariantId, 'INV-1');
	assert.match(e.message, /INV-1/);
	assert.match(e.message, /tasks list empty/);
});

// ---------------------------------------------------------------------------
// Initial-message + correction-turn shape
// ---------------------------------------------------------------------------

const SAMPLE_INTENT: ClassifiedIntent = {
	target:    'code',
	scope:     'M',
	focused:   false,
	scopeRef:  { kind: 'repo', value: '/r' },
	reasoning: 'test',
};

test('buildInitialMessages: emits 2 messages (system, user) with all the required sections', () => {
	const msgs = _buildInitialMessagesForTest({
		promptContent: 'PLANNER SYSTEM PROMPT',
		bundleMd:      'BUNDLE BODY',
		intent:        SAMPLE_INTENT,
		catalog:       [SAMPLE_TEMPLATE, SAMPLE_AGGREGATOR],
	});
	assert.equal(msgs.length, 2);
	assert.equal(msgs[0]!.role, 'system');
	assert.equal(msgs[1]!.role, 'user');

	const sys  = msgs[0]!.content as string;
	const user = msgs[1]!.content as string;

	assert.match(sys, /PLANNER SYSTEM PROMPT/);
	assert.match(sys, /Contract reminder/);   // CONTRACT_FOOTER_MD heading

	assert.match(user, /PlanSchemaVersion/);
	assert.match(user, /## Intent/);
	assert.match(user, /## Context bundle/);
	assert.match(user, /BUNDLE BODY/);
	assert.match(user, /## DEPTH POLICY BAND/);
	assert.match(user, /## TASK CATALOG/);
	assert.match(user, /code\.discovery\.modules/);
	assert.match(user, /code\.aggregate\.report/);
	assert.match(user, /## OUTPUT SHAPE/);
	assert.match(user, /## TASK/);
});

test('buildInitialMessages: child-plan parentTaskPath emits the warning note', () => {
	const msgs = _buildInitialMessagesForTest({
		promptContent: 'P',
		bundleMd:      'B',
		intent:        SAMPLE_INTENT,
		catalog:       [SAMPLE_TEMPLATE],
		parentTaskPath: 't02',
	});
	const user = msgs[1]!.content as string;
	assert.match(user, /Child plan.*t02/);
	assert.match(user, /Do NOT emit `parentTaskPath`/);
});

test('appendCorrectionTurn: re-issues with the assistant turn + VALIDATOR FEEDBACK block', () => {
	const prior = [
		{ role: 'system' as const, content: 'sys' },
		{ role: 'user'   as const, content: 'init' },
	];
	const rejected: PlanTask = {
		planId: 'p-root', goal: 'g', target: 'code', scope: 'M',
		tasks: [], reasoning: 'r',
	};
	const failure: PlanValidationFailure = {
		invariantId: 'INV-1',
		message:     'tasks list must be non-empty',
	};
	const out = _appendCorrectionTurnForTest(prior, rejected, failure);
	assert.equal(out.length, 4);
	assert.equal(out[2]!.role, 'assistant');
	assert.equal(out[3]!.role, 'user');
	const userBody = out[3]!.content as string;
	assert.match(userBody, /VALIDATOR FEEDBACK/);
	assert.match(userBody, /INV-1/);
	assert.match(userBody, /tasks list must be non-empty/);
});

test('appendCorrectionTurn with failure.target renders the pointer', () => {
	const prior = [
		{ role: 'user' as const, content: 'init' },
	];
	const rejected: PlanTask = {
		planId: 'p-root', goal: 'g', target: 'code', scope: 'M',
		tasks: [], reasoning: 'r',
	};
	const failure: PlanValidationFailure = {
		invariantId: 'INV-12',
		message:     'aggregator must be last',
		target:      { aggregatorIndex: 5, lastIndex: 19 },
	};
	const out = _appendCorrectionTurnForTest(prior, rejected, failure);
	const userBody = out[2]!.content as string;
	assert.match(userBody, /Pointer:/);
	assert.match(userBody, /aggregatorIndex/);
});
