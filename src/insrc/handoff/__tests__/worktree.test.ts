/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Worktree tests. Each test stands up a fresh git repo in a tmp dir
 * (one commit, one file) and exercises createWorktree / removeWorktree
 * / diffWorktreeAgainstHead against it. No mocks: the git plumbing is
 * the contract we're testing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	createWorktree,
	removeWorktree,
	diffWorktreeAgainstHead,
	WorktreeError,
} from '../worktree.js';

function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), 'insrc-worktree-test-'));
	run('git', ['init', '-q'], dir);
	run('git', ['config', 'user.email', 'test@example.com'], dir);
	run('git', ['config', 'user.name',  'Worktree Test'], dir);
	run('git', ['config', 'commit.gpgsign', 'false'], dir);
	writeFileSync(join(dir, 'a.txt'), 'initial\n');
	run('git', ['add', '.'], dir);
	run('git', ['commit', '-q', '-m', 'init'], dir);
	return dir;
}

function run(cmd: string, args: string[], cwd: string): void {
	const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
	if (r.status !== 0) {
		throw new Error(`${cmd} ${args.join(' ')} failed: exit=${r.status} stderr=${r.stderr ?? ''}`);
	}
}

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------

test('createWorktree: creates worktree off HEAD; files mirror the source tree', async () => {
	const repo = initRepo();
	const wt   = join(repo, '_worktrees', 'wt1');
	try {
		const result = await createWorktree({ repoPath: repo, worktreePath: wt });
		assert.equal(result.action,       'created');
		assert.equal(result.worktreePath, wt);
		assert.equal(result.ref,          'HEAD');
		assert.equal(existsSync(join(wt, 'a.txt')), true);
		assert.equal(readFileSync(join(wt, 'a.txt'), 'utf8'), 'initial\n');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('createWorktree: existing path -> action=reused; no failure unless failIfExists set', async () => {
	const repo = initRepo();
	const wt   = join(repo, '_worktrees', 'wt-reuse');
	try {
		await createWorktree({ repoPath: repo, worktreePath: wt });
		const second = await createWorktree({ repoPath: repo, worktreePath: wt });
		assert.equal(second.action, 'reused');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('createWorktree: failIfExists=true -> throws WorktreeError on existing path', async () => {
	const repo = initRepo();
	const wt   = join(repo, '_worktrees', 'wt-fail');
	try {
		await createWorktree({ repoPath: repo, worktreePath: wt });
		await assert.rejects(
			() => createWorktree({ repoPath: repo, worktreePath: wt, failIfExists: true }),
			(err: Error) => err instanceof WorktreeError && /already exists/.test(err.message),
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('createWorktree: missing parent dir auto-created (git would otherwise fail)', async () => {
	const repo = initRepo();
	const wt   = join(repo, '_a', '_b', '_c', 'wt-deep');
	try {
		const result = await createWorktree({ repoPath: repo, worktreePath: wt });
		assert.equal(result.action, 'created');
		assert.equal(existsSync(wt), true);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('createWorktree: invalid ref -> throws WorktreeError carrying git stderr', async () => {
	const repo = initRepo();
	const wt   = join(repo, '_worktrees', 'wt-bad-ref');
	try {
		await assert.rejects(
			() => createWorktree({ repoPath: repo, worktreePath: wt, ref: 'definitely-not-a-real-ref' }),
			(err: Error) => err instanceof WorktreeError
				&& /git worktree add failed/.test(err.message),
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

test('removeWorktree: tears down a created worktree; idempotent on missing path', async () => {
	const repo = initRepo();
	const wt   = join(repo, '_worktrees', 'wt-remove');
	try {
		await createWorktree({ repoPath: repo, worktreePath: wt });
		assert.equal(existsSync(wt), true);
		await removeWorktree({ repoPath: repo, worktreePath: wt });
		assert.equal(existsSync(wt), false);
		// Idempotent: removing a path that no longer exists should not throw.
		await removeWorktree({ repoPath: repo, worktreePath: wt });
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('removeWorktree: forces removal even when worktree has uncommitted edits', async () => {
	const repo = initRepo();
	const wt   = join(repo, '_worktrees', 'wt-dirty');
	try {
		await createWorktree({ repoPath: repo, worktreePath: wt });
		appendFileSync(join(wt, 'a.txt'), 'extra line\n');
		await removeWorktree({ repoPath: repo, worktreePath: wt });
		assert.equal(existsSync(wt), false);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// diffWorktreeAgainstHead
// ---------------------------------------------------------------------------

test('diffWorktreeAgainstHead: empty diff returned for unchanged worktree', async () => {
	const repo = initRepo();
	const wt   = join(repo, '_worktrees', 'wt-clean');
	try {
		await createWorktree({ repoPath: repo, worktreePath: wt });
		const diff = await diffWorktreeAgainstHead({ repoPath: repo, worktreePath: wt });
		assert.equal(diff, '');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('diffWorktreeAgainstHead: dirty worktree returns unified diff for the modified file', async () => {
	const repo = initRepo();
	const wt   = join(repo, '_worktrees', 'wt-diff');
	try {
		await createWorktree({ repoPath: repo, worktreePath: wt });
		appendFileSync(join(wt, 'a.txt'), 'new line\n');
		const diff = await diffWorktreeAgainstHead({ repoPath: repo, worktreePath: wt });
		assert.match(diff, /^diff --git a\/a\.txt b\/a\.txt/m);
		assert.match(diff, /\+new line/);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
