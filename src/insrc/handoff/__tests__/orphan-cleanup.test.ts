/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Orphan worktree classifier tests. Each fixture builds a fake
 * persistRoot on a tmpdir with a handful of session directories
 * in different states, then asserts `detectOrphans` classifies
 * them correctly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectOrphans, discardOrphan } from '../orphan-cleanup.js';
import type { HandoffEvent } from '../types.js';

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), 'insrc-orphan-test-'));
}

function makeSession(root: string, sessionId: string, opts?: { withWorktree?: boolean; events?: HandoffEvent[]; specId?: string }): string {
	const sessionDir = join(root, sessionId);
	mkdirSync(sessionDir, { recursive: true });
	if (opts?.withWorktree !== false) {
		mkdirSync(join(sessionDir, 'worktree'), { recursive: true });
	}
	if (opts?.events) {
		const specId = opts.specId ?? 'spec-1';
		const path = join(sessionDir, `${specId}.trace.jsonl`);
		const lines = opts.events.map((e, i) => JSON.stringify({ ts: 1000 + i, event: e }) + '\n');
		writeFileSync(path, lines.join(''));
	}
	return sessionDir;
}

test('detectOrphans: empty persistRoot -> empty array', () => {
	const root = tmpRoot();
	try {
		assert.deepStrictEqual(detectOrphans({ persistRoot: root }), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('detectOrphans: missing persistRoot -> empty array (no throw)', () => {
	const result = detectOrphans({ persistRoot: '/nonexistent/path/never/created' });
	assert.deepStrictEqual(result, []);
});

test('detectOrphans: worktree with no trace -> status=pending', () => {
	const root = tmpRoot();
	try {
		makeSession(root, 'sess-no-trace');
		const orphans = detectOrphans({ persistRoot: root });
		assert.equal(orphans.length, 1);
		assert.equal(orphans[0]!.sessionId, 'sess-no-trace');
		assert.equal(orphans[0]!.status, 'pending');
		assert.equal(orphans[0]!.traceFile, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('detectOrphans: trace ending in handoff-final -> status=completed (waiting on user accept/reject)', () => {
	const root = tmpRoot();
	try {
		makeSession(root, 'sess-done', {
			specId: 'spec-A',
			events: [
				{ kind: 'spec-assembling', intent: 'i', templateId: 'DEBUG-SESSION' },
				{ kind: 'spec-ready', specId: 'spec-A', templateId: 'DEBUG-SESSION', preview: 'p' },
				{ kind: 'handoff-final', specId: 'spec-A', verdict: 'accept', diff: 'd', worktreePath: '/wt', deliverable: '' },
			],
		});
		const orphans = detectOrphans({ persistRoot: root });
		assert.equal(orphans.length, 1);
		assert.equal(orphans[0]!.status, 'completed');
		assert.equal(orphans[0]!.lastEventKind, 'handoff-final');
		assert.equal(orphans[0]!.specId, 'spec-A');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('detectOrphans: trace ending in handoff-error -> status=completed', () => {
	const root = tmpRoot();
	try {
		makeSession(root, 'sess-err', {
			specId: 'spec-E',
			events: [
				{ kind: 'spec-assembling', intent: 'i', templateId: 'DEBUG-SESSION' },
				{ kind: 'spec-ready', specId: 'spec-E', templateId: 'DEBUG-SESSION', preview: 'p' },
				{ kind: 'handoff-error', stage: 'spawn', message: 'boom' },
			],
		});
		const orphans = detectOrphans({ persistRoot: root });
		assert.equal(orphans.length, 1);
		assert.equal(orphans[0]!.status, 'completed');
		assert.equal(orphans[0]!.lastEventKind, 'handoff-error');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('detectOrphans: trace ending mid-pipeline -> status=interrupted (daemon crash)', () => {
	const root = tmpRoot();
	try {
		makeSession(root, 'sess-mid', {
			specId: 'spec-M',
			events: [
				{ kind: 'spec-assembling', intent: 'i', templateId: 'DEBUG-SESSION' },
				{ kind: 'spec-ready', specId: 'spec-M', templateId: 'DEBUG-SESSION', preview: 'p' },
				{ kind: 'worktree-created', specId: 'spec-M', worktreePath: '/wt', ref: 'HEAD' },
				{ kind: 'spawned', specId: 'spec-M', agent: 'claude-code' },
				// Daemon crashed here.
			],
		});
		const orphans = detectOrphans({ persistRoot: root });
		assert.equal(orphans.length, 1);
		assert.equal(orphans[0]!.status, 'interrupted');
		assert.equal(orphans[0]!.lastEventKind, 'spawned');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('detectOrphans: session dir without a worktree subdir is skipped (already cleaned up)', () => {
	const root = tmpRoot();
	try {
		makeSession(root, 'sess-cleaned', { withWorktree: false });
		assert.deepStrictEqual(detectOrphans({ persistRoot: root }), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('detectOrphans: junk files at persistRoot are ignored', () => {
	const root = tmpRoot();
	try {
		writeFileSync(join(root, 'README.md'), '# notes\n');
		makeSession(root, 'sess-real', {
			specId: 'spec-r',
			events: [{ kind: 'spec-assembling', intent: 'i', templateId: 'DEBUG-SESSION' }],
		});
		const orphans = detectOrphans({ persistRoot: root });
		assert.equal(orphans.length, 1);
		assert.equal(orphans[0]!.sessionId, 'sess-real');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('detectOrphans: most-recently-modified trace.jsonl drives classification when multiple specs share a session', () => {
	const root = tmpRoot();
	try {
		const sessionDir = makeSession(root, 'sess-multi', { withWorktree: true });
		// Older spec finished; newer spec interrupted.
		writeFileSync(
			join(sessionDir, 'spec-old.trace.jsonl'),
			JSON.stringify({ ts: 1, event: { kind: 'handoff-final', specId: 'spec-old', verdict: 'accept', diff: 'd', worktreePath: '/w', deliverable: '' } }) + '\n',
		);
		// Touch ordering: sleep briefly to ensure mtime differs.
		const newPath = join(sessionDir, 'spec-new.trace.jsonl');
		writeFileSync(newPath, JSON.stringify({ ts: 2, event: { kind: 'spawned', specId: 'spec-new', agent: 'codex' } }) + '\n');
		// Bump newer file's mtime explicitly.
		utimesSync(newPath, new Date(2000), new Date(2000));
		utimesSync(join(sessionDir, 'spec-old.trace.jsonl'), new Date(1000), new Date(1000));

		const orphans = detectOrphans({ persistRoot: root });
		assert.equal(orphans.length, 1);
		assert.equal(orphans[0]!.status, 'interrupted');
		assert.equal(orphans[0]!.specId, 'spec-new');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('discardOrphan: removes the path and is idempotent on a missing path', () => {
	const root = tmpRoot();
	try {
		const wt = join(root, 'sess-d', 'worktree');
		mkdirSync(wt, { recursive: true });
		writeFileSync(join(wt, 'index.js'), 'console.log("hi")\n');
		assert.equal(existsSync(wt), true);
		assert.equal(discardOrphan(wt), true);
		assert.equal(existsSync(wt), false);
		// Second call is a no-op (returns false because path is gone).
		assert.equal(discardOrphan(wt), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
