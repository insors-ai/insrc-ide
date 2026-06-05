/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Verifies the `disableThinking` gate on the Ollama provider.
 *
 * Background: qwen3.6 and other thinking-capable qwen models emit hidden
 * `<think>...</think>` tokens that consume the output budget. The provider
 * already suppresses thinking on qwen for tool-loop calls (because
 * structured tool calls don't benefit from thinking and the latency hit
 * per turn is material). This test pins the extended trigger: tool-less
 * callers that explicitly opt in via `CompletionOpts.disableThinking`
 * also get thinking suppressed.
 *
 * If this gate is gone, qwen3.x tool-less JSON callers (e.g. memory shaping)
 * silently emit empty bodies -- the failure mode we hit in the offline
 * experiment and documented in the auto-memory note
 * `qwen3_6_needs_think_false`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	_shouldDisableThinkingForTest as shouldDisableThinking,
	_modelQuirksForTest          as modelQuirks,
} from '../ollama.js';

// ---------------------------------------------------------------------------
// Model-family quirk detection -- prerequisite for the gate
// ---------------------------------------------------------------------------

test('modelQuirks: qwen3.6 detected as qwen family with noThinkOnTools=true', () => {
	const q = modelQuirks('qwen3.6:35b-a3b');
	assert.equal(q.family, 'qwen');
	assert.equal(q.noThinkOnTools, true);
});

test('modelQuirks: qwen3-coder detected as qwen family with noThinkOnTools=true', () => {
	const q = modelQuirks('qwen3-coder:latest');
	assert.equal(q.family, 'qwen');
	assert.equal(q.noThinkOnTools, true);
});

test('modelQuirks: devstral-small-2 detected as mistral family with noThinkOnTools=false', () => {
	const q = modelQuirks('devstral-small-2:latest');
	assert.equal(q.family, 'mistral');
	assert.equal(q.noThinkOnTools, false);
});

// ---------------------------------------------------------------------------
// shouldDisableThinking -- the gate itself
// ---------------------------------------------------------------------------

const QWEN = modelQuirks('qwen3.6:35b-a3b');
const DEVSTRAL = modelQuirks('devstral-small-2:latest');

test('qwen + no tools + no opt -> no suppression (legacy behavior)', () => {
	assert.equal(shouldDisableThinking(QWEN, false, undefined), false);
});

test('qwen + tools -> suppression (legacy tool-loop behavior)', () => {
	assert.equal(shouldDisableThinking(QWEN, true, undefined), true);
});

test('qwen + no tools + disableThinking=true -> suppression (the new path)', () => {
	assert.equal(shouldDisableThinking(QWEN, false, true), true);
});

test('qwen + tools + disableThinking=true -> suppression (redundant true is fine)', () => {
	assert.equal(shouldDisableThinking(QWEN, true, true), true);
});

test('qwen + no tools + disableThinking=false -> no suppression (explicit opt-out)', () => {
	assert.equal(shouldDisableThinking(QWEN, false, false), false);
});

test('mistral family is unaffected: tools alone -> no suppression', () => {
	assert.equal(shouldDisableThinking(DEVSTRAL, true, undefined), false);
});

test('mistral family is unaffected: disableThinking=true is a no-op', () => {
	// The structured `think` field is harmless on non-thinking models, but
	// the helper still returns false so the provider doesn't waste the
	// /no_think prefix slot on a family that doesn't honor it.
	assert.equal(shouldDisableThinking(DEVSTRAL, false, true), false);
	assert.equal(shouldDisableThinking(DEVSTRAL, true, true), false);
});
