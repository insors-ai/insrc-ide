/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * gate.request-permission + gate.resolve tests.
 *
 * Drives the stream handlers directly with an injected `send`,
 * AbortSignal, and a synthetic spec-policy lookup. No actual hook
 * binary or daemon socket needed -- those land in Day 3's
 * integration test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	makeRequestPermissionHandler,
	makeGateResolveHandler,
	type PendingPrompt,
} from '../hook-server.js';
import type { IpcStreamMessage } from '../../shared/types.js';
import type { PermissionsBlock } from '../../handoff/types.js';

function collect(): { recorded: IpcStreamMessage[]; send: (m: IpcStreamMessage) => void } {
	const recorded: IpcStreamMessage[] = [];
	return { recorded, send: m => { recorded.push(m); } };
}

function fixedGateIdGen(): () => string {
	let n = 0;
	return () => `gate-test-${++n}`;
}

const POLICY_PERMISSIVE: PermissionsBlock = {
	allow:  [{ tool: 'Edit', paths: ['src/**'] }],
	prompt: [{ tool: 'Bash', commands: ['git push'] }],
	deny:   [{ tool: 'WebFetch' }],
};

// ---------------------------------------------------------------------------
// Synchronous verdicts (allow / deny short-circuit before the prompt path)
// ---------------------------------------------------------------------------

test("gate.request-permission: allow verdict -> stream 'progress' then 'done'; no prompt registered", async () => {
	const pending = new Map<string, PendingPrompt>();
	const { handler } = makeRequestPermissionHandler({
		lookupSpec:     () => POLICY_PERMISSIVE,
		pendingPrompts: pending,
		nextGateId:     fixedGateIdGen(),
	});
	const { recorded, send } = collect();
	const controller = new AbortController();
	await handler(
		{ specId: 'spec-1', tool: 'Edit', input: { file_path: 'src/foo.ts' }, sessionId: 'sess-1' },
		send, controller.signal,
	);
	assert.equal(recorded.length, 2);
	assert.equal(recorded[0]!.stream, 'progress');
	assert.deepEqual(recorded[0]!.data, { verdict: 'allow' });
	assert.equal(recorded[1]!.stream, 'done');
	assert.equal(pending.size, 0);
});

test("gate.request-permission: deny verdict -> stream 'progress' then 'done'; no prompt registered", async () => {
	const pending = new Map<string, PendingPrompt>();
	const { handler } = makeRequestPermissionHandler({
		lookupSpec:     () => POLICY_PERMISSIVE,
		pendingPrompts: pending,
		nextGateId:     fixedGateIdGen(),
	});
	const { recorded, send } = collect();
	const controller = new AbortController();
	await handler(
		{ specId: 'spec-1', tool: 'WebFetch', input: { url: 'https://x' }, sessionId: 'sess-1' },
		send, controller.signal,
	);
	assert.equal(recorded.length, 2);
	assert.deepEqual(recorded[0]!.data, { verdict: 'deny' });
	assert.equal(recorded[1]!.stream, 'done');
	assert.equal(pending.size, 0);
});

// ---------------------------------------------------------------------------
// Unknown spec
// ---------------------------------------------------------------------------

test("gate.request-permission: unknown specId -> stream 'progress' deny with reason then 'done'", async () => {
	const { handler } = makeRequestPermissionHandler({
		lookupSpec: () => undefined,
		nextGateId: fixedGateIdGen(),
	});
	const { recorded, send } = collect();
	await handler(
		{ specId: 'spec-missing', tool: 'Edit', input: {}, sessionId: 's' },
		send, new AbortController().signal,
	);
	assert.equal(recorded.length, 2);
	const data = recorded[0]!.data as { verdict: string; reason: string };
	assert.equal(data.verdict, 'deny');
	assert.match(data.reason, /spec-missing/);
});

// ---------------------------------------------------------------------------
// Prompt path: emits 'gate', awaits resolve, then 'progress' + 'done'
// ---------------------------------------------------------------------------

test('gate.request-permission: prompt verdict registers a PendingPrompt with the gateId from nextGateId', async () => {
	const pending = new Map<string, PendingPrompt>();
	const { handler } = makeRequestPermissionHandler({
		lookupSpec:     () => POLICY_PERMISSIVE,
		pendingPrompts: pending,
		nextGateId:     fixedGateIdGen(),
		// Long timeout so the prompt stays parked while we inspect.
		promptTimeoutMs: 60_000,
	});
	const { recorded, send } = collect();
	const controller = new AbortController();

	// Don't await -- the prompt path blocks until resolved.
	const inFlight = handler(
		{ specId: 'spec-1', tool: 'Bash', input: { command: 'git push origin main' }, sessionId: 'sess-1' },
		send, controller.signal,
	);

	// Spin until the 'gate' message lands.
	while (recorded.length === 0) await new Promise(r => setTimeout(r, 5));

	assert.equal(recorded[0]!.stream, 'gate');
	const gateData = recorded[0]!.data as { gateId: string; tool: string; sessionId: string };
	assert.equal(gateData.gateId,    'gate-test-1');
	assert.equal(gateData.tool,      'Bash');
	assert.equal(gateData.sessionId, 'sess-1');

	// The pending registry has the gate.
	assert.equal(pending.size, 1);
	assert.equal(pending.get('gate-test-1')?.tool, 'Bash');

	// Resolve via the registry seam (simulating gate.resolve from IDE).
	pending.get('gate-test-1')!.resolve({ verdict: 'allow' });
	await inFlight;

	assert.equal(recorded.length, 3);
	assert.equal(recorded[1]!.stream, 'progress');
	assert.deepEqual(recorded[1]!.data, { verdict: 'allow' });
	assert.equal(recorded[2]!.stream, 'done');
	assert.equal(pending.size, 0);
});

// ---------------------------------------------------------------------------
// Timeout: default-deny when the user doesn't respond
// ---------------------------------------------------------------------------

test("gate.request-permission: prompt timeout -> 'progress' deny with stopReason; pending cleared", async () => {
	const pending = new Map<string, PendingPrompt>();
	const { handler } = makeRequestPermissionHandler({
		lookupSpec:      () => POLICY_PERMISSIVE,
		pendingPrompts:  pending,
		nextGateId:      fixedGateIdGen(),
		promptTimeoutMs: 50,
	});
	const { recorded, send } = collect();
	await handler(
		{ specId: 'spec-1', tool: 'Bash', input: { command: 'git push origin main' }, sessionId: 'sess-1' },
		send, new AbortController().signal,
	);
	const progress = recorded.find(m => m.stream === 'progress');
	assert.ok(progress !== undefined);
	const data = progress.data as { verdict: string; stopReason: string };
	assert.equal(data.verdict, 'deny');
	assert.match(data.stopReason, /timeout/);
	assert.equal(pending.size, 0);
});

// ---------------------------------------------------------------------------
// Abort: socket close while a prompt is pending
// ---------------------------------------------------------------------------

test("gate.request-permission: signal abort while waiting -> 'progress' deny with stopReason 'gate cancelled'", async () => {
	const pending = new Map<string, PendingPrompt>();
	const { handler } = makeRequestPermissionHandler({
		lookupSpec:      () => POLICY_PERMISSIVE,
		pendingPrompts:  pending,
		nextGateId:      fixedGateIdGen(),
		promptTimeoutMs: 60_000,
	});
	const { recorded, send } = collect();
	const controller = new AbortController();
	const inFlight = handler(
		{ specId: 'spec-1', tool: 'Bash', input: { command: 'git push' }, sessionId: 'sess-1' },
		send, controller.signal,
	);
	while (recorded.length === 0) await new Promise(r => setTimeout(r, 5));
	controller.abort();
	await inFlight;
	const progress = recorded.find(m => m.stream === 'progress');
	const data = progress?.data as { verdict: string; stopReason: string };
	assert.equal(data.verdict, 'deny');
	assert.match(data.stopReason, /cancelled/);
});

// ---------------------------------------------------------------------------
// makeGateResolveHandler -- the IDE-facing resolver
// ---------------------------------------------------------------------------

test('gate.resolve: known gateId -> { resolved: true }; pending callback fires', async () => {
	const pending = new Map<string, PendingPrompt>();
	let callbackArg: { verdict: string; scope?: string } | undefined;
	pending.set('gate-x', {
		gateId: 'gate-x', specId: 'spec-1', tool: 'Bash',
		input: { command: 'git push' }, sessionId: 'sess-1',
		createdAt: Date.now(),
		resolve: r => { callbackArg = { verdict: r.verdict, ...(r.scope ? { scope: r.scope } : {}) }; },
	});
	const resolve = makeGateResolveHandler(pending);
	const out = await resolve({ gateId: 'gate-x', verdict: 'allow', scope: 'session' });
	assert.deepEqual(out, { resolved: true });
	assert.deepEqual(callbackArg, { verdict: 'allow', scope: 'session' });
});

test('gate.resolve: unknown gateId -> { resolved: false }; no callback fires', async () => {
	const pending = new Map<string, PendingPrompt>();
	const resolve = makeGateResolveHandler(pending);
	const out = await resolve({ gateId: 'nope', verdict: 'deny' });
	assert.deepEqual(out, { resolved: false });
});

// ---------------------------------------------------------------------------
// Custom evaluator + lookup -- exercises the test seam end-to-end
// ---------------------------------------------------------------------------

test('gate.request-permission: custom evaluator drives the verdict (test seam)', async () => {
	const { handler } = makeRequestPermissionHandler({
		lookupSpec: () => POLICY_PERMISSIVE,
		evaluate:   () => 'allow',
		nextGateId: fixedGateIdGen(),
	});
	const { recorded, send } = collect();
	// Even WebFetch (which would normally be deny) goes through as allow.
	await handler(
		{ specId: 'spec-1', tool: 'WebFetch', input: { url: 'https://x' }, sessionId: 'sess-1' },
		send, new AbortController().signal,
	);
	assert.deepEqual(recorded[0]!.data, { verdict: 'allow' });
});
