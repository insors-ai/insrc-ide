/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Substrate runtime singleton tests. Confirms the daemon-wide instance pattern,
 * the `agent:chat` owner registration with broad assertion interest, and
 * idempotency (re-init replaces).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import {
	_resetSubstrateRuntimeForTests,
	AGENT_CHAT_OWNER,
	getSubstrateRuntime,
	hasSubstrateRuntime,
	initSubstrateRuntime,
	registerAgentChatOwner,
} from '../singleton.js';
import { PREFERENCE_SUBJECTS } from '../taxonomy/preference-subjects.js';


function fakeLocalProvider(): LLMProvider {
	return {
		async complete(_msgs: LLMMessage[]): Promise<LLMResponse> {
			return {
				text: JSON.stringify({ verdict: 'defer', confidence: 0.3, rationale: 'fake' }),
				stopReason: 'end_turn',
			};
		},
		stream() { return (async function* () { yield ''; })(); },
		async embed() { return []; },
	};
}


function withTmpDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> | T {
	const dir = mkdtempSync(join(tmpdir(), 'subst-singleton-'));
	const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* skip */ } };
	try {
		const result = fn(dir);
		if (result instanceof Promise) {
			return result.finally(cleanup);
		}
		cleanup();
		return result;
	} catch (err) {
		cleanup();
		throw err;
	}
}


test('singleton: getSubstrateRuntime throws before init', () => {
	_resetSubstrateRuntimeForTests();
	assert.equal(hasSubstrateRuntime(), false);
	assert.throws(() => getSubstrateRuntime(), /not initialised/);
});

test('singleton: initSubstrateRuntime creates runtime + getSubstrateRuntime returns it', async () => {
	_resetSubstrateRuntimeForTests();
	await withTmpDir(async (dir) => {
		const runtime = initSubstrateRuntime({
			localProvider: fakeLocalProvider(),
			workspaceId:   'test-ws',
			rootDir:       dir,
		});
		assert.equal(hasSubstrateRuntime(), true);
		assert.equal(getSubstrateRuntime(), runtime);
	});
});

test('singleton: registerAgentChatOwner adds all PreferenceSubjects to assertion index', async () => {
	_resetSubstrateRuntimeForTests();
	await withTmpDir(async (dir) => {
		const runtime = initSubstrateRuntime({
			localProvider: fakeLocalProvider(),
			workspaceId:   'test-ws',
			rootDir:       dir,
		});
		registerAgentChatOwner(runtime);
		// Verify the agent:chat owner is reachable through the index for every subject.
		for (const subject of PREFERENCE_SUBJECTS) {
			const matches = runtime.assertionIndex.lookup(subject);
			const chatMatch = matches.find(m => m.owner === AGENT_CHAT_OWNER);
			assert.ok(chatMatch !== undefined, `expected agent:chat in lookup('${subject}')`);
		}
	});
});

test('singleton: re-init replaces the prior instance', async () => {
	_resetSubstrateRuntimeForTests();
	await withTmpDir(async (dir) => {
		const first = initSubstrateRuntime({
			localProvider: fakeLocalProvider(),
			workspaceId:   'test-ws',
			rootDir:       dir,
		});
		const second = initSubstrateRuntime({
			localProvider: fakeLocalProvider(),
			workspaceId:   'test-ws',
			rootDir:       dir,
		});
		assert.notEqual(first, second);
		assert.equal(getSubstrateRuntime(), second);
	});
});
