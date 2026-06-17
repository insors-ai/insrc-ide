/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live-LLM end-to-end test for the Ollama-backed Layer 2 hook. Hits a real Ollama
 * instance (default model: `qwen3-coder:latest`; override via
 * `OLLAMA_MODEL=<model> npx tsx --test ...`). Exercises:
 *
 *   - Acceptance of a clear preference shape ("always include unit tests")
 *   - Subject classification into the closed PreferenceSubject enum
 *   - Rejection of conversational filler
 *   - Defer / low confidence on ambiguous shapes
 *
 * Run:
 *   npx tsx --test src/insrc/daemon/substrate/__tests__/ollama-hook.live.test.ts
 *
 * The tests skip cleanly if Ollama isn't reachable -- no daemon needed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OllamaProvider } from '../../../agent/providers/ollama.js';
import { createOllamaLayer2Hook } from '../classifier/ollama-hook.js';
import { PREFERENCE_SUBJECTS } from '../taxonomy/preference-subjects.js';

const OLLAMA_HOST  = process.env.OLLAMA_HOST  ?? 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen3-coder:latest';

async function isOllamaReachable(): Promise<boolean> {
	try {
		const r = await fetch(`${OLLAMA_HOST}/api/tags`, {
			signal: AbortSignal.timeout(2000),
		});
		return r.ok;
	} catch {
		return false;
	}
}

function makeHook() {
	const provider = new OllamaProvider(OLLAMA_MODEL, OLLAMA_HOST, 8192);
	return createOllamaLayer2Hook({ provider });
}


// ---------------------------------------------------------------------------
// Acceptance tests
// ---------------------------------------------------------------------------

test('live: "always include unit tests" -> accept + test-policy subject', { timeout: 30_000 }, async (t) => {
	if (!await isOllamaReachable()) {
		t.skip(`Ollama not reachable at ${OLLAMA_HOST}; skipping live test`);
		return;
	}
	const hook = makeHook();
	const result = await hook(
		'For this repo, always include unit tests in implementation plans.',
		{ turnId: 'live-1', layer1: 'defer' },
	);
	assert.equal(result.kind, 'accept', `expected accept, got ${result.kind}: ${'reason' in result ? result.reason : ''}`);
	if (result.kind !== 'accept') return;
	assert.equal(result.payload.preferenceSubject, 'test-policy',
		`expected subject=test-policy, got ${String(result.payload.preferenceSubject)}`);
	assert.ok((result.payload.canonicalText ?? '').length > 0, 'expected non-empty canonicalText');
	assert.ok(result.payload.confidence >= 0.7,
		`expected confidence >= 0.7, got ${result.payload.confidence}`);
});

test('live: "always sign commits" -> accept + commit-policy subject', { timeout: 30_000 }, async (t) => {
	if (!await isOllamaReachable()) {
		t.skip(`Ollama not reachable; skipping`);
		return;
	}
	const hook = makeHook();
	const result = await hook(
		'I want every commit to be signed with my GPG key.',
		{ turnId: 'live-2', layer1: 'defer' },
	);
	assert.equal(result.kind, 'accept');
	if (result.kind !== 'accept') return;
	assert.equal(result.payload.preferenceSubject, 'commit-policy');
});

test('live: "do not use hasattr in python" -> accept + code-style subject', { timeout: 30_000 }, async (t) => {
	if (!await isOllamaReachable()) {
		t.skip(`Ollama not reachable; skipping`);
		return;
	}
	const hook = makeHook();
	const result = await hook(
		'Do not use hasattr in Python code; prefer try/except.',
		{ turnId: 'live-3', layer1: 'defer' },
	);
	assert.equal(result.kind, 'accept');
	if (result.kind !== 'accept') return;
	assert.equal(result.payload.preferenceSubject, 'code-style');
});


// ---------------------------------------------------------------------------
// Rejection / defer
// ---------------------------------------------------------------------------

test('live: conversational filler -> reject', { timeout: 30_000 }, async (t) => {
	if (!await isOllamaReachable()) {
		t.skip(`Ollama not reachable; skipping`);
		return;
	}
	const hook = makeHook();
	const result = await hook(
		'thanks!',
		{ turnId: 'live-4', layer1: 'defer' },
	);
	// Some models may defer instead of strictly rejecting; both are acceptable.
	assert.ok(result.kind === 'reject' || result.kind === 'defer',
		`expected reject or defer, got ${result.kind}`);
});

test('live: tactical statement -> reject', { timeout: 30_000 }, async (t) => {
	if (!await isOllamaReachable()) {
		t.skip(`Ollama not reachable; skipping`);
		return;
	}
	const hook = makeHook();
	const result = await hook(
		"I'm going to refactor this file next.",
		{ turnId: 'live-5', layer1: 'defer' },
	);
	assert.ok(result.kind === 'reject' || result.kind === 'defer');
});


// ---------------------------------------------------------------------------
// Schema constraint actually flows through
// ---------------------------------------------------------------------------

test('live: subject (when emitted) is always in the PreferenceSubject enum', { timeout: 30_000 }, async (t) => {
	if (!await isOllamaReachable()) {
		t.skip(`Ollama not reachable; skipping`);
		return;
	}
	const hook = makeHook();
	const result = await hook(
		'Documentation should always include a usage example.',
		{ turnId: 'live-6', layer1: 'defer' },
	);
	// If accepted, subject must be in the enum (the schema constraint enforces this).
	if (result.kind === 'accept' && result.payload.preferenceSubject !== undefined) {
		assert.ok((PREFERENCE_SUBJECTS as readonly string[]).includes(result.payload.preferenceSubject),
			`emitted subject "${result.payload.preferenceSubject}" not in enum`);
	}
});
