/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the implicit-capture-during-retrieval backstop (memory-context M5).
 *
 * Drives `runImplicitPass` against a real substrate memory store with a
 * scripted classifier so the verdict pattern is deterministic. Covers:
 *   - State round-trip (load/save).
 *   - First pass: scans every turn; accepts staged into pending namespace.
 *   - Second pass: cursor advanced; only new turns get classified.
 *   - Dismissed turns skipped on subsequent passes.
 *   - Staged turns not re-staged on subsequent passes (cursor regression
 *     defensive check).
 *   - onCandidateStaged fires once per staged candidate.
 *   - Classifier failure -> dismissal (no infinite retry).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryStore } from '../memory-store.js';
import {
	freshImplicitCaptureState,
	loadImplicitCaptureState,
	saveImplicitCaptureState,
	stateKeyFor,
	IMPLICIT_CAPTURE_NS,
} from '../implicit-capture-state.js';
import {
	PENDING_NS,
	runImplicitPass,
	type ImplicitDeps,
	type ImplicitTurnInput,
	type StagedCandidateEvent,
} from '../implicit-capture.js';
import type {
	UserAssertionClassifier,
	ClassifyInput,
	ClassifyResult,
	UserAssertionPayload,
} from '../classifier/user-assertion.js';
import type { MemoryStore } from '../types.js';

const OWNER = 'agent:chat';


// ---------------------------------------------------------------------------
// Scripted classifier
// ---------------------------------------------------------------------------

type Scripted = (input: ClassifyInput) => ClassifyResult | Promise<ClassifyResult>;

function scriptedClassifier(script: Scripted): UserAssertionClassifier {
	return {
		async classify(input: ClassifyInput): Promise<ClassifyResult> {
			return script(input);
		},
	};
}

function accepted(subject: string, text: string, confidence = 0.9): UserAssertionPayload {
	return {
		text,
		subject,
		preferenceSubject: subject,
		canonicalText:     text,
		polarity:          'preference',
		scope:             'workspace',
		targetOwners:      [],
		confidence,
	};
}

function acceptResult(input: ClassifyInput, subject: string, confidence = 0.9): ClassifyResult {
	return {
		accepted:  [accepted(subject, input.text, confidence)],
		deferred:  [],
		rejected:  [],
		decisions: [{ turnId: input.turnId, span: input.text, layer: 2, decision: 'accept', confidence }],
	};
}

function rejectResult(input: ClassifyInput): ClassifyResult {
	return {
		accepted:  [],
		deferred:  [],
		rejected:  [{ text: input.text, reason: 'no assertion shape' }],
		decisions: [{ turnId: input.turnId, span: input.text, layer: 1, decision: 'reject', confidence: 1 }],
	};
}


// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Fx {
	readonly dir:    string;
	readonly memory: MemoryStore;
	readonly events: StagedCandidateEvent[];
}

function setup(): Fx {
	const dir = mkdtempSync(join(tmpdir(), 'implicit-capture-'));
	const memory = createMemoryStore({ workspaceId: 'implicit-test', rootDir: dir });
	return { dir, memory, events: [] };
}
function teardown(fx: Fx): void {
	try { rmSync(fx.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function fxDeps(fx: Fx, turns: readonly ImplicitTurnInput[], classifier: UserAssertionClassifier): ImplicitDeps {
	return {
		memory:     fx.memory,
		classifier,
		getTurnsForSession: async (_sid: string) => turns,
		onCandidateStaged:  (e) => { fx.events.push(e); },
		now: () => 1_700_000_000_000,
	};
}


// ---------------------------------------------------------------------------
// State storage round trip
// ---------------------------------------------------------------------------

test('implicit-capture-state: load/save round trip', async () => {
	const fx = setup();
	try {
		const initial = freshImplicitCaptureState('s-1', OWNER);
		assert.equal(initial.lastScannedTurnIdx, -1);
		assert.equal(initial.dismissedTurnIdxs.length, 0);

		await saveImplicitCaptureState(fx.memory, {
			...initial,
			lastScannedTurnIdx: 5,
			dismissedTurnIdxs:  [1, 3],
			stagedTurnIdxs:     [2],
		});
		const loaded = await loadImplicitCaptureState(fx.memory, OWNER, 's-1');
		assert.ok(loaded);
		assert.equal(loaded!.lastScannedTurnIdx, 5);
		assert.deepEqual(loaded!.dismissedTurnIdxs, [1, 3]);
		assert.deepEqual(loaded!.stagedTurnIdxs,    [2]);
	} finally { teardown(fx); }
});

test('implicit-capture-state: stateKeyFor includes sessionId', () => {
	assert.equal(stateKeyFor('s-abc'), 's-abc::state');
	assert.equal(IMPLICIT_CAPTURE_NS, 'implicit-capture-state');
});

test('implicit-capture-state: load returns undefined on miss', async () => {
	const fx = setup();
	try {
		const loaded = await loadImplicitCaptureState(fx.memory, OWNER, 'nope');
		assert.equal(loaded, undefined);
	} finally { teardown(fx); }
});


// ---------------------------------------------------------------------------
// First pass: scans every turn
// ---------------------------------------------------------------------------

test('runImplicitPass: empty session -> no scans, fresh state saved', async () => {
	const fx = setup();
	try {
		const classifier = scriptedClassifier(() => rejectResult({ turnId: '', text: '' }));
		const r = await runImplicitPass('s-1', OWNER, fxDeps(fx, [], classifier));
		assert.equal(r.scannedTurns,  0);
		assert.equal(r.stagedCount,   0);
		assert.equal(r.dismissedCount, 0);
		assert.equal(r.state.lastScannedTurnIdx, -1);
	} finally { teardown(fx); }
});

test('runImplicitPass: scans every turn on first pass; mixed accept + reject', async () => {
	const fx = setup();
	try {
		const turns: ImplicitTurnInput[] = [
			{ idx: 0, text: 'how do I parse this?' },
			{ idx: 1, text: 'always use snake_case for python variables' },
			{ idx: 2, text: 'what time is it?' },
			{ idx: 3, text: 'never commit without tests' },
		];
		const classifier = scriptedClassifier(input => {
			if (/always|never/i.test(input.text)) {
				const subject = /tests/i.test(input.text) ? 'test-policy' : 'code-style';
				return acceptResult(input, subject, 0.85);
			}
			return rejectResult(input);
		});
		const r = await runImplicitPass('s-1', OWNER, fxDeps(fx, turns, classifier));

		assert.equal(r.scannedTurns,   4);
		assert.equal(r.stagedCount,    2);
		assert.equal(r.dismissedCount, 2);
		assert.deepEqual(r.state.stagedTurnIdxs,    [1, 3]);
		assert.deepEqual(r.state.dismissedTurnIdxs, [0, 2]);
		assert.equal(r.state.lastScannedTurnIdx, 3);

		// Pending namespace populated with both accepted candidates.
		const pendingNs = fx.memory.scope(OWNER, PENDING_NS);
		const e1 = await pendingNs.get('s-1:implicit:1::code-style');
		const e3 = await pendingNs.get('s-1:implicit:3::test-policy');
		assert.ok(e1, 'turn 1 accept staged');
		assert.ok(e3, 'turn 3 accept staged');
		assert.equal(e1!.kind, 'hint');
		assert.equal(e3!.kind, 'hint');
		const v1 = e1!.value as Record<string, unknown>;
		assert.equal(v1['implicit'], true);

		// onCandidateStaged fired twice.
		assert.equal(fx.events.length, 2);
		const subjects = fx.events.map(e => e.subject).sort();
		assert.deepEqual(subjects, ['code-style', 'test-policy']);
	} finally { teardown(fx); }
});


// ---------------------------------------------------------------------------
// Second pass: cursor advances; only new turns scanned
// ---------------------------------------------------------------------------

test('runImplicitPass: second pass only scans turns after cursor', async () => {
	const fx = setup();
	try {
		const turns: ImplicitTurnInput[] = [
			{ idx: 0, text: 'always use snake_case' },
			{ idx: 1, text: 'random question' },
		];
		const callCount = { n: 0 };
		const classifier = scriptedClassifier(input => {
			callCount.n += 1;
			if (/always|never/i.test(input.text)) {
				return acceptResult(input, 'code-style');
			}
			return rejectResult(input);
		});

		// First pass scans both.
		await runImplicitPass('s-1', OWNER, fxDeps(fx, turns, classifier));
		assert.equal(callCount.n, 2);
		fx.events.length = 0;

		// Append a new turn; second pass scans ONLY that new one.
		const extendedTurns: ImplicitTurnInput[] = [
			...turns,
			{ idx: 2, text: 'never deploy on Friday' },
		];
		const r2 = await runImplicitPass('s-1', OWNER, fxDeps(fx, extendedTurns, classifier));
		assert.equal(callCount.n, 3, 'classifier called exactly once more (turn 2)');
		assert.equal(r2.scannedTurns,  1);
		assert.equal(r2.stagedCount,   1);
		assert.equal(r2.state.lastScannedTurnIdx, 2);
		assert.deepEqual(r2.state.stagedTurnIdxs,    [0, 2]);
		assert.deepEqual(r2.state.dismissedTurnIdxs, [1]);
	} finally { teardown(fx); }
});


// ---------------------------------------------------------------------------
// Dismissed + staged turns stay sticky
// ---------------------------------------------------------------------------

test('runImplicitPass: dismissed turn idxs skipped on subsequent passes (cursor regression defensive)', async () => {
	const fx = setup();
	try {
		const turns: ImplicitTurnInput[] = [
			{ idx: 0, text: 'random' },
			{ idx: 1, text: 'random again' },
		];
		const classifier = scriptedClassifier(rejectResult);
		await runImplicitPass('s-1', OWNER, fxDeps(fx, turns, classifier));

		// Simulate cursor regression by forcing lastScannedTurnIdx back to -1.
		const state = await loadImplicitCaptureState(fx.memory, OWNER, 's-1');
		assert.ok(state);
		await saveImplicitCaptureState(fx.memory, { ...state!, lastScannedTurnIdx: -1 });

		// Hand a classifier that would ERROR if called -- the dismissed
		// set should short-circuit before invocation.
		const errorClassifier = scriptedClassifier(() => { throw new Error('should not be called'); });
		const r = await runImplicitPass('s-1', OWNER, fxDeps(fx, turns, errorClassifier));
		assert.equal(r.scannedTurns, 2, 'every uncached idx scanned');
		assert.equal(r.stagedCount,  0);
		assert.equal(r.dismissedCount, 0, 'dismissed turns short-circuit before classifier');
	} finally { teardown(fx); }
});


// ---------------------------------------------------------------------------
// Classifier failure -> dismissal
// ---------------------------------------------------------------------------

test('runImplicitPass: classifier throw -> turn dismissed (no infinite retry)', async () => {
	const fx = setup();
	try {
		const turns: ImplicitTurnInput[] = [{ idx: 0, text: 'foo' }];
		const classifier = scriptedClassifier(() => { throw new Error('classifier down'); });
		const r = await runImplicitPass('s-1', OWNER, fxDeps(fx, turns, classifier));
		assert.equal(r.dismissedCount, 1);
		assert.equal(r.stagedCount, 0);
		assert.deepEqual(r.state.dismissedTurnIdxs, [0]);

		// Second pass with a healthy classifier still skips turn 0.
		const callCount = { n: 0 };
		const healthy = scriptedClassifier(input => {
			callCount.n += 1;
			return acceptResult(input, 'code-style');
		});
		await runImplicitPass('s-1', OWNER, fxDeps(fx, turns, healthy));
		assert.equal(callCount.n, 0, 'previously-dismissed turn must not re-classify');
	} finally { teardown(fx); }
});


// ---------------------------------------------------------------------------
// Already-staged turns not re-staged
// ---------------------------------------------------------------------------

test('runImplicitPass: staged idxs not re-staged on cursor regression', async () => {
	const fx = setup();
	try {
		const turns: ImplicitTurnInput[] = [{ idx: 0, text: 'always include tests' }];
		const classifier = scriptedClassifier(input => acceptResult(input, 'test-policy'));
		await runImplicitPass('s-1', OWNER, fxDeps(fx, turns, classifier));
		assert.equal(fx.events.length, 1);

		// Cursor regression -- same turn returns to scan; staged set short-circuits.
		const state = await loadImplicitCaptureState(fx.memory, OWNER, 's-1');
		await saveImplicitCaptureState(fx.memory, { ...state!, lastScannedTurnIdx: -1 });
		const errorClassifier = scriptedClassifier(() => { throw new Error('should not be called'); });
		const r = await runImplicitPass('s-1', OWNER, fxDeps(fx, turns, errorClassifier));
		assert.equal(r.stagedCount, 0);
		assert.equal(r.dismissedCount, 0);
		// onCandidateStaged should NOT fire again.
		assert.equal(fx.events.length, 1);
	} finally { teardown(fx); }
});


// ---------------------------------------------------------------------------
// Defensive: onCandidateStaged carries the right payload
// ---------------------------------------------------------------------------

test('runImplicitPass: onCandidateStaged carries (key, subject, canonicalText, confidence)', async () => {
	const fx = setup();
	try {
		const turns: ImplicitTurnInput[] = [{ idx: 5, text: 'always include unit tests' }];
		const classifier = scriptedClassifier(input => acceptResult(input, 'test-policy', 0.91));
		await runImplicitPass('s-1', OWNER, fxDeps(fx, turns, classifier));
		assert.equal(fx.events.length, 1);
		const e = fx.events[0]!;
		assert.equal(e.turnIdx, 5);
		assert.equal(e.subject, 'test-policy');
		assert.equal(e.canonicalText, 'always include unit tests');
		assert.equal(e.confidence, 0.91);
		assert.equal(e.key, 's-1:implicit:5::test-policy');
		assert.equal(e.owner, OWNER);
		assert.equal(e.sessionId, 's-1');
	} finally { teardown(fx); }
});
