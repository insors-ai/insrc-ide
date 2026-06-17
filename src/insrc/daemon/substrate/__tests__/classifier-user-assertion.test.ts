/**
 * User-assertion classifier tests -- part of P5.6.
 *
 * Coverage (Layer 1 heuristic + injectable Layer 2 / Layer 3):
 *   - "always X" -> accept with polarity 'do' + subject extracted.
 *   - "never Y"  -> accept with polarity 'avoid'.
 *   - "use X for Y" -> accept with subject 'X-for-Y' and polarity
 *     'value-set'.
 *   - "for this PR ..." -> task-local reject.
 *   - Sentence without an assertion marker -> no spans detected.
 *   - Layer 2 hook is invoked on ambiguous spans; an LLM-style
 *     accept above threshold flows through.
 *   - Layer 2 accept BELOW threshold escalates to Layer 3
 *     user-confirm; user-accept resolves to accepted.
 *   - Layer 2 reject flows to rejected with the reason captured.
 *   - Default no-LLM classifier defers ambiguous spans.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	createDefaultClassifier,
	type LlmClassifyHook,
	type UserConfirmHook,
	type UserAssertionPayload,
} from '../classifier/user-assertion.js';

// ---------------------------------------------------------------------------

// G1 + G3 reframing (memory-context, 2026-06-17): Layer 1 no longer accepts
// imperative shapes on its own. It defers everything that isn't task-local
// to Layer 2 (LLM closed-enum classifier). Without an LLM wired, the default
// classifier's Layer 2 stub returns 'defer', so previously-accepted spans
// now land in `deferred` instead of `accepted`.

test('always X -> deferred to Layer 2 with heuristic subject + polarity hints', async () => {
	const c = createDefaultClassifier();
	const r = await c.classify({ turnId: 't1', text: 'always use snake_case for python variables.' });
	assert.equal(r.accepted.length, 0);
	assert.equal(r.deferred.length, 1);
	// Layer 1 still records its heuristic findings in the decisions trace.
	const layer1Decision = r.decisions.find(d => d.layer === 1);
	assert.ok(layer1Decision !== undefined);
	assert.equal(layer1Decision!.decision, 'defer');
	assert.equal(layer1Decision!.subject, 'snake_case-for-python');
});

test('never Y -> deferred to Layer 2', async () => {
	const c = createDefaultClassifier();
	const r = await c.classify({ turnId: 't2', text: 'never use hasattr in production code.' });
	assert.equal(r.accepted.length, 0);
	assert.equal(r.deferred.length, 1);
});

test('use X for Y -> deferred to Layer 2 with extracted hints', async () => {
	const c = createDefaultClassifier();
	const r = await c.classify({ turnId: 't3', text: 'use ruff for python linting.' });
	assert.equal(r.accepted.length, 0);
	assert.equal(r.deferred.length, 1);
	const layer1Decision = r.decisions.find(d => d.layer === 1);
	assert.equal(layer1Decision!.subject, 'ruff-for-python');
});

test('task-local language -> reject', async () => {
	const c = createDefaultClassifier();
	const r = await c.classify({ turnId: 't4', text: 'for this PR, never touch the auth module.' });
	assert.equal(r.accepted.length, 0);
	assert.equal(r.rejected.length, 1);
	assert.match(r.rejected[0]!.reason, /task-local/);
});

test('no assertion marker -> no spans detected', async () => {
	const c = createDefaultClassifier();
	const r = await c.classify({ turnId: 't5', text: 'I am writing tests today.' });
	assert.equal(r.accepted.length, 0);
	assert.equal(r.deferred.length, 0);
	assert.equal(r.rejected.length, 0);
	assert.equal(r.decisions.length, 0);
});

test('Layer 2 LLM hook: accept above threshold flows through', async () => {
	const llm: LlmClassifyHook = async (span) => ({
		kind: 'accept',
		payload: {
			text:         span,
			subject:      'llm-decided',
			polarity:     'preference',
			scope:        'workspace',
			targetOwners: ['skill:owner'],
			confidence:   0.9,
		},
	});
	const c = createDefaultClassifier({ llmClassify: llm });
	const r = await c.classify({ turnId: 't6', text: 'should not log api keys to console.' });
	// Layer 1 doesn't have a heuristic for "should not"; it defers.
	assert.equal(r.accepted.length, 1);
	assert.equal(r.accepted[0]!.subject, 'llm-decided');
});

test('Layer 2 accept below threshold escalates to Layer 3', async () => {
	const llm: LlmClassifyHook = async (span) => ({
		kind: 'accept',
		payload: {
			text:         span,
			subject:      'maybe',
			polarity:     'preference',
			scope:        'workspace',
			targetOwners: [],
			confidence:   0.4,  // below default 0.7 threshold
		},
	});

	const acceptedPayload: UserAssertionPayload = {
		text:         'user-confirmed',
		subject:      'maybe',
		polarity:     'preference',
		scope:        'workspace',
		targetOwners: [],
		confidence:   1.0,
	};
	const confirm: UserConfirmHook = async () => ({ kind: 'accept', payload: acceptedPayload });

	const c = createDefaultClassifier({ llmClassify: llm, userConfirm: confirm });
	const r = await c.classify({ turnId: 't7', text: 'should not log api keys.' });
	assert.equal(r.accepted.length, 1);
	assert.equal(r.accepted[0]!.text, 'user-confirmed');
});

test('Layer 2 reject flows to rejected', async () => {
	const llm: LlmClassifyHook = async () => ({ kind: 'reject', reason: 'llm-rejected' });
	const c = createDefaultClassifier({ llmClassify: llm });
	const r = await c.classify({ turnId: 't8', text: 'should not log api keys.' });
	assert.equal(r.rejected.length, 1);
	assert.equal(r.rejected[0]!.reason, 'llm-rejected');
});

test('default no-LLM classifier defers ambiguous spans', async () => {
	const c = createDefaultClassifier();
	const r = await c.classify({ turnId: 't9', text: 'should not log api keys.' });
	assert.equal(r.deferred.length, 1);
	assert.equal(r.accepted.length, 0);
});
