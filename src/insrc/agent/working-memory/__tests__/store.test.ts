/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the working-memory persistence module (P1.b).
 *
 * Covers:
 * - Round-trip serialisation (write -> read returns equivalent entry).
 * - Body-with-special-chars preservation (multi-line markdown,
 *   embedded sentinel-like strings, unicode-free).
 * - Ordering across multiple entries (listEntries sorts by index).
 * - Accumulated-text format matches the
 *   `=== entry-NNNN (todoId) ===` shape consumed by the shape-the-
 *   memory step (P1.c).
 * - Idempotent overwrite (re-write at same index replaces).
 * - hasEntry / read on a missing index returns false / undefined.
 * - Atomic write: an interrupted write (tmpfile present, rename never
 *   ran) does not corrupt the existing entry.
 * - Metadata validation: malformed entries throw with a clear error.
 * - Filename slugging: special-char todo ids reduce safely.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
	WorkingMemoryStore,
	openWorkingMemoryStore,
	serialiseEntry,
	parseEntry,
	slugifyTodoId,
} from '../store.js';
import type { WorkingMemoryEntry } from '../types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function mkRunDir(label: string): Promise<string> {
	const base = await fsp.mkdtemp(join(tmpdir(), `insrc-wm-${label}-`));
	return join(base, 'run');
}

function makeEntry(overrides: Partial<WorkingMemoryEntry> = {}): WorkingMemoryEntry {
	return {
		todoId:      overrides.todoId      ?? 'todo-1',
		objective:   overrides.objective   ?? 'Analyze GRN field mappings',
		detail:      overrides.detail      ?? '# Section\n\nSome markdown body.\n',
		findings:    overrides.findings    ?? {
			perRoot: [
				{ rootId: 'discover',    verdict: 'accept', cyclesConsumed: 0, exhausted: false, content: 'shape captured' },
				{ rootId: 'analyze',     verdict: 'accept', cyclesConsumed: 1, exhausted: false, content: 'compare clean' },
				{ rootId: 'synthesize',  verdict: 'accept', cyclesConsumed: 0, exhausted: false, content: 'section rendered' },
			],
		},
		completedAt: overrides.completedAt ?? 1_717_545_600_000,
		origin:      overrides.origin      ?? 'initial',
	};
}

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

test('write + read: returns an equivalent entry', async () => {
	const runDir = await mkRunDir('roundtrip');
	const store = new WorkingMemoryStore(runDir);
	const entry = makeEntry();
	await store.write(0, entry);
	const got = await store.read(0);
	assert.deepEqual(got, entry);
});

test('write + read: multi-line markdown body preserved verbatim', async () => {
	const runDir = await mkRunDir('multiline');
	const store = new WorkingMemoryStore(runDir);
	const detail = '# Title\n\nLine 1\nLine 2\n\n## Subsection\n\n- bullet\n- bullet\n\n```ts\nconst x = 1;\n```\n';
	await store.write(0, makeEntry({ detail }));
	const got = await store.read(0);
	assert.equal(got?.detail, detail);
});

test('write + read: body containing the sentinel-like string still round-trips', async () => {
	// The sentinel sits on its own line between `\n` boundaries. A bare
	// occurrence of the string anywhere else in the body must not be
	// mistaken for the boundary.
	const runDir = await mkRunDir('sentinel');
	const store = new WorkingMemoryStore(runDir);
	const detail = 'Body text mentioning ---working-memory-entry-body--- inline, not on its own line.\n';
	await store.write(0, makeEntry({ detail }));
	const got = await store.read(0);
	assert.equal(got?.detail, detail);
});

// ---------------------------------------------------------------------------
// Multiple entries + ordering
// ---------------------------------------------------------------------------

test('listEntries: returns entries in ascending index order', async () => {
	const runDir = await mkRunDir('order');
	const store = new WorkingMemoryStore(runDir);
	await store.write(2, makeEntry({ todoId: 'c', detail: 'C body\n' }));
	await store.write(0, makeEntry({ todoId: 'a', detail: 'A body\n' }));
	await store.write(1, makeEntry({ todoId: 'b', detail: 'B body\n' }));
	const got = await store.listEntries();
	assert.deepEqual(got.map(e => e.index),         [0, 1, 2]);
	assert.deepEqual(got.map(e => e.entry.todoId),  ['a', 'b', 'c']);
});

test('listEntries: empty run dir returns []', async () => {
	const runDir = await mkRunDir('empty');
	const store = new WorkingMemoryStore(runDir);
	const got = await store.listEntries();
	assert.deepEqual(got, []);
});

test('listEntries: skips files that do not match the entry pattern', async () => {
	const runDir = await mkRunDir('stray');
	const store = new WorkingMemoryStore(runDir);
	await store.write(0, makeEntry());
	// Drop a stray file that should be ignored.
	await fsp.writeFile(join(runDir, 'notes.txt'), 'unrelated\n', 'utf8');
	const got = await store.listEntries();
	assert.equal(got.length, 1);
});

// ---------------------------------------------------------------------------
// accumulatedMemoryText
// ---------------------------------------------------------------------------

test('accumulatedMemoryText: concatenates in order with per-entry headers', async () => {
	const runDir = await mkRunDir('accum');
	const store = new WorkingMemoryStore(runDir);
	await store.write(0, makeEntry({ todoId: 'first',  detail: 'first body\n' }));
	await store.write(1, makeEntry({ todoId: 'second', detail: 'second body\n' }));

	const text = await store.accumulatedMemoryText();
	// Each entry's header carries a zero-padded index plus the todoId.
	assert.match(text, /=== entry-0000 \(first\) ===/);
	assert.match(text, /=== entry-0001 \(second\) ===/);
	// First entry's content appears before the second.
	assert.ok(text.indexOf('first body') < text.indexOf('second body'));
});

test('accumulatedMemoryText: empty run -> empty string', async () => {
	const runDir = await mkRunDir('accum-empty');
	const store = new WorkingMemoryStore(runDir);
	const text = await store.accumulatedMemoryText();
	assert.equal(text, '');
});

// ---------------------------------------------------------------------------
// Idempotency / hasEntry
// ---------------------------------------------------------------------------

test('hasEntry: false when nothing written; true after write', async () => {
	const runDir = await mkRunDir('hasentry');
	const store = new WorkingMemoryStore(runDir);
	assert.equal(await store.hasEntry(0), false);
	await store.write(0, makeEntry());
	assert.equal(await store.hasEntry(0), true);
	assert.equal(await store.hasEntry(1), false);
});

test('read: returns undefined for a non-existent index', async () => {
	const runDir = await mkRunDir('read-missing');
	const store = new WorkingMemoryStore(runDir);
	assert.equal(await store.read(42), undefined);
});

test('write at existing index replaces the prior entry (crash-recovery semantics)', async () => {
	const runDir = await mkRunDir('overwrite');
	const store = new WorkingMemoryStore(runDir);
	await store.write(0, makeEntry({ todoId: 'a', detail: 'first attempt\n' }));
	await store.write(0, makeEntry({ todoId: 'a', detail: 'second attempt\n' }));
	const got = await store.read(0);
	assert.equal(got?.detail, 'second attempt\n');
});

// ---------------------------------------------------------------------------
// Atomicity (tmpfile present should not affect listings)
// ---------------------------------------------------------------------------

test('atomicity: a leftover .tmp file is ignored by listEntries', async () => {
	const runDir = await mkRunDir('atom');
	const store = new WorkingMemoryStore(runDir);
	await store.write(0, makeEntry({ todoId: 'a', detail: 'real entry\n' }));
	// Simulate a crashed write -- the tmpfile naming pattern from store.ts
	// drops the .tmp suffix only on rename. A leftover .tmp shouldn't
	// surface as an entry.
	await fsp.writeFile(join(runDir, '0001-b.md.tmp.99999.99999'), 'partial garbage\n', 'utf8');
	const got = await store.listEntries();
	assert.equal(got.length, 1);
	assert.equal(got[0]!.entry.todoId, 'a');
});

// ---------------------------------------------------------------------------
// Metadata validation
// ---------------------------------------------------------------------------

test('parseEntry: missing body sentinel -> throws', () => {
	const raw = '{"todoId":"a","objective":"","completedAt":1,"origin":"initial","findings":{"perRoot":[]}}\n\n# body without sentinel\n';
	assert.throws(() => parseEntry(raw), /missing body sentinel/);
});

test('parseEntry: malformed JSON metadata -> throws with reason', () => {
	const raw = 'not-json\n---working-memory-entry-body---\n\n# body\n';
	assert.throws(() => parseEntry(raw), /metadata parse failed/);
});

test('parseEntry: bad origin -> throws', () => {
	const raw = '{"todoId":"a","objective":"o","completedAt":1,"origin":"bogus","findings":{"perRoot":[]}}\n---working-memory-entry-body---\n\nbody\n';
	assert.throws(() => parseEntry(raw), /bad origin/);
});

test('parseEntry: missing findings.perRoot array -> throws', () => {
	const raw = '{"todoId":"a","objective":"o","completedAt":1,"origin":"initial","findings":{}}\n---working-memory-entry-body---\n\nbody\n';
	assert.throws(() => parseEntry(raw), /bad findings shape/);
});

test('serialiseEntry: produces the exact one-line metadata + sentinel + body layout', () => {
	const entry = makeEntry({ detail: 'body line\n' });
	const text = serialiseEntry(entry);
	const lines = text.split('\n');
	assert.ok(lines[0]!.startsWith('{'));     // metadata line is JSON
	assert.equal(lines[1], '---working-memory-entry-body---');
	assert.equal(lines[2], '');               // blank line before body
	assert.equal(lines.slice(3).join('\n'), 'body line\n');
});

// ---------------------------------------------------------------------------
// Findings round-trip: fallback + cycles + exhausted bits preserved
// ---------------------------------------------------------------------------

test('findings round-trip: fallback=L2 + per-root cycles+exhausted preserved', async () => {
	const runDir = await mkRunDir('findings');
	const store = new WorkingMemoryStore(runDir);
	const entry = makeEntry({
		findings: {
			perRoot: [
				{ rootId: 'discover',   verdict: 'force-accept', cyclesConsumed: 3, exhausted: true,  content: 'forced after cap' },
				{ rootId: 'synthesize', verdict: 'L2-fallback',  cyclesConsumed: 0, exhausted: false, content: 'L2 took over' },
			],
			fallback: 'L2',
		},
	});
	await store.write(0, entry);
	const got = await store.read(0);
	assert.equal(got?.findings.fallback, 'L2');
	assert.equal(got?.findings.perRoot[0]!.verdict, 'force-accept');
	assert.equal(got?.findings.perRoot[0]!.exhausted, true);
	assert.equal(got?.findings.perRoot[1]!.verdict, 'L2-fallback');
});

// ---------------------------------------------------------------------------
// Slugging
// ---------------------------------------------------------------------------

test('slugifyTodoId: keeps safe characters', () => {
	assert.equal(slugifyTodoId('analyze-grn'), 'analyze-grn');
	assert.equal(slugifyTodoId('todo.42_v2'), 'todo.42_v2');
});

test('slugifyTodoId: replaces unsafe characters with single dashes', () => {
	assert.equal(slugifyTodoId('analyze GRN fields!'), 'analyze-GRN-fields');
});

test('slugifyTodoId: trims to 60 chars max', () => {
	const long = 'a'.repeat(100);
	assert.equal(slugifyTodoId(long).length, 60);
});

test('slugifyTodoId: empty-after-clean falls back to "todo"', () => {
	assert.equal(slugifyTodoId('!!!'), 'todo');
});

// ---------------------------------------------------------------------------
// Public openWorkingMemoryStore factory
// ---------------------------------------------------------------------------

test('openWorkingMemoryStore: thin factory wrapper', async () => {
	const runDir = await mkRunDir('factory');
	const store = openWorkingMemoryStore(runDir);
	assert.equal(store.runDir, runDir);
	await store.write(0, makeEntry());
	assert.equal(await store.hasEntry(0), true);
});
