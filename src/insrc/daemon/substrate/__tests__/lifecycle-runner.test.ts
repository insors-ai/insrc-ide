/**
 * Lifecycle-runner DAG tests -- P3.5 of plans/skills/substrate-implementation-status.md.
 *
 * Coverage:
 *   - Linear chain (a -> b -> c) runs in dep order.
 *   - Diamond (a -> b,c -> d) runs b before d, c before d.
 *   - Cycle detection rejects bad spec at registration time.
 *   - Failed builder skips its transitive dependents.
 *   - Unrelated builders still run when an unrelated one fails.
 *   - Trigger filter: only builders matching the trigger kind run.
 *   - Concurrent fireTrigger calls are serialized (no interleave).
 *   - drain() awaits the queue empty.
 *   - validateDag() returns ok for empty + acyclic; rejects with cycles.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	createLifecycleRunner,
	DagCycleError,
	type BuilderRunResult,
	type LifecycleRunner,
} from '../lifecycle-runner.js';
import { createMemoryStore } from '../memory-store.js';
import type { BootstrapTrigger, ContextBuilderSpec } from '../types.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function fx(): { runner: LifecycleRunner; calls: string[]; dispose: () => void } {
	const root = mkdtempSync(join(tmpdir(), 'insrc-substrate-p3-'));
	const memory = createMemoryStore({ workspaceId: 'wsP3', rootDir: root });
	const runner = createLifecycleRunner({ memory });
	return {
		runner,
		calls: [],
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

function builder(
	id: string,
	dependsOn: string[],
	calls: string[],
	opts: {
		readonly fail?:        boolean;
		readonly triggers?:    readonly BootstrapTrigger['kind'][];
		readonly delayMs?:     number;
	} = {},
): ContextBuilderSpec {
	return {
		id,
		ownerId:   `test:${id}`,
		triggers:  opts.triggers ?? ['repo-add'],
		dependsOn,
		async build() {
			if (opts.delayMs !== undefined && opts.delayMs > 0) {
				await new Promise(r => setTimeout(r, opts.delayMs));
			}
			calls.push(id);
			if (opts.fail === true) { throw new Error(`builder ${id} failing`); }
			return { entriesWritten: 1, notes: [] };
		},
	};
}

const TRIGGER: BootstrapTrigger = { kind: 'repo-add', workspaceId: 'wsP3', repoPath: '/repo' };

// ---------------------------------------------------------------------------
// Topo order
// ---------------------------------------------------------------------------

test('linear chain runs in dep order', async () => {
	const f = fx();
	try {
		f.runner.registerContextBuilder(builder('a', [],    f.calls));
		f.runner.registerContextBuilder(builder('b', ['a'], f.calls));
		f.runner.registerContextBuilder(builder('c', ['b'], f.calls));

		const r = await f.runner.fireTrigger(TRIGGER);
		assert.equal(r.succeeded, 3);
		assert.equal(r.failed, 0);
		assert.deepEqual(f.calls, ['a', 'b', 'c']);
	} finally { f.dispose(); }
});

test('diamond: a -> b,c -> d; d runs after both b and c', async () => {
	const f = fx();
	try {
		f.runner.registerContextBuilder(builder('a', [],          f.calls));
		f.runner.registerContextBuilder(builder('b', ['a'],       f.calls));
		f.runner.registerContextBuilder(builder('c', ['a'],       f.calls));
		f.runner.registerContextBuilder(builder('d', ['b', 'c'],  f.calls));

		const r = await f.runner.fireTrigger(TRIGGER);
		assert.equal(r.succeeded, 4);

		// 'a' must be first; 'd' must be last. b/c order between them
		// is fixed by the runner's stable id-sort within a level.
		assert.equal(f.calls[0], 'a');
		assert.equal(f.calls[f.calls.length - 1], 'd');
		assert.ok(f.calls.indexOf('b') < f.calls.indexOf('d'));
		assert.ok(f.calls.indexOf('c') < f.calls.indexOf('d'));
	} finally { f.dispose(); }
});

test('registration order does not affect execution order', async () => {
	const f = fx();
	try {
		// Register in reverse order.
		f.runner.registerContextBuilder(builder('c', ['b'], f.calls));
		f.runner.registerContextBuilder(builder('b', ['a'], f.calls));
		f.runner.registerContextBuilder(builder('a', [],    f.calls));

		const r = await f.runner.fireTrigger(TRIGGER);
		assert.equal(r.succeeded, 3);
		assert.deepEqual(f.calls, ['a', 'b', 'c']);
	} finally { f.dispose(); }
});

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

test('cycle rejected at registration time', () => {
	const f = fx();
	try {
		f.runner.registerContextBuilder(builder('a', ['b'], f.calls));
		// 'b' depends on 'a' -> closes the cycle.
		assert.throws(
			() => f.runner.registerContextBuilder(builder('b', ['a'], f.calls)),
			(err: unknown) => err instanceof DagCycleError && err.cycles.length >= 1,
		);

		// The bad spec must not have been left in the registry.
		assert.deepEqual(f.runner.registeredBuilders().slice().sort(), ['a']);
	} finally { f.dispose(); }
});

test('self-loop is a cycle', () => {
	const f = fx();
	try {
		assert.throws(
			() => f.runner.registerContextBuilder(builder('selfish', ['selfish'], f.calls)),
			(err: unknown) => err instanceof DagCycleError,
		);
	} finally { f.dispose(); }
});

test('validateDag reports cycle-free state', () => {
	const f = fx();
	try {
		f.runner.registerContextBuilder(builder('a', [],    f.calls));
		f.runner.registerContextBuilder(builder('b', ['a'], f.calls));
		const v = f.runner.validateDag();
		assert.equal(v.ok, true);
	} finally { f.dispose(); }
});

// ---------------------------------------------------------------------------
// Failure propagation
// ---------------------------------------------------------------------------

test('failed builder skips its transitive dependents', async () => {
	const f = fx();
	try {
		f.runner.registerContextBuilder(builder('a', [],    f.calls));
		f.runner.registerContextBuilder(builder('b', ['a'], f.calls, { fail: true }));
		f.runner.registerContextBuilder(builder('c', ['b'], f.calls));
		f.runner.registerContextBuilder(builder('d', ['c'], f.calls));

		const r = await f.runner.fireTrigger(TRIGGER);
		assert.equal(r.succeeded, 1, 'only a succeeds');
		assert.equal(r.failed,    1, 'b fails');
		assert.equal(r.skipped,   2, 'c, d skipped');
		// b's build pushes to calls before throwing, so it appears in
		// the calls log even though the runner records it as failed.
		assert.deepEqual(f.calls, ['a', 'b']);

		const byId = new Map<string, BuilderRunResult>(r.results.map(x => [x.builderId, x]));
		assert.equal(byId.get('a')!.status, 'succeeded');
		assert.equal(byId.get('b')!.status, 'failed');
		assert.equal(byId.get('c')!.status, 'skipped');
		assert.equal(byId.get('c')!.skippedBecause, 'b');
		assert.equal(byId.get('d')!.status, 'skipped');
		assert.equal(byId.get('d')!.skippedBecause, 'c');
	} finally { f.dispose(); }
});

test('unrelated builder still runs when an unrelated one fails', async () => {
	const f = fx();
	try {
		f.runner.registerContextBuilder(builder('failed', [], f.calls, { fail: true }));
		f.runner.registerContextBuilder(builder('ok',     [], f.calls));

		const r = await f.runner.fireTrigger(TRIGGER);
		assert.equal(r.succeeded, 1);
		assert.equal(r.failed,    1);
		assert.equal(r.skipped,   0);
		assert.deepEqual(f.calls.sort(), ['failed', 'ok']);
	} finally { f.dispose(); }
});

// ---------------------------------------------------------------------------
// Trigger filter
// ---------------------------------------------------------------------------

test('only builders matching the trigger kind run', async () => {
	const f = fx();
	try {
		f.runner.registerContextBuilder(builder('addOnly',   [], f.calls, { triggers: ['repo-add'] }));
		f.runner.registerContextBuilder(builder('reindexer', [], f.calls, { triggers: ['reindex']  }));
		f.runner.registerContextBuilder(builder('both',      [], f.calls, { triggers: ['repo-add', 'reindex'] }));

		const r = await f.runner.fireTrigger({ kind: 'reindex', workspaceId: 'wsP3' });
		assert.equal(r.dispatched, 2);
		assert.equal(r.succeeded,  2);
		assert.deepEqual(f.calls.sort(), ['both', 'reindexer']);
	} finally { f.dispose(); }
});

// ---------------------------------------------------------------------------
// Queue serialization
// ---------------------------------------------------------------------------

test('concurrent fireTriggers are serialized', async () => {
	const f = fx();
	try {
		const events: string[] = [];
		f.runner.registerContextBuilder({
			id: 'slow', ownerId: 'test', triggers: ['repo-add'], dependsOn: [],
			async build({ trigger }) {
				const tag = String((trigger.workspaceId ?? '') + '-' + Math.random());
				events.push(`start:${trigger.workspaceId}`);
				await new Promise(r => setTimeout(r, 20));
				events.push(`end:${trigger.workspaceId}`);
				return { entriesWritten: 0, notes: [tag] };
			},
		});

		const p1 = f.runner.fireTrigger({ kind: 'repo-add', workspaceId: 'A' });
		const p2 = f.runner.fireTrigger({ kind: 'repo-add', workspaceId: 'B' });
		await Promise.all([p1, p2]);

		// Serialized: A's start/end happens before B's start/end (or v.v.).
		// Either way they're not interleaved.
		const interleaved =
			(events[0]!.startsWith('start:A') && events[1]!.startsWith('start:B')) ||
			(events[0]!.startsWith('start:B') && events[1]!.startsWith('start:A'));
		assert.ok(!interleaved, `expected serialization but got: ${events.join(' / ')}`);
		assert.equal(events.length, 4);
		assert.ok(events[0]!.startsWith('start:'));
		assert.ok(events[1]!.startsWith('end:'));
		assert.ok(events[2]!.startsWith('start:'));
		assert.ok(events[3]!.startsWith('end:'));
	} finally { f.dispose(); }
});

test('drain awaits queue empty', async () => {
	const f = fx();
	try {
		f.runner.registerContextBuilder(builder('slow', [], f.calls, { delayMs: 15 }));
		// Don't await: just enqueue and call drain.
		void f.runner.fireTrigger(TRIGGER);
		await f.runner.drain();
		assert.deepEqual(f.calls, ['slow']);
	} finally { f.dispose(); }
});

// ---------------------------------------------------------------------------
// Empty / trivial cases
// ---------------------------------------------------------------------------

test('no builders -> empty report', async () => {
	const f = fx();
	try {
		const r = await f.runner.fireTrigger(TRIGGER);
		assert.equal(r.dispatched,     0);
		assert.equal(r.succeeded,      0);
		assert.equal(r.failed,         0);
		assert.equal(r.skipped,        0);
		assert.equal(r.entriesWritten, 0);
		assert.equal(r.results.length, 0);
	} finally { f.dispose(); }
});

test('dep outside matched subset is treated as satisfied', async () => {
	const f = fx();
	try {
		// `b` depends on `external`, which never matches this trigger.
		// Per the runner contract, that dep is treated as satisfied so
		// `b` still runs.
		f.runner.registerContextBuilder(builder('external', [],           f.calls, { triggers: ['reindex'] }));
		f.runner.registerContextBuilder(builder('b',        ['external'], f.calls, { triggers: ['repo-add'] }));

		const r = await f.runner.fireTrigger(TRIGGER);
		assert.equal(r.dispatched, 1);
		assert.equal(r.succeeded,  1);
		assert.deepEqual(f.calls, ['b']);
	} finally { f.dispose(); }
});
