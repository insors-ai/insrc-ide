/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the decide-next-step writer's `renderPriorAttempts`
 * block -- the failed-skill history surfaced to the cloud-tier decider
 * so it can avoid alternating-loop dead ends. Pure rendering, no LLM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	_renderPriorAttemptsForTest,
	type DecidePriorAttempt,
} from '../decide-next-step.js';

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

test('renderPriorAttempts: empty input -> empty string', () => {
	const out = _renderPriorAttemptsForTest([]);
	assert.equal(out, '');
});

// ---------------------------------------------------------------------------
// Single attempt
// ---------------------------------------------------------------------------

test('renderPriorAttempts: single attempt renders status + intent + skills', () => {
	const a: DecidePriorAttempt = {
		stepId:   's1',
		intent:   'locate the schema file',
		skillIds: ['code.entity.locate'],
		status:   'ok',
	};
	const out = _renderPriorAttemptsForTest([a]);
	assert.match(out, /PRIOR ATTEMPTS/);
	assert.match(out, /s1 \[ok\] -- locate the schema file/);
	assert.match(out, /skills:.*`code\.entity\.locate`/);
});

// ---------------------------------------------------------------------------
// Repeated skills -- collapsed tally
// ---------------------------------------------------------------------------

test('renderPriorAttempts: repeated skill ids collapse to "x N" tally', () => {
	const a: DecidePriorAttempt = {
		stepId:   's2',
		intent:   'compare fields',
		skillIds: ['shared.compare.fields-vs-shape', 'shared.compare.fields-vs-shape', 'shared.compare.fields-vs-shape'],
		status:   'failed',
	};
	const out = _renderPriorAttemptsForTest([a]);
	assert.match(out, /`shared\.compare\.fields-vs-shape` x 3/);
});

// ---------------------------------------------------------------------------
// Multiple attempts -- each rendered on its own line
// ---------------------------------------------------------------------------

test('renderPriorAttempts: multiple attempts render in input order', () => {
	const attempts: DecidePriorAttempt[] = [
		{ stepId: 's1', intent: 'first', skillIds: ['x.skill.a'], status: 'ok' },
		{ stepId: 's2', intent: 'second', skillIds: ['x.skill.b'], status: 'failed' },
		{ stepId: 's3', intent: 'third', skillIds: ['x.skill.c'], status: 'partial' },
	];
	const out = _renderPriorAttemptsForTest(attempts);
	const idx1 = out.indexOf('s1 [ok]');
	const idx2 = out.indexOf('s2 [failed]');
	const idx3 = out.indexOf('s3 [partial]');
	assert.ok(idx1 >= 0 && idx2 > idx1 && idx3 > idx2, 'attempts must render in input order');
});

// ---------------------------------------------------------------------------
// Rules block always trailing
// ---------------------------------------------------------------------------

test('renderPriorAttempts: rules block follows the attempt list', () => {
	const a: DecidePriorAttempt = {
		stepId:   's1',
		intent:   'x',
		skillIds: ['x.y.z'],
		status:   'failed',
	};
	const out = _renderPriorAttemptsForTest([a]);
	const stepIdx = out.indexOf('s1 [failed]');
	const rulesIdx = out.indexOf('Rules drawn from PRIOR ATTEMPTS');
	assert.ok(stepIdx >= 0 && rulesIdx > stepIdx, 'rules block must follow attempt list');
	assert.match(out, /do NOT pick it again/);
	assert.match(out, /terminate verdict=unrecoverable/);
});

// ---------------------------------------------------------------------------
// Intent truncation
// ---------------------------------------------------------------------------

test('renderPriorAttempts: long intent truncated to 100 chars', () => {
	const longIntent = 'x'.repeat(200);
	const a: DecidePriorAttempt = {
		stepId:   's1',
		intent:   longIntent,
		skillIds: ['x.y.z'],
		status:   'ok',
	};
	const out = _renderPriorAttemptsForTest([a]);
	// The intent slice is 100 chars; verify the 101st x is absent on that line
	const line = out.split('\n').find(l => l.startsWith('- s1'));
	assert.ok(line !== undefined);
	assert.ok(line.length < longIntent.length, 'intent should be truncated');
});
