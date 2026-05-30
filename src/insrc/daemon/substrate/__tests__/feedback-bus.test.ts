/**
 * Feedback bus tests -- part of P5.6 of plans/skills/substrate-implementation-status.md.
 *
 * Coverage:
 *   - subscribe / unsubscribe round-trip.
 *   - emit delivers to every subscription on the target owner.
 *   - emit with no subscribers reports `delivered: 0`, no failures.
 *   - Handler failures are caught + reported; other handlers still run.
 *   - Per-target ordering: events to one owner arrive in emit order.
 *   - Global serial dispatch: a slow handler blocks the next event.
 *   - drain() awaits the queue empty.
 *   - Cross-owner: an event to owner A doesn't reach owner B's handler.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFeedbackBus, type FeedbackBus } from '../feedback-bus.js';
import { createMemoryStore } from '../memory-store.js';
import type { FeedbackEvent } from '../types.js';

// ---------------------------------------------------------------------------

function fx(): { bus: FeedbackBus; dispose: () => void } {
	const root = mkdtempSync(join(tmpdir(), 'insrc-substrate-p5bus-'));
	const memory = createMemoryStore({ workspaceId: 'wsP5', rootDir: root });
	return {
		bus: createFeedbackBus({ memory }),
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

function event(targetOwner: string, id = `e-${Math.random()}`): FeedbackEvent {
	return {
		id,
		kind:        'user-correction',
		targetOwner,
		memoryRefs:  [],
		payload:     {},
		source:      'classifier:user-assertion',
		at:          Date.now(),
	};
}

// ---------------------------------------------------------------------------

test('subscribe / unsubscribe round-trip', () => {
	const f = fx();
	try {
		const sub = f.bus.subscribe('skill:a', async () => {});
		assert.equal(f.bus.subscriberCount('skill:a'), 1);
		sub.unsubscribe();
		assert.equal(f.bus.subscriberCount('skill:a'), 0);
	} finally { f.dispose(); }
});

test('emit delivers to every subscription on the target', async () => {
	const f = fx();
	try {
		const seen: string[] = [];
		f.bus.subscribe('skill:a', async (e) => { seen.push(`h1:${e.id}`); });
		f.bus.subscribe('skill:a', async (e) => { seen.push(`h2:${e.id}`); });
		const r = await f.bus.emit(event('skill:a', 'evt1'));
		assert.equal(r.delivered, 2);
		assert.equal(r.failed,    0);
		assert.deepEqual(seen, ['h1:evt1', 'h2:evt1']);
	} finally { f.dispose(); }
});

test('emit with no subscribers -> delivered: 0', async () => {
	const f = fx();
	try {
		const r = await f.bus.emit(event('skill:nobody'));
		assert.equal(r.delivered, 0);
		assert.equal(r.failed,    0);
		assert.equal(r.failures.length, 0);
	} finally { f.dispose(); }
});

test('handler failure is caught; other handlers still run', async () => {
	const f = fx();
	try {
		const seen: string[] = [];
		f.bus.subscribe('skill:a', async () => { throw new Error('handler-1 boom'); });
		f.bus.subscribe('skill:a', async (e) => { seen.push(`h2:${e.id}`); });
		const r = await f.bus.emit(event('skill:a', 'evt'));
		assert.equal(r.delivered, 1);
		assert.equal(r.failed,    1);
		assert.equal(r.failures.length, 1);
		assert.match(r.failures[0]!.error, /handler-1 boom/);
		assert.deepEqual(seen, ['h2:evt']);
	} finally { f.dispose(); }
});

test('per-target ordering: events arrive in emit order', async () => {
	const f = fx();
	try {
		const seen: string[] = [];
		f.bus.subscribe('skill:a', async (e) => { seen.push(e.id); });
		await Promise.all([
			f.bus.emit(event('skill:a', 'evt1')),
			f.bus.emit(event('skill:a', 'evt2')),
			f.bus.emit(event('skill:a', 'evt3')),
		]);
		assert.deepEqual(seen, ['evt1', 'evt2', 'evt3']);
	} finally { f.dispose(); }
});

test('global serial dispatch: slow handler blocks next event', async () => {
	const f = fx();
	try {
		const events: string[] = [];
		f.bus.subscribe('skill:slow', async (e) => {
			events.push(`start:${e.id}`);
			await new Promise(r => setTimeout(r, 15));
			events.push(`end:${e.id}`);
		});
		await Promise.all([
			f.bus.emit(event('skill:slow', 'A')),
			f.bus.emit(event('skill:slow', 'B')),
		]);
		// Strict serialization: full A pair before B starts.
		assert.deepEqual(events, ['start:A', 'end:A', 'start:B', 'end:B']);
	} finally { f.dispose(); }
});

test('drain awaits queue empty', async () => {
	const f = fx();
	try {
		const seen: string[] = [];
		f.bus.subscribe('skill:slow', async (e) => {
			await new Promise(r => setTimeout(r, 10));
			seen.push(e.id);
		});
		// Don't await emit.
		void f.bus.emit(event('skill:slow', 'evt1'));
		await f.bus.drain();
		assert.deepEqual(seen, ['evt1']);
	} finally { f.dispose(); }
});

test('cross-owner: an event to A does not reach B', async () => {
	const f = fx();
	try {
		const seenA: string[] = [];
		const seenB: string[] = [];
		f.bus.subscribe('skill:a', async (e) => { seenA.push(e.id); });
		f.bus.subscribe('skill:b', async (e) => { seenB.push(e.id); });
		await f.bus.emit(event('skill:a', 'evt-a'));
		assert.deepEqual(seenA, ['evt-a']);
		assert.deepEqual(seenB, []);
	} finally { f.dispose(); }
});
