/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the keyword classifier feeding the `/handoff` test
 * harness. Predictability matters more than precision -- the
 * goal is that a tester can hit every template by phrasing the
 * prompt accordingly without reading the source.
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { classifyHandoffIntent } from '../../browser/handoff/handoffClassifier.js';

suite('classifyHandoffIntent', () => {

	ensureNoDisposablesAreLeakedInTestSuite();


	test('debug cues route to DEBUG-SESSION', () => {
		assert.equal(classifyHandoffIntent('fix the failing test in payments.test.ts').templateId, 'DEBUG-SESSION');
		assert.equal(classifyHandoffIntent('reproduce the crash on cold start').templateId, 'DEBUG-SESSION');
		assert.equal(classifyHandoffIntent('debug why the auth middleware leaks').templateId, 'DEBUG-SESSION');
	});

	test('implementation cues route to SPEC', () => {
		assert.equal(classifyHandoffIntent('implement a rate limiter for /v1/sessions').templateId, 'SPEC');
		assert.equal(classifyHandoffIntent('add support for OAuth device flow').templateId, 'SPEC');
		assert.equal(classifyHandoffIntent('refactor the retry loop into a helper').templateId, 'SPEC');
	});

	test('design cues route to DESIGN', () => {
		assert.equal(classifyHandoffIntent('design a token-bucket rate limiter').templateId, 'DESIGN');
		assert.equal(classifyHandoffIntent('how should we architect the cache?').templateId, 'DESIGN');
		assert.equal(classifyHandoffIntent('ADR for the auth migration').templateId, 'DESIGN');
	});

	test('requirements cues route to REQUIREMENTS', () => {
		assert.equal(classifyHandoffIntent('capture requirements for the billing dashboard').templateId, 'REQUIREMENTS');
		assert.equal(classifyHandoffIntent('what should the API expose to mobile?').templateId, 'REQUIREMENTS');
	});

	test('test-plan cues route to TEST-PLAN', () => {
		assert.equal(classifyHandoffIntent('write a test plan for the rate limiter').templateId, 'TEST-PLAN');
		assert.equal(classifyHandoffIntent('what tests do we need for the new sessions endpoint?').templateId, 'TEST-PLAN');
	});

	test('review cues route to REVIEW', () => {
		assert.equal(classifyHandoffIntent('review the last commit').templateId, 'REVIEW');
		assert.equal(classifyHandoffIntent('critique the new auth design').templateId, 'REVIEW');
	});

	test('migration cues route to MIGRATION', () => {
		assert.equal(classifyHandoffIntent('migrate from session cookies to JWT').templateId, 'MIGRATION');
		assert.equal(classifyHandoffIntent('schema bump for the payments table').templateId, 'MIGRATION');
	});

	test('audit cues route to AUDIT', () => {
		assert.equal(classifyHandoffIntent('audit the access logs against the policy').templateId, 'AUDIT');
		assert.equal(classifyHandoffIntent('verify the SOC2 claims in the design doc').templateId, 'AUDIT');
	});

	test('explicit template= override wins regardless of cues', () => {
		const r = classifyHandoffIntent('template=MIGRATION add a brand new feature');
		assert.equal(r.templateId, 'MIGRATION');
		assert.equal(r.viaOverride, true);
		assert.equal(r.intent, 'add a brand new feature');
	});

	test('unknown template= override falls through to keyword scoring', () => {
		const r = classifyHandoffIntent('template=NOPE fix the failing test');
		assert.equal(r.viaOverride, false);
		// The literal `template=NOPE` doesn't trip any cue, but
		// "failing test" does (DEBUG-SESSION), so that wins.
		assert.equal(r.templateId, 'DEBUG-SESSION');
	});

	test('no recognizable cues fall back to SPEC', () => {
		const r = classifyHandoffIntent('do the thing');
		assert.equal(r.templateId, 'SPEC');
		assert.equal(r.viaOverride, false);
	});
});
