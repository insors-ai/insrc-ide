/**
 * Unit tests for the file-backed memory store -- P0.4.
 *
 * Tests use a per-test temp dir as the substrate root so they don't
 * pollute the daemon's actual `~/.insrc/context/` tree.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryStore } from '../memory-store.js';
import type { EntrySource } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshStore() {
	const root = mkdtempSync(join(tmpdir(), 'insrc-substrate-test-'));
	const store = createMemoryStore({ workspaceId: 'wsX', rootDir: root });
	return {
		store,
		root,
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

const SRC: EntrySource = { kind: 'test', note: 'unit' };

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const x of iter) { out.push(x); }
	return out;
}

// ---------------------------------------------------------------------------
// byKey path
// ---------------------------------------------------------------------------

test('memory-store: put + get round-trip', async () => {
	const { store, dispose } = freshStore();
	try {
		const ns = store.scope('skill:test', 'cache');
		await ns.put('hello', { greeting: 'hi' }, { kind: 'fact', source: SRC, confidence: 0.9 });

		const got = await ns.get<{ greeting: string }>('hello');
		assert.ok(got);
		assert.equal(got.value.greeting, 'hi');
		assert.equal(got.kind, 'fact');
		assert.equal(got.confidence, 0.9);
	} finally { dispose(); }
});

test('memory-store: get returns undefined for missing key', async () => {
	const { store, dispose } = freshStore();
	try {
		const ns = store.scope('skill:test', 'cache');
		const got = await ns.get('nope');
		assert.equal(got, undefined);
	} finally { dispose(); }
});

test('memory-store: delete removes the entry', async () => {
	const { store, dispose } = freshStore();
	try {
		const ns = store.scope('skill:test', 'cache');
		await ns.put('k', { x: 1 }, { kind: 'fact', source: SRC, confidence: 0.9 });
		await ns.delete('k');
		assert.equal(await ns.get('k'), undefined);
	} finally { dispose(); }
});

test('memory-store: delete is idempotent', async () => {
	const { store, dispose } = freshStore();
	try {
		const ns = store.scope('skill:test', 'cache');
		await ns.delete('never-existed'); // no throw
		assert.ok(true);
	} finally { dispose(); }
});

// ---------------------------------------------------------------------------
// Key sanitization
// ---------------------------------------------------------------------------

test('memory-store: keys with colons round-trip via URL encoding', async () => {
	const { store, dispose } = freshStore();
	try {
		const ns = store.scope('skill:test', 'aliases');
		await ns.put('connA:User', { canonical: 'UserModel' }, { kind: 'constraint', source: SRC, confidence: 1.0 });
		const got = await ns.get<{ canonical: string }>('connA:User');
		assert.equal(got?.value.canonical, 'UserModel');
	} finally { dispose(); }
});

test('memory-store: keys containing ".." are rejected', async () => {
	const { store, dispose } = freshStore();
	try {
		const ns = store.scope('skill:test', 'aliases');
		await assert.rejects(
			() => ns.put('../escape', { x: 1 }, { kind: 'fact', source: SRC, confidence: 0.5 }),
			/contains '\.\.'/,
		);
	} finally { dispose(); }
});

// ---------------------------------------------------------------------------
// prefix scan
// ---------------------------------------------------------------------------

test('memory-store: prefix scan returns matching entries', async () => {
	const { store, dispose } = freshStore();
	try {
		const ns = store.scope('skill:test', 'aliases');
		await ns.put('conn1:User',  { canonical: 'UserModel' },  { kind: 'fact', source: SRC, confidence: 0.9 });
		await ns.put('conn1:Order', { canonical: 'OrderEntity' }, { kind: 'fact', source: SRC, confidence: 0.9 });
		await ns.put('conn2:User',  { canonical: 'AccountModel' }, { kind: 'fact', source: SRC, confidence: 0.9 });

		const conn1 = await collect(ns.scan('conn1:'));
		const keys  = conn1.map(e => e.key).sort();
		assert.deepEqual(keys, ['conn1:Order', 'conn1:User']);
	} finally { dispose(); }
});

test('memory-store: prefix scan with limit', async () => {
	const { store, dispose } = freshStore();
	try {
		const ns = store.scope('skill:test', 'cache');
		for (let i = 0; i < 10; i++) {
			await ns.put(`item-${i}`, { i }, { kind: 'fact', source: SRC, confidence: 0.9 });
		}
		const first3 = await collect(ns.scan('item-', { limit: 3 }));
		assert.equal(first3.length, 3);
	} finally { dispose(); }
});

test('memory-store: prefix scan filters out expired entries', async () => {
	const { store, dispose } = freshStore();
	try {
		const ns = store.scope('skill:test', 'cache');
		await ns.put('fresh', { x: 1 }, { kind: 'fact', source: SRC, confidence: 0.9, ttlMs: 60_000 });
		await ns.put('stale', { x: 2 }, { kind: 'fact', source: SRC, confidence: 0.9, ttlMs: 1 });

		// Wait past the 1ms TTL.
		await new Promise(r => setTimeout(r, 10));

		const all = await collect(ns.scan(''));
		assert.deepEqual(all.map(e => e.key).sort(), ['fresh']);
	} finally { dispose(); }
});

// ---------------------------------------------------------------------------
// filter scan
// ---------------------------------------------------------------------------

test('memory-store: filter scan applies predicate', async () => {
	const { store, dispose } = freshStore();
	try {
		const ns = store.scope('skill:test', 'mixed');
		await ns.put('a', { val: 1 }, { kind: 'fact',       source: SRC, confidence: 0.9 });
		await ns.put('b', { val: 2 }, { kind: 'hint',       source: SRC, confidence: 0.5 });
		await ns.put('c', { val: 3 }, { kind: 'constraint', source: SRC, confidence: 1.0 });

		const onlyHints = await collect(ns.filter(e => e.kind === 'hint'));
		assert.equal(onlyHints.length, 1);
		assert.equal(onlyHints[0]?.key, 'b');

		const highConf = await collect(ns.filter(e => e.confidence >= 0.9));
		assert.equal(highConf.length, 2);
	} finally { dispose(); }
});

// ---------------------------------------------------------------------------
// Conflict resolution (D4 default)
// ---------------------------------------------------------------------------

test('memory-store: D4 -- constraint beats fact', async () => {
	const { store, dispose } = freshStore();
	try {
		const ns = store.scope('skill:test', 'rules');
		await ns.put('k', { v: 'fact-value' },       { kind: 'fact',       source: SRC, confidence: 0.9 });
		await ns.put('k', { v: 'constraint-value' }, { kind: 'constraint', source: SRC, confidence: 0.7 });

		const got = await ns.get<{ v: string }>('k');
		assert.equal(got?.value.v, 'constraint-value');
		assert.equal(got?.kind, 'constraint');
	} finally { dispose(); }
});

test('memory-store: D4 -- fact does NOT clobber constraint', async () => {
	const { store, dispose } = freshStore();
	try {
		const ns = store.scope('skill:test', 'rules');
		await ns.put('k', { v: 'constraint-value' }, { kind: 'constraint', source: SRC, confidence: 0.7 });
		await ns.put('k', { v: 'fact-value' },       { kind: 'fact',       source: SRC, confidence: 0.9 });

		const got = await ns.get<{ v: string }>('k');
		assert.equal(got?.value.v, 'constraint-value');
	} finally { dispose(); }
});

test('memory-store: D4 -- within same kind, higher confidence wins', async () => {
	const { store, dispose } = freshStore();
	try {
		const ns = store.scope('skill:test', 'cache');
		await ns.put('k', { v: 'low' },  { kind: 'fact', source: SRC, confidence: 0.5 });
		await ns.put('k', { v: 'high' }, { kind: 'fact', source: SRC, confidence: 0.9 });

		const got = await ns.get<{ v: string }>('k');
		assert.equal(got?.value.v, 'high');
	} finally { dispose(); }
});

test('memory-store: D4 -- within same kind + confidence, more recent wins', async () => {
	const { store, dispose } = freshStore();
	try {
		const ns = store.scope('skill:test', 'cache');
		await ns.put('k', { v: 'first' },  { kind: 'fact', source: SRC, confidence: 0.5 });
		await new Promise(r => setTimeout(r, 5));
		await ns.put('k', { v: 'second' }, { kind: 'fact', source: SRC, confidence: 0.5 });

		const got = await ns.get<{ v: string }>('k');
		assert.equal(got?.value.v, 'second');
	} finally { dispose(); }
});

// ---------------------------------------------------------------------------
// File layout sanity (substrate doc §"Directory layout")
// ---------------------------------------------------------------------------

test('memory-store: files land at <root>/<workspace>/<owner>/<namespace>/<encoded-key>.json', async () => {
	const { store, root, dispose } = freshStore();
	try {
		const ns = store.scope('skill:foo', 'bar');
		await ns.put('hello', { x: 1 }, { kind: 'fact', source: SRC, confidence: 0.9 });

		const expected = join(root, 'wsX', 'skill:foo', 'bar', 'hello.json');
		const stat = await fs.stat(expected);
		assert.ok(stat.isFile());
	} finally { dispose(); }
});

// ---------------------------------------------------------------------------
// byEmbedding stub (P0 returns empty)
// ---------------------------------------------------------------------------

test('memory-store: searchByEmbedding returns empty in P0', async () => {
	const { store, dispose } = freshStore();
	try {
		const ns = store.scope('skill:test', 'cache');
		await ns.put('k', { x: 1 }, { kind: 'fact', source: SRC, confidence: 0.9 });

		const dummy = new Float32Array([0.1, 0.2, 0.3]);
		const hits = await ns.searchByEmbedding(dummy, { topK: 5 });
		assert.equal(hits.length, 0);
	} finally { dispose(); }
});
