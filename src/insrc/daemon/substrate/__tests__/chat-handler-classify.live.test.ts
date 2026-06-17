/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * End-to-end live-LLM test for the chat-handler -> substrate.classifyAssertion ->
 * memory persistence path (memory-context M1.5).
 *
 * Drives the full daemon-side pipeline without spinning up the actual chat-handler
 * (it requires an open IPC socket); instead exercises the same call sequence
 * (init runtime -> register agent:chat owner -> classifyAssertion) against a
 * real local Ollama provider.
 *
 * Verifies:
 *   - Real preference utterance gets persisted as a `kind: 'constraint'` entry
 *     in `agent:chat/user-assertions/...`.
 *   - The persisted entry carries the closed-enum `PreferenceSubject` from G3.
 *   - The lookup in AssertionIndex routes the subject back to agent:chat.
 *
 * Run:
 *   npx tsx --test src/insrc/daemon/substrate/__tests__/chat-handler-classify.live.test.ts
 *
 * Skips cleanly when Ollama isn't reachable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OllamaProvider } from '../../../agent/providers/ollama.js';
import {
	_resetSubstrateRuntimeForTests,
	AGENT_CHAT_OWNER,
	initSubstrateRuntime,
	registerAgentChatOwner,
} from '../singleton.js';

const OLLAMA_HOST  = process.env.OLLAMA_HOST  ?? 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen3-coder:latest';


async function isOllamaReachable(): Promise<boolean> {
	try {
		const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
		return r.ok;
	} catch {
		return false;
	}
}


test('M1.5 live: "always include unit tests" -> persisted constraint at agent:chat', { timeout: 60_000 }, async (t) => {
	if (!await isOllamaReachable()) {
		t.skip(`Ollama not reachable at ${OLLAMA_HOST}; skipping`);
		return;
	}
	_resetSubstrateRuntimeForTests();
	const dir = mkdtempSync(join(tmpdir(), 'm1-5-live-'));
	try {
		const provider = new OllamaProvider(OLLAMA_MODEL, OLLAMA_HOST, 8192);
		const runtime = initSubstrateRuntime({
			localProvider: provider,
			workspaceId:   'live-test',
			rootDir:       dir,
		});
		registerAgentChatOwner(runtime);

		const result = await runtime.classifyAssertion({
			turnId: 'live-1',
			text:   'For this repo, always include unit tests in implementation plans.',
		});

		// At least one assertion should have been accepted + persisted to agent:chat.
		assert.ok(result.classification.accepted.length >= 1,
			`expected at least one accepted assertion, got ${result.classification.accepted.length}`);
		assert.ok(result.persisted.length >= 1,
			`expected at least one persisted entry, got ${result.persisted.length}`);
		const chatPersist = result.persisted.find(p => p.owner === AGENT_CHAT_OWNER);
		assert.ok(chatPersist !== undefined,
			`expected agent:chat in persisted owners; got: ${result.persisted.map(p => p.owner).join(', ')}`);

		// Read back the persisted entry from the substrate memory store.
		const ns = runtime.memory.scope(AGENT_CHAT_OWNER, 'user-assertions');
		const entry = await ns.get(chatPersist!.key);
		assert.ok(entry !== undefined, 'persisted entry not retrievable');
		assert.equal(entry!.kind, 'constraint', `expected kind=constraint, got ${entry!.kind}`);
		const value = entry!.value as { subject?: string; preferenceSubject?: string };
		// The LLM should pick test-policy under our taxonomy (with disambiguation in the prompt).
		const subject = value.preferenceSubject ?? value.subject;
		assert.equal(subject, 'test-policy', `expected test-policy, got ${subject}`);
	} finally {
		_resetSubstrateRuntimeForTests();
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* skip */ }
	}
});


test('M1.5 live: conversational filler does NOT persist', { timeout: 30_000 }, async (t) => {
	if (!await isOllamaReachable()) {
		t.skip(`Ollama not reachable; skipping`);
		return;
	}
	_resetSubstrateRuntimeForTests();
	const dir = mkdtempSync(join(tmpdir(), 'm1-5-live-'));
	try {
		const provider = new OllamaProvider(OLLAMA_MODEL, OLLAMA_HOST, 8192);
		const runtime = initSubstrateRuntime({
			localProvider: provider,
			workspaceId:   'live-test',
			rootDir:       dir,
		});
		registerAgentChatOwner(runtime);

		const result = await runtime.classifyAssertion({
			turnId: 'live-2',
			text:   'thanks for the help!',
		});

		// Conversational filler should produce no acceptance / persistence.
		assert.equal(result.classification.accepted.length, 0,
			'expected no accepted assertions for conversational filler');
		assert.equal(result.persisted.length, 0);
	} finally {
		_resetSubstrateRuntimeForTests();
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* skip */ }
	}
});


test('M1.5 live: clear imperative ("do not use hasattr") persists at agent:chat', { timeout: 60_000 }, async (t) => {
	// "do not" at sentence start hits Layer 1's IMPERATIVE_GENERAL fast-path
	// (confidence 0.8); Layer 2 isn't invoked so the persisted entry carries
	// the legacy `subject` field from Layer 1's heuristic extractor rather
	// than the closed-enum `preferenceSubject`. This test verifies the fast
	// path still persists -- it doesn't require the closed-enum subject
	// (see the "always include unit tests" test for the Layer 2 path).
	if (!await isOllamaReachable()) {
		t.skip(`Ollama not reachable; skipping`);
		return;
	}
	_resetSubstrateRuntimeForTests();
	const dir = mkdtempSync(join(tmpdir(), 'm1-5-live-'));
	try {
		const provider = new OllamaProvider(OLLAMA_MODEL, OLLAMA_HOST, 8192);
		const runtime = initSubstrateRuntime({
			localProvider: provider,
			workspaceId:   'live-test',
			rootDir:       dir,
		});
		registerAgentChatOwner(runtime);

		const result = await runtime.classifyAssertion({
			turnId: 'live-3',
			text:   'Do not use hasattr in Python code; prefer try/except.',
		});

		assert.ok(result.persisted.length >= 1,
			`expected at least one persisted entry, got ${result.persisted.length}`);
		const chatPersist = result.persisted.find(p => p.owner === AGENT_CHAT_OWNER);
		assert.ok(chatPersist !== undefined);

		const ns = runtime.memory.scope(AGENT_CHAT_OWNER, 'user-assertions');
		const entry = await ns.get(chatPersist!.key);
		assert.ok(entry !== undefined);
		assert.equal(entry!.kind, 'constraint');
		// Subject is either the closed-enum (Layer 2) or the heuristic
		// extraction (Layer 1). We accept either; what matters is persistence.
		const value = entry!.value as { subject?: string; preferenceSubject?: string };
		const subject = value.preferenceSubject ?? value.subject;
		assert.ok(typeof subject === 'string' && subject.length > 0, 'expected non-empty subject');
	} finally {
		_resetSubstrateRuntimeForTests();
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* skip */ }
	}
});
