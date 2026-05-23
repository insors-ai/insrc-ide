/**
 * Tests for the OllamaProvider transient-error retry path.
 *
 * Run #N+1 of the code-analyzer aborted mid-section when Ollama's HTTP
 * stream ended without a final `done: true` chunk. The cost was high
 * (~30 minutes of progress lost on a single transient infra blip), so
 * the provider now retries stream-truncation errors once before
 * propagating. These tests pin the classifier (what counts as
 * transient) without standing up a real Ollama server.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isTransientOllamaError, _retryConstantsForTest } from '../ollama.js';

// ---------------------------------------------------------------------------
// Classifier -- transient (retry)
// ---------------------------------------------------------------------------

test('isTransientOllamaError: stream-truncation -> transient', () => {
	assert.equal(
		isTransientOllamaError(new Error('Did not receive done or success response in stream.')),
		true,
	);
});

test('isTransientOllamaError: ECONNRESET -> transient', () => {
	assert.equal(isTransientOllamaError(new Error('socket connection ECONNRESET')), true);
});

test('isTransientOllamaError: EPIPE -> transient', () => {
	assert.equal(isTransientOllamaError(new Error('write EPIPE')), true);
});

test('isTransientOllamaError: socket hang up -> transient', () => {
	assert.equal(isTransientOllamaError(new Error('socket hang up')), true);
});

test('isTransientOllamaError: aborted -> transient', () => {
	assert.equal(isTransientOllamaError(new Error('The operation was aborted')), true);
});

test('isTransientOllamaError: fetch failed -> transient', () => {
	assert.equal(isTransientOllamaError(new Error('fetch failed')), true);
});

test('isTransientOllamaError: undici other side closed -> transient', () => {
	assert.equal(isTransientOllamaError(new Error('other side closed')), true);
});

// ---------------------------------------------------------------------------
// Classifier -- structural (do NOT retry)
// ---------------------------------------------------------------------------

test('isTransientOllamaError: ECONNREFUSED -> structural (server down; do not retry)', () => {
	assert.equal(
		isTransientOllamaError(new Error('connect ECONNREFUSED 127.0.0.1:11434')),
		false,
	);
});

test('isTransientOllamaError: 404 / model not found -> structural', () => {
	assert.equal(isTransientOllamaError(new Error('model "missing" not found')), false);
	assert.equal(isTransientOllamaError(new Error('404 Not Found')), false);
});

test('isTransientOllamaError: 400 / bad request -> structural', () => {
	assert.equal(isTransientOllamaError(new Error('400 Bad Request: invalid format')), false);
});

test('isTransientOllamaError: arbitrary unrelated error -> structural (closed list)', () => {
	assert.equal(isTransientOllamaError(new Error('JSON parse error')), false);
	assert.equal(isTransientOllamaError(new Error('schema validation failed')), false);
});

test('isTransientOllamaError: non-Error value -> false (defensive)', () => {
	assert.equal(isTransientOllamaError('Did not receive done or success response in stream.'), false);
	assert.equal(isTransientOllamaError(null), false);
	assert.equal(isTransientOllamaError(undefined), false);
	assert.equal(isTransientOllamaError({ message: 'fetch failed' }), false);
});

// ---------------------------------------------------------------------------
// Retry budget shape
// ---------------------------------------------------------------------------

test('retry constants: MAX_TRANSIENT_RETRIES is 1 (one retry, not infinite)', () => {
	assert.equal(_retryConstantsForTest.MAX_TRANSIENT_RETRIES, 1);
});

test('retry constants: base delay >= 1s (avoid hammering Ollama on the retry)', () => {
	assert.ok(_retryConstantsForTest.TRANSIENT_RETRY_BASE_DELAY_MS >= 1000);
});
