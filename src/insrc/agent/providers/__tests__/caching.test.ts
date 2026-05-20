/**
 * Provider-side prompt-caching helpers.
 *
 * Each cloud + local provider gained caching support in the
 * `feat: prompt caching across all providers` change:
 *   - anthropic.ts -- explicit `cache_control: ephemeral` on system
 *   - ollama.ts    -- `keep_alive: '24h'` so KV cache survives
 *   - openai.ts    -- automatic, captures `cached_tokens` from response
 *
 * The cloud-side caching is hard to integration-test without hitting
 * the real API; here we cover the helper-level behaviour and the
 * shape that gets passed to each SDK.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	_buildSystemParamForTest,
	_extractUsageForTest,
} from '../anthropic.js';

// ---------------------------------------------------------------------------
// buildSystemParam (anthropic) -- cache_control marker wiring
// ---------------------------------------------------------------------------

test('anthropic.buildSystemParam: undefined system -> undefined', () => {
	assert.equal(_buildSystemParamForTest(undefined, true), undefined);
	assert.equal(_buildSystemParamForTest(undefined, false), undefined);
});

test('anthropic.buildSystemParam: empty string -> undefined (no caching of empty prompt)', () => {
	assert.equal(_buildSystemParamForTest('', true), undefined);
	assert.equal(_buildSystemParamForTest('', false), undefined);
});

test('anthropic.buildSystemParam: cacheSystem=true wraps system in cacheable text block', () => {
	const result = _buildSystemParamForTest('You are an analyzer.', true);
	assert.deepEqual(result, [{
		type: 'text',
		text: 'You are an analyzer.',
		cache_control: { type: 'ephemeral' },
	}]);
});

test('anthropic.buildSystemParam: cacheSystem=false falls back to plain string', () => {
	const result = _buildSystemParamForTest('You are an analyzer.', false);
	assert.equal(result, 'You are an analyzer.');
});

test('anthropic.buildSystemParam: large multi-paragraph system prompt still wrapped as a single cacheable block', () => {
	const big = 'a\n\n'.repeat(2000);
	const result = _buildSystemParamForTest(big, true);
	assert.ok(Array.isArray(result));
	assert.equal((result as Array<{ text: string }>).length, 1);
	assert.equal((result as Array<{ text: string }>)[0]!.text, big);
});

// ---------------------------------------------------------------------------
// extractUsage (anthropic) -- cache hit / write tokens surfaced
// ---------------------------------------------------------------------------

test('anthropic.extractUsage: cold cache -> read/creation are 0', () => {
	const u = _extractUsageForTest({
		input_tokens:                900,
		output_tokens:               120,
		cache_creation_input_tokens: null,
		cache_read_input_tokens:     null,
	} as unknown as Parameters<typeof _extractUsageForTest>[0]);
	assert.equal(u?.inputTokens, 900);
	assert.equal(u?.outputTokens, 120);
	assert.equal(u?.cacheReadTokens, 0);
	assert.equal(u?.cacheCreationTokens, 0);
});

test('anthropic.extractUsage: cache write -> creation populated, read 0', () => {
	const u = _extractUsageForTest({
		input_tokens:                100,
		output_tokens:               40,
		cache_creation_input_tokens: 1500,
		cache_read_input_tokens:     0,
	} as unknown as Parameters<typeof _extractUsageForTest>[0]);
	assert.equal(u?.cacheCreationTokens, 1500);
	assert.equal(u?.cacheReadTokens, 0);
});

test('anthropic.extractUsage: cache read -> read populated, creation 0', () => {
	const u = _extractUsageForTest({
		input_tokens:                100,   // uncached suffix (e.g. fresh user message)
		output_tokens:               80,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens:     1500,  // cached system prompt
	} as unknown as Parameters<typeof _extractUsageForTest>[0]);
	assert.equal(u?.cacheReadTokens, 1500);
	assert.equal(u?.cacheCreationTokens, 0);
});
