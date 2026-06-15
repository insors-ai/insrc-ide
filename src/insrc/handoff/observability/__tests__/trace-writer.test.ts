/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Trace writer tests. Pins:
 *
 *   - Each `record` lands as exactly one JSONL line at the tail.
 *   - The recorded ts is whatever the injected clock returns.
 *   - `close` is idempotent; further records after close are no-ops.
 *   - `readTraceJsonl` round-trips the records.
 *   - A partial / truncated line at the end of the file (simulated
 *     by a crashed write) is tolerated; the valid prefix returns.
 *   - A circular event payload doesn't break the run -- a shape-only
 *     fallback line lands instead.
 *   - Open failure (path under a non-writable dir) returns a no-op
 *     writer; record + close are still safe to call.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openTraceWriter, readTraceJsonl } from '../trace-writer.js';
import type { HandoffEvent } from '../../types.js';

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'insrc-trace-'));
}

const EV_SPEC_READY: HandoffEvent = {
	kind: 'spec-ready',
	specId: 'spec-1',
	templateId: 'DEBUG-SESSION',
	preview: 'p',
};

const EV_SPAWNED: HandoffEvent = {
	kind: 'spawned',
	specId: 'spec-1',
	agent: 'claude-code',
};

test('trace: each record lands as one JSONL line with the injected ts', () => {
	const root = tmp();
	try {
		let t = 1_000;
		const w = openTraceWriter({
			persistRoot: root,
			sessionId: 'sess',
			specId: 'spec-1',
			nowMs: () => ++t,
			skipFsync: true,
		});
		w.record(EV_SPEC_READY);
		w.record(EV_SPAWNED);
		w.close();
		const path = join(root, 'sess', 'spec-1.trace.jsonl');
		const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.length > 0);
		assert.equal(lines.length, 2);
		const r1 = JSON.parse(lines[0]!);
		const r2 = JSON.parse(lines[1]!);
		assert.equal(r1.ts, 1001);
		assert.equal(r2.ts, 1002);
		assert.equal(r1.event.kind, 'spec-ready');
		assert.equal(r2.event.kind, 'spawned');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('trace: close is idempotent; record after close is a no-op', () => {
	const root = tmp();
	try {
		const w = openTraceWriter({
			persistRoot: root, sessionId: 'sess', specId: 'spec-2',
			nowMs: () => 1, skipFsync: true,
		});
		w.record(EV_SPEC_READY);
		w.close();
		w.close();  // idempotent
		w.record(EV_SPAWNED);  // post-close: dropped
		const lines = readTraceJsonl(join(root, 'sess', 'spec-2.trace.jsonl'));
		assert.equal(lines.length, 1);
		assert.equal(lines[0]!.event.kind, 'spec-ready');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('trace: readTraceJsonl round-trips records', () => {
	const root = tmp();
	try {
		const w = openTraceWriter({
			persistRoot: root, sessionId: 'sess', specId: 'spec-3',
			nowMs: () => 100, skipFsync: true,
		});
		w.record(EV_SPEC_READY);
		w.record(EV_SPAWNED);
		w.close();
		const records = readTraceJsonl(join(root, 'sess', 'spec-3.trace.jsonl'));
		assert.equal(records.length, 2);
		assert.equal(records[0]!.event.kind, 'spec-ready');
		assert.equal(records[1]!.event.kind, 'spawned');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('trace: readTraceJsonl tolerates a partial line at the tail (crash mid-write)', () => {
	const root = tmp();
	try {
		const path = join(root, 'sess', 'spec-4.trace.jsonl');
		// Hand-craft a file with two complete lines and one truncated.
		mkdirSync(join(root, 'sess'), { recursive: true });
		writeFileSync(path, '');
		appendFileSync(path, JSON.stringify({ ts: 1, event: EV_SPEC_READY }) + '\n');
		appendFileSync(path, JSON.stringify({ ts: 2, event: EV_SPAWNED   }) + '\n');
		appendFileSync(path, '{"ts":3,"event":{"kind":"spawn');  // truncated
		const records = readTraceJsonl(path);
		assert.equal(records.length, 2, 'valid prefix should be returned; truncated tail dropped');
		assert.equal(records[0]!.event.kind, 'spec-ready');
		assert.equal(records[1]!.event.kind, 'spawned');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('trace: circular event payload lands as a shape-only fallback record', () => {
	const root = tmp();
	try {
		const w = openTraceWriter({
			persistRoot: root, sessionId: 'sess', specId: 'spec-5',
			nowMs: () => 1, skipFsync: true,
		});
		const circular: Record<string, unknown> = { kind: 'spawned' };
		circular['self'] = circular;
		// Cast through unknown because we deliberately violate the shape.
		w.record(circular as unknown as HandoffEvent);
		w.close();
		const records = readTraceJsonl(join(root, 'sess', 'spec-5.trace.jsonl'));
		assert.equal(records.length, 1);
		assert.equal(records[0]!.event.kind, 'spawned');
		assert.equal((records[0]!.event as { _stringifyError?: boolean })._stringifyError, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('trace: open succeeds even when the parent dir does not exist (mkdirSync recursive)', () => {
	const root = tmp();
	try {
		const w = openTraceWriter({
			persistRoot: root, sessionId: 'deep/nested/sess', specId: 'spec-6',
			nowMs: () => 1, skipFsync: true,
		});
		w.record(EV_SPEC_READY);
		w.close();
		assert.equal(existsSync(join(root, 'deep', 'nested', 'sess', 'spec-6.trace.jsonl')), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
