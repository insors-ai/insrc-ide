/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InsrcHandoffServiceImpl } from '../../browser/handoff/handoffServiceImpl.js';
import type { HandoffEvent } from '../../common/handoffService.js';
import type { IInsrcChatService } from '../../common/chatService.js';

/**
 * Stub chat service that exposes the two members the handoff impl
 * uses (`activeSessionId`, `onDidChangeSession`). Everything else
 * throws -- if the impl ever starts depending on a new chat
 * surface, the test fails loud rather than silently masking it.
 */
function stubChatService(initialSessionId: string | undefined): {
	chatService: IInsrcChatService;
	flipSession: (id: string | undefined) => void;
	emitter: Emitter<string | undefined>;
} {
	const emitter = new Emitter<string | undefined>();
	let activeSessionId = initialSessionId;
	const chatService = new Proxy({}, {
		get(_target, prop): unknown {
			if (prop === 'activeSessionId') {
				return activeSessionId;
			}
			if (prop === 'onDidChangeSession') {
				return emitter.event as Event<string | undefined>;
			}
			// Trip the test if the impl reaches for anything else.
			throw new Error(`stubChatService: unexpected access to '${String(prop)}'`);
		},
	}) as IInsrcChatService;
	return {
		chatService,
		emitter,
		flipSession: (id: string | undefined) => {
			activeSessionId = id;
			emitter.fire(id);
		},
	};
}

suite('InsrcHandoffServiceImpl', () => {

	const testDisposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('happy path: spec-assembling -> ... -> handoff-final promotes pending id and aggregates state', () => {
		const stub = stubChatService('session-1');
		testDisposables.add(stub.emitter);
		const svc = testDisposables.add(new InsrcHandoffServiceImpl(stub.chatService, new NullLogService()));

		const events: HandoffEvent[] = [
			{ kind: 'spec-assembling', intent: 'fix the flaky test', templateId: 'DEBUG-SESSION' },
			{ kind: 'spec-ready', specId: 'spec-1', templateId: 'DEBUG-SESSION', preview: '# Debug Session: fix...' },
			{ kind: 'worktree-created', specId: 'spec-1', worktreePath: '/tmp/wt', ref: 'HEAD' },
			{ kind: 'spawned', specId: 'spec-1', agent: 'claude-code' },
			{ kind: 'agent-completed', specId: 'spec-1', exitCode: 0, durationMs: 1234, stdoutLen: 500 },
			{ kind: 'auditing', specId: 'spec-1' },
			{ kind: 'audit-ready', specId: 'spec-1', verdict: 'accept', reason: 'all checks passed', editHintCount: 0, machineCheckCount: 2, diffBytes: 480 },
			{ kind: 'handoff-final', specId: 'spec-1', verdict: 'accept', diff: 'diff --git a/x b/x', worktreePath: '/tmp/wt' },
		];

		const finalized: string[] = [];
		testDisposables.add(svc.onDidFinalize(s => finalized.push(s.specId)));

		for (const e of events) {
			assert.strictEqual(svc.dispatch(e), true, `dispatch returned false for ${e.kind}`);
		}

		// Pending entry was promoted into the canonical specId entry.
		assert.strictEqual(svc.sessions.size, 1);
		const state = svc.sessions.get('spec-1');
		assert.ok(state !== undefined, 'spec-1 should be in the sessions map');
		assert.strictEqual(state.intent, 'fix the flaky test');
		assert.strictEqual(state.templateId, 'DEBUG-SESSION');
		assert.strictEqual(state.stage, 'final');
		assert.strictEqual(state.worktreePath, '/tmp/wt');
		assert.strictEqual(state.agent, 'claude-code');
		assert.strictEqual(state.exitCode, 0);
		assert.strictEqual(state.durationMs, 1234);
		assert.strictEqual(state.verdict, 'accept');
		assert.strictEqual(state.auditReason, 'all checks passed');
		assert.strictEqual(state.machineCheckCount, 2);
		assert.ok(state.diff !== undefined && state.diff.length > 0);

		// Pending placeholder was dropped; the only remaining entry is
		// the canonical specId entry.
		for (const key of svc.sessions.keys()) {
			assert.ok(!key.startsWith('pending:'), `expected pending placeholder to be dropped, got ${key}`);
		}

		// onDidFinalize fired exactly once with the matching specId.
		assert.deepStrictEqual(finalized, ['spec-1']);
	});

	test('handoff-error against an in-flight session lands as terminal error stage', () => {
		const stub = stubChatService('session-1');
		testDisposables.add(stub.emitter);
		const svc = testDisposables.add(new InsrcHandoffServiceImpl(stub.chatService, new NullLogService()));

		svc.dispatch({ kind: 'spec-assembling', intent: 'investigate', templateId: 'DEBUG-SESSION' });
		svc.dispatch({ kind: 'spec-ready', specId: 'spec-err', templateId: 'DEBUG-SESSION', preview: '...' });
		svc.dispatch({ kind: 'spawned', specId: 'spec-err', agent: 'codex' });
		assert.strictEqual(svc.sessions.get('spec-err')?.stage, 'spawned');

		svc.dispatch({ kind: 'handoff-error', stage: 'audit', message: 'audit failed' });
		const state = svc.sessions.get('spec-err');
		assert.ok(state !== undefined);
		assert.strictEqual(state.stage, 'error');
		assert.strictEqual(state.errorStage, 'audit');
		assert.strictEqual(state.errorMessage, 'audit failed');

		// Further events are rejected once terminal.
		assert.strictEqual(svc.dispatch({ kind: 'audit-ready', specId: 'spec-err', verdict: 'accept', reason: 'r', editHintCount: 0, machineCheckCount: 1, diffBytes: 0 }), false);
		assert.strictEqual(svc.sessions.get('spec-err')?.stage, 'error');
	});

	test('chat session flip clears the cache and emits remove events', () => {
		const stub = stubChatService('session-A');
		testDisposables.add(stub.emitter);
		const svc = testDisposables.add(new InsrcHandoffServiceImpl(stub.chatService, new NullLogService()));

		svc.dispatch({ kind: 'spec-assembling', intent: 'foo', templateId: 'DEBUG-SESSION' });
		svc.dispatch({ kind: 'spec-ready', specId: 'spec-A', templateId: 'DEBUG-SESSION', preview: 'p' });
		assert.strictEqual(svc.sessions.size, 1);

		const removed: string[] = [];
		testDisposables.add(svc.onDidRemoveSession(id => removed.push(id)));

		stub.flipSession('session-B');

		assert.strictEqual(svc.sessions.size, 0);
		assert.deepStrictEqual(removed, ['spec-A']);
	});

	test('clear(specId) drops just that entry and fires remove + change', () => {
		const stub = stubChatService('s');
		testDisposables.add(stub.emitter);
		const svc = testDisposables.add(new InsrcHandoffServiceImpl(stub.chatService, new NullLogService()));

		svc.dispatch({ kind: 'spec-assembling', intent: 'a', templateId: 'DEBUG-SESSION' });
		svc.dispatch({ kind: 'spec-ready', specId: 'spec-x', templateId: 'DEBUG-SESSION', preview: 'p' });

		let changes = 0;
		const removed: string[] = [];
		testDisposables.add(svc.onDidChange(() => { changes++; }));
		testDisposables.add(svc.onDidRemoveSession(id => removed.push(id)));

		svc.clear('spec-x');

		assert.strictEqual(svc.sessions.has('spec-x'), false);
		assert.deepStrictEqual(removed, ['spec-x']);
		assert.strictEqual(changes, 1);

		// Idempotent: clearing the same id again is a no-op.
		svc.clear('spec-x');
		assert.deepStrictEqual(removed, ['spec-x']);
		assert.strictEqual(changes, 1);
	});

	test('events for an unknown specId are rejected (no implicit allocation)', () => {
		const stub = stubChatService('s');
		testDisposables.add(stub.emitter);
		const svc = testDisposables.add(new InsrcHandoffServiceImpl(stub.chatService, new NullLogService()));

		// No prior spec-assembling / spec-ready -- mid-pipeline event must drop.
		const ok = svc.dispatch({ kind: 'spawned', specId: 'never-seen', agent: 'codex' });
		assert.strictEqual(ok, false);
		assert.strictEqual(svc.sessions.size, 0);
	});
});
