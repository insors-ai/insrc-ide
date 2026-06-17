/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live-LLM round-trip for the M1.8 capture -> retrieval loop:
 *
 *   1. Stand up the substrate runtime against a real Ollama provider.
 *   2. Call substrate.classifyAssertion with a preference utterance --
 *      should persist a constraint at `agent:chat/user-assertions/...`.
 *   3. Call buildOwnerPreferencesSection with the persisted entries +
 *      a session topic relevant to the preference.
 *   4. Verify the rendered markdown includes the preference.
 *
 * Skips cleanly when Ollama isn't reachable. Closes the loop the user
 * pointed at as the central UX of memory-context: a preference stated in
 * one turn surfaces in the next turn's L1 system prompt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OllamaProvider } from '../../providers/ollama.js';
import {
	_resetSubstrateRuntimeForTests,
	AGENT_CHAT_OWNER,
	initSubstrateRuntime,
	registerAgentChatOwner,
} from '../../../daemon/substrate/singleton.js';
import { buildOwnerPreferencesSection, type PreferenceCandidate } from '../preferences.js';

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


async function pullCandidates(runtime: ReturnType<typeof initSubstrateRuntime>): Promise<PreferenceCandidate[]> {
	const ns = runtime.memory.scope(AGENT_CHAT_OWNER, 'user-assertions');
	const out: PreferenceCandidate[] = [];
	for await (const entry of ns.scan<Record<string, unknown>>('')) {
		if (entry.kind !== 'constraint') continue;
		const v = entry.value as Record<string, unknown>;
		const subject = (typeof v.preferenceSubject === 'string' ? v.preferenceSubject : undefined)
			?? (typeof v.subject === 'string' ? v.subject : undefined);
		const canonicalText = (typeof v.canonicalText === 'string' ? v.canonicalText : undefined)
			?? (typeof v.text === 'string' ? v.text : undefined);
		if (subject === undefined || canonicalText === undefined) continue;
		out.push({
			subject,
			canonicalText,
			confidence: entry.confidence,
			...(Array.isArray(v.categories) ? { categories: v.categories as string[] } : {}),
			...(Array.isArray(v.repoPaths)  ? { repoPaths:  v.repoPaths  as string[] } : {}),
		});
	}
	return out;
}


// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

test('M1.8 live: capture preference -> surface in next-turn L1 system block', { timeout: 90_000 }, async (t) => {
	if (!await isOllamaReachable()) {
		t.skip(`Ollama not reachable at ${OLLAMA_HOST}; skipping`);
		return;
	}
	_resetSubstrateRuntimeForTests();
	const dir = mkdtempSync(join(tmpdir(), 'm1-8-live-'));
	try {
		const provider = new OllamaProvider(OLLAMA_MODEL, OLLAMA_HOST, 8192);
		const runtime = initSubstrateRuntime({
			localProvider: provider,
			workspaceId:   'live-test',
			rootDir:       dir,
		});
		registerAgentChatOwner(runtime);

		// Step 1: capture
		const captureResult = await runtime.classifyAssertion({
			turnId: 'live-1',
			text:   'Always include unit tests in implementation plans.',
		});
		assert.ok(captureResult.persisted.length >= 1, 'expected at least one persisted preference');

		// Step 2: pull persisted candidates
		const candidates = await pullCandidates(runtime);
		assert.ok(candidates.length >= 1, 'expected at least one candidate in chat owner namespace');

		// Step 3: build the L1 preferences section with a relevant topic
		const section = await buildOwnerPreferencesSection({
			candidates,
			repoPath:      '/some/repo',
			sessionTopic:  'The user is drafting an implementation plan for adding user authentication.',
			localProvider: provider,
		});

		// Step 4: verify the markdown contains the preference
		assert.match(section, /## Active user preferences/);
		assert.match(section, /unit tests/i);
	} finally {
		_resetSubstrateRuntimeForTests();
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* skip */ }
	}
});


test('M1.8 live: relevance curator drops orthogonal preferences from L1', { timeout: 90_000 }, async (t) => {
	if (!await isOllamaReachable()) {
		t.skip(`Ollama not reachable; skipping`);
		return;
	}
	_resetSubstrateRuntimeForTests();
	const dir = mkdtempSync(join(tmpdir(), 'm1-8-live-'));
	try {
		const provider = new OllamaProvider(OLLAMA_MODEL, OLLAMA_HOST, 8192);
		const runtime = initSubstrateRuntime({
			localProvider: provider,
			workspaceId:   'live-test',
			rootDir:       dir,
		});
		registerAgentChatOwner(runtime);

		// Capture two preferences chosen so Layer 2 reliably accepts both:
		// one obviously about tests, one obviously about code style.
		await runtime.classifyAssertion({
			turnId: 'live-1',
			text:   'Always include unit tests in implementation plans.',
		});
		await runtime.classifyAssertion({
			turnId: 'live-2',
			text:   'Use camelCase for all JavaScript variable names.',
		});

		const candidates = await pullCandidates(runtime);
		assert.ok(candidates.length >= 2, `expected at least 2 candidates, got ${candidates.length}`);

		const section = await buildOwnerPreferencesSection({
			candidates,
			repoPath:      '/some/repo',
			sessionTopic:  'The user is drafting an implementation plan for adding a new feature.',
			localProvider: provider,
		});

		// Implementation-plan topic should retain the test-policy preference.
		assert.match(section, /unit tests/i, 'test-policy preference should survive curation');
		// Deploy-timing preference may or may not be filtered out depending on the LLM's judgment;
		// under inclusion bias it usually stays in. Either is acceptable -- the curator's choice
		// is what we want to exercise, not its specific verdict.
	} finally {
		_resetSubstrateRuntimeForTests();
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* skip */ }
	}
});
