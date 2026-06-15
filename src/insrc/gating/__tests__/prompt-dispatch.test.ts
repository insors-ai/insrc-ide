/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the cross-channel Mode B prompt dispatcher
 * (gating/prompt-dispatch.ts).
 *
 * The dispatcher is the bridge between hook-server (which queues
 * pending tool prompts) and the in-flight handoff stream (which
 * forwards them to the IDE as `mode-b-gate-request` HandoffEvents).
 *
 * Behaviour pinned:
 *   - publishPrompt fans out to every subscriber.
 *   - publishResolution fans out to every resolution subscriber.
 *   - Subscriber dispose removes it from the fan-out.
 *   - A subscriber that throws does not stop the dispatch loop
 *     (every other subscriber still gets the event).
 *   - A subscriber that disposes ITSELF during dispatch doesn't
 *     trip a live-iterator concurrent-modification bug.
 *   - hook-server end-to-end: a `prompt` verdict fires
 *     publishPrompt, then the eventual user resolution fires
 *     publishResolution with the same gateId.
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
	_resetForTest,
	publishPrompt,
	publishResolution,
	subscribePrompts,
	subscribeResolutions,
	type PromptDispatchPayload,
	type PromptResolvedPayload,
} from '../prompt-dispatch.js';
import { makeRequestPermissionHandler } from '../hook-server.js';
import type { PermissionsBlock } from '../../handoff/types.js';
import type { IpcStreamMessage } from '../../shared/types.js';

beforeEach(() => _resetForTest());

const SAMPLE_PROMPT: PromptDispatchPayload = {
	gateId:    'g-1',
	specId:    'spec-1',
	sessionId: 'sess-1',
	tool:      'Bash',
	input:     { command: 'rm -rf /tmp/x' },
};

test('publishPrompt fans out to every subscriber', () => {
	const seen1: PromptDispatchPayload[] = [];
	const seen2: PromptDispatchPayload[] = [];
	subscribePrompts(p => seen1.push(p));
	subscribePrompts(p => seen2.push(p));
	publishPrompt(SAMPLE_PROMPT);
	assert.equal(seen1.length, 1);
	assert.equal(seen2.length, 1);
	assert.deepStrictEqual(seen1[0], SAMPLE_PROMPT);
});

test('subscribePrompts: dispose removes the listener', () => {
	const seen: PromptDispatchPayload[] = [];
	const sub = subscribePrompts(p => seen.push(p));
	publishPrompt(SAMPLE_PROMPT);
	sub.dispose();
	publishPrompt({ ...SAMPLE_PROMPT, gateId: 'g-2' });
	assert.equal(seen.length, 1);
	assert.equal(seen[0]!.gateId, 'g-1');
});

test('a subscriber that throws does not block the rest of the fan-out', () => {
	const seen: string[] = [];
	subscribePrompts(() => { throw new Error('listener bomb'); });
	subscribePrompts(p => seen.push(p.gateId));
	publishPrompt(SAMPLE_PROMPT);
	assert.deepStrictEqual(seen, ['g-1']);
});

test('a subscriber that disposes itself mid-dispatch doesn\'t corrupt the iterator', () => {
	const seen: string[] = [];
	const subA = subscribePrompts(p => {
		seen.push(`A:${p.gateId}`);
		subA.dispose();
	});
	subscribePrompts(p => seen.push(`B:${p.gateId}`));
	publishPrompt(SAMPLE_PROMPT);
	// Both subscribers fired for the in-flight dispatch -- the
	// snapshot-then-iterate pattern means A's dispose doesn't drop
	// B from the live iteration.
	assert.deepStrictEqual(seen, ['A:g-1', 'B:g-1']);
	// Next dispatch only hits B; A is gone.
	publishPrompt({ ...SAMPLE_PROMPT, gateId: 'g-2' });
	assert.deepStrictEqual(seen, ['A:g-1', 'B:g-1', 'B:g-2']);
});

test('publishResolution fans out independently from publishPrompt', () => {
	const prompts: PromptDispatchPayload[] = [];
	const resolutions: PromptResolvedPayload[] = [];
	subscribePrompts(p => prompts.push(p));
	subscribeResolutions(r => resolutions.push(r));
	publishPrompt(SAMPLE_PROMPT);
	publishResolution({ gateId: 'g-1', specId: 'spec-1', verdict: 'allow', scope: 'once' });
	assert.equal(prompts.length, 1);
	assert.equal(resolutions.length, 1);
	assert.equal(resolutions[0]!.verdict, 'allow');
});

// -- end-to-end: hook-server publishes both events ----------------------------

test('hook-server: a "prompt" verdict publishes a prompt then a resolution with the same gateId', async () => {
	const policy: PermissionsBlock = {
		allow: [],
		prompt: [{ tool: 'Bash', commands: ['git push'] }],
		deny: [],
	};
	const recordedPrompts: PromptDispatchPayload[] = [];
	const recordedResolutions: PromptResolvedPayload[] = [];
	subscribePrompts(p => recordedPrompts.push(p));
	subscribeResolutions(r => recordedResolutions.push(r));

	let gateCounter = 0;
	const { handler, pendingPrompts } = makeRequestPermissionHandler({
		lookupSpec:    () => policy,
		nextGateId:    () => `g-${++gateCounter}`,
		promptTimeoutMs: 60_000,
	});

	const recorded: IpcStreamMessage[] = [];
	const send = (m: IpcStreamMessage): void => { recorded.push(m); };
	const controller = new AbortController();

	const handlerPromise = handler(
		{ specId: 'spec-1', sessionId: 'sess-1', tool: 'Bash', input: { command: 'git push origin main' } },
		send, controller.signal);

	// Settle on the next tick so the handler has time to register the prompt.
	await new Promise(r => setImmediate(r));

	assert.equal(recordedPrompts.length, 1, 'prompt fan-out should fire on prompt-verdict registration');
	assert.equal(recordedPrompts[0]!.gateId, 'g-1');
	assert.equal(recordedPrompts[0]!.tool,    'Bash');

	// Simulate the user clicking Allow.
	pendingPrompts.get('g-1')!.resolve({ verdict: 'allow', scope: 'once' });
	await handlerPromise;

	assert.equal(recordedResolutions.length, 1);
	assert.equal(recordedResolutions[0]!.gateId,  'g-1');
	assert.equal(recordedResolutions[0]!.verdict, 'allow');
	assert.equal(recordedResolutions[0]!.scope,   'once');
});

test('hook-server: timeout fires a deny resolution on the dispatcher', async () => {
	const policy: PermissionsBlock = {
		allow: [],
		prompt: [{ tool: 'Bash' }],
		deny: [],
	};
	const recordedResolutions: PromptResolvedPayload[] = [];
	subscribeResolutions(r => recordedResolutions.push(r));

	const { handler } = makeRequestPermissionHandler({
		lookupSpec:      () => policy,
		nextGateId:      () => 'g-timeout',
		promptTimeoutMs: 10,
	});

	const controller = new AbortController();
	await handler(
		{ specId: 'spec-1', sessionId: 'sess-1', tool: 'Bash', input: { command: 'whatever' } },
		() => {}, controller.signal,
	);

	assert.equal(recordedResolutions.length, 1);
	assert.equal(recordedResolutions[0]!.verdict, 'deny');
	assert.match(recordedResolutions[0]!.stopReason ?? '', /timeout/);
});

test('hook-server: an allow / deny verdict does NOT publish to the prompt dispatcher (only prompts do)', async () => {
	const policy: PermissionsBlock = {
		allow:  [{ tool: 'Read' }],
		prompt: [],
		deny:   [],
	};
	const prompts: PromptDispatchPayload[] = [];
	const resolutions: PromptResolvedPayload[] = [];
	subscribePrompts(p => prompts.push(p));
	subscribeResolutions(r => resolutions.push(r));

	const { handler } = makeRequestPermissionHandler({
		lookupSpec: () => policy,
		nextGateId: () => 'g-never-used',
	});

	const controller = new AbortController();
	await handler(
		{ specId: 'spec-1', sessionId: 'sess-1', tool: 'Read', input: { path: '/tmp/x' } },
		() => {}, controller.signal,
	);

	assert.equal(prompts.length, 0);
	assert.equal(resolutions.length, 0);
});
