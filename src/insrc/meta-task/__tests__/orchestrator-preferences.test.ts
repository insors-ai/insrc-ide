/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the orchestrator's M2.5 auto-injection of a `preferences` slot.
 *
 * Pins the contract:
 *   - When the cloud declares 'sufficient', preferences are still fetched
 *     and surfaced in the phase-2 prompt as an "Auto-injected" section.
 *   - When the cloud asks for 'context-needed', the preferences slot is
 *     prepended to the requested set (and the local-LLM curation runs).
 *   - The cloud's original kind is preserved in the phase-2 prompt
 *     ("you declared sufficiency" stays accurate).
 *   - When no preferences are seeded, the auto-injection produces an
 *     'empty' chunk -- the prompt skips the "Auto-injected" section.
 *
 * Uses a recording cloud provider so we can inspect the phase-2 prompt
 * the orchestrator sends after fulfilling phase 1.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMMessage, LLMProvider, LLMResponse } from '../../shared/types.js';
import { runMetaTask } from '../orchestrator.js';
import { MetaTaskEmitter, type OutboundMessage } from '../event-emitter.js';
import { PATHS } from '../../shared/paths.js';
import {
	_resetSubstrateRuntimeForTests,
	getSubstrateRuntime,
	initSubstrateRuntime,
} from '../../daemon/substrate/singleton.js';

// Bootstrap the template registry so `/review` is discoverable.
import '../templates/index.js';


// ---------------------------------------------------------------------------
// Helpers (scaled-down copies of orchestrator.test.ts patterns)
// ---------------------------------------------------------------------------

interface RecordedCall { messages: LLMMessage[]; opts: unknown }
interface RecordingCloud extends LLMProvider { calls: RecordedCall[] }

function recordingCloud(responses: readonly string[]): RecordingCloud {
	let idx = 0;
	const calls: RecordedCall[] = [];
	return {
		calls,
		async complete(messages: unknown, opts: unknown): Promise<LLMResponse> {
			calls.push({ messages: messages as LLMMessage[], opts });
			const text = responses[idx++] ?? '';
			return { text, stopReason: 'end_turn' };
		},
		stream() { return (async function* () { yield ''; })(); },
		async embed() { return []; },
	};
}

function noopProvider(): LLMProvider {
	return {
		async complete() { throw new Error('noopProvider.complete: should not be invoked'); },
		stream() { return (async function* () { yield ''; })(); },
		async embed() { return []; },
	};
}

class FakeTodosApi {
	calls: string[] = [];
	private listCounter = 0;
	private itemCounter = 0;
	async createList(opts: { title: string }): Promise<{ id: string }> {
		this.calls.push(`createList:${opts.title}`);
		return { id: `list-${++this.listCounter}` };
	}
	async addItem(listId: string, opts: { title: string }): Promise<{ id: string }> {
		this.calls.push(`addItem:${listId}:${opts.title}`);
		return { id: `item-${++this.itemCounter}` };
	}
	async markInProgress(itemId: string): Promise<unknown> { this.calls.push(`markInProgress:${itemId}`); return {}; }
	async markComplete(itemId: string): Promise<unknown>   { this.calls.push(`markComplete:${itemId}`); return {}; }
	async markBlocked(itemId: string, reason: string): Promise<unknown> { this.calls.push(`markBlocked:${itemId}:${reason}`); return {}; }
	async updateListBody(listId: string, _body: string): Promise<unknown> { this.calls.push(`updateListBody:${listId}`); return {}; }
}

function setupEnv(): { home: string; restore: () => void } {
	const home = mkdtempSync(join(tmpdir(), 'mt-orch-prefs-'));
	const restoreHome = process.env.HOME;
	process.env.HOME = home;
	const originalMeta = PATHS.meta;
	(PATHS as { meta: string }).meta = join(home, '.insrc', 'meta');
	return {
		home,
		restore: () => {
			(PATHS as { meta: string }).meta = originalMeta;
			if (restoreHome !== undefined) { process.env.HOME = restoreHome; }
			try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
		},
	};
}

function makeEmitter(): { emit: MetaTaskEmitter; todos: FakeTodosApi; events: OutboundMessage[] } {
	const events: OutboundMessage[] = [];
	const todos  = new FakeTodosApi();
	const emit   = new MetaTaskEmitter({
		send:  msg => events.push(msg),
		todos: todos as unknown as MetaTaskEmitter['todos'],
	});
	return { emit, todos, events };
}

interface SubstrateFx { dir: string }
function withSubstrate(): SubstrateFx {
	_resetSubstrateRuntimeForTests();
	const dir = mkdtempSync(join(tmpdir(), 'mt-prefs-sub-'));
	initSubstrateRuntime({
		localProvider: noopProvider(),
		workspaceId:   'mt-prefs',
		rootDir:       dir,
	});
	return { dir };
}
function teardownSubstrate(sf: SubstrateFx): void {
	_resetSubstrateRuntimeForTests();
	try { rmSync(sf.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function seedPref(opts: {
	readonly templateId:    string;
	readonly turnId:        string;
	readonly subject:       string;
	readonly canonicalText: string;
	readonly confidence?:   number;
}): Promise<void> {
	const owner = `agent:meta-task:${opts.templateId}`;
	const ns = getSubstrateRuntime().memory.scope(owner, 'user-assertions');
	const key = `${opts.turnId}::${opts.subject}`;
	await ns.put(key, {
		text:              opts.canonicalText,
		subject:           opts.subject,
		preferenceSubject: opts.subject,
		canonicalText:     opts.canonicalText,
		polarity:          'preference',
		scope:             'workspace',
		targetOwners:      [],
		confidence:        opts.confidence ?? 0.9,
	}, {
		kind:       'constraint',
		source:     { kind: 'user-asserted', turnId: opts.turnId },
		confidence: opts.confidence ?? 0.9,
	});
}

/** Return all distinct phase-2 prompts seen by the cloud (the second call of every iteration). */
function phase2Prompts(calls: readonly RecordedCall[]): string[] {
	// Each iteration: phase-1 ask, then phase-2 task. So phase-2 prompts are
	// at odd indices in the call sequence.
	return calls
		.filter((_c, i) => i % 2 === 1)
		.map(c => {
			const m = c.messages.findLast(m => m.role === 'user');
			return m?.content ?? '';
		});
}


// ---------------------------------------------------------------------------
// Auto-inject on 'sufficient'
// ---------------------------------------------------------------------------

test('runMetaTask: auto-injects preferences in phase-2 prompt even when cloud says sufficient', async () => {
	const env = setupEnv();
	const sub = withSubstrate();
	try {
		await seedPref({
			templateId:    'review',
			turnId:        't-1',
			subject:       'test-policy',
			canonicalText: 'Always include integration tests in reviews.',
		});

		const { emit, todos } = makeEmitter();
		const cloud = recordingCloud([
			JSON.stringify({ kind: 'sufficient' }),                                       // phase-1 ask
			JSON.stringify({ kind: 'deliverable', body: '# Review\n\n## Findings\n- ok' }),  // phase-2 deliverable
		]);
		const result = await runMetaTask({
			templateId: 'review',
			intent:     'look at parser.ts',
			scope: {
				intent: 'look at parser.ts', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [],
			},
			sessionId: 'sess-prefs-1',
			emit,
			cloud,
			embed:    async () => [],
			allocId:  () => 'mt-test-prefs-1',
		});
		assert.equal(result.outcome, 'completed');

		const phase2 = phase2Prompts(cloud.calls);
		assert.ok(phase2.length >= 1, 'expected at least one phase-2 prompt');
		const p = phase2[0]!;
		// The cloud's original 'sufficient' verdict is preserved in the messaging.
		assert.match(p, /You declared sufficiency in phase 1/);
		// AND the auto-injected preferences chunk is rendered.
		assert.match(p, /Auto-injected: active user preferences/);
		assert.match(p, /integration tests/i);

		assert.ok(todos.calls.some(c => c.startsWith('markComplete:')));
	} finally {
		teardownSubstrate(sub);
		env.restore();
	}
});


// ---------------------------------------------------------------------------
// No preferences seeded -> auto-injection produces an empty chunk; the
// prompt skips the "Auto-injected" section.
// ---------------------------------------------------------------------------

test('runMetaTask: no seeded preferences -> auto-injection empty -> no preferences block in prompt', async () => {
	const env = setupEnv();
	const sub = withSubstrate();
	try {
		const { emit, todos } = makeEmitter();
		const cloud = recordingCloud([
			JSON.stringify({ kind: 'sufficient' }),
			JSON.stringify({ kind: 'deliverable', body: '# Review\n\n- nothing' }),
		]);
		await runMetaTask({
			templateId: 'review',
			intent:     'unrelated',
			scope: {
				intent: 'unrelated', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [],
			},
			sessionId: 'sess-prefs-2',
			emit,
			cloud,
			embed:    async () => [],
			allocId:  () => 'mt-test-prefs-2',
		});
		const p = phase2Prompts(cloud.calls)[0]!;
		assert.match(p, /You declared sufficiency in phase 1/);
		// The empty preferences chunk produces no "Auto-injected" section.
		assert.doesNotMatch(p, /Auto-injected: active user preferences/);
		assert.ok(todos.calls.some(c => c.startsWith('markComplete:')));
	} finally {
		teardownSubstrate(sub);
		env.restore();
	}
});


// ---------------------------------------------------------------------------
// context-needed: cloud asks for files; the orchestrator prepends a
// preferences slot. Both surface in the phase-2 prompt.
// ---------------------------------------------------------------------------

test('runMetaTask: context-needed asks have preferences slot prepended; both visible in phase-2 prompt', async () => {
	const env = setupEnv();
	const sub = withSubstrate();
	try {
		await seedPref({
			templateId:    'review',
			turnId:        't-1',
			subject:       'test-policy',
			canonicalText: 'Prefer property-based tests over example tests.',
		});

		const { emit } = makeEmitter();
		const cloud = recordingCloud([
			JSON.stringify({
				kind:     'context-needed',
				requests: [{ kind: 'files', globs: ['**/parser.ts'] }],
				intent:   'inspect parser.ts',
			}),
			JSON.stringify({ kind: 'deliverable', body: '# Review\n- done' }),
		]);
		await runMetaTask({
			templateId: 'review',
			intent:     'look at parser.ts',
			scope: {
				intent: 'look at parser.ts', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [],
			},
			sessionId: 'sess-prefs-3',
			emit,
			cloud,
			embed:    async () => [],
			allocId:  () => 'mt-test-prefs-3',
		});
		const p = phase2Prompts(cloud.calls)[0]!;
		// The "context (assembled by local LLM)" framing still appears...
		assert.match(p, /Context \(assembled by local LLM/);
		// ...and the auto-injected preferences chunk lives alongside the requested
		// `files` chunk under "Auto-injected" section.
		assert.match(p, /Auto-injected: active user preferences/);
		assert.match(p, /property-based tests/i);
	} finally {
		teardownSubstrate(sub);
		env.restore();
	}
});


// ---------------------------------------------------------------------------
// localProvider opt-out -> still works (no curation), still injects
// ---------------------------------------------------------------------------

test('runMetaTask: omitting localProvider -> still auto-injects, just skips G5 curation', async () => {
	const env = setupEnv();
	const sub = withSubstrate();
	try {
		await seedPref({ templateId: 'review', turnId: 't-1', subject: 'test-policy', canonicalText: 'Always tests.' });
		await seedPref({ templateId: 'review', turnId: 't-2', subject: 'code-style',  canonicalText: 'Use tabs.' });

		const { emit } = makeEmitter();
		const cloud = recordingCloud([
			JSON.stringify({ kind: 'sufficient' }),
			JSON.stringify({ kind: 'deliverable', body: '# Review\n- done' }),
		]);
		// runMetaTask called WITHOUT localProvider.
		await runMetaTask({
			templateId: 'review',
			intent:     'look at parser.ts',
			scope: {
				intent: 'look at parser.ts', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [],
			},
			sessionId: 'sess-prefs-4',
			emit,
			cloud,
			embed:    async () => [],
			allocId:  () => 'mt-test-prefs-4',
		});
		const p = phase2Prompts(cloud.calls)[0]!;
		// Both preferences appear (no curator dropped either).
		assert.match(p, /Always tests/i);
		assert.match(p, /Use tabs/i);
	} finally {
		teardownSubstrate(sub);
		env.restore();
	}
});
