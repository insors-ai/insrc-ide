/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * GitHub tracker config resolution + git remote parsing.
 *
 * Note: `resolveGithubConfig` reads from `~/.insrc/github.json`,
 * which we don't want to touch during tests. The tests here focus
 * on the pure parser + the git-remote fallback via a real git
 * command over a tmp repo.
 *
 * Run:
 *   npx tsx --test src/insrc/workflow/config/__tests__/github.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseGithubRemoteUrl, parseGitRemoteOwnerRepo } from '../github.js';

// ---------------------------------------------------------------------------
// parseGithubRemoteUrl
// ---------------------------------------------------------------------------

test('parseGithubRemoteUrl handles SSH remotes', () => {
	assert.deepEqual(parseGithubRemoteUrl('git@github.com:foo/bar.git'), { owner: 'foo', repo: 'bar' });
	assert.deepEqual(parseGithubRemoteUrl('git@github.com:foo/bar'),     { owner: 'foo', repo: 'bar' });
});

test('parseGithubRemoteUrl handles HTTPS remotes', () => {
	assert.deepEqual(parseGithubRemoteUrl('https://github.com/foo/bar.git'), { owner: 'foo', repo: 'bar' });
	assert.deepEqual(parseGithubRemoteUrl('https://github.com/foo/bar'),     { owner: 'foo', repo: 'bar' });
	assert.deepEqual(parseGithubRemoteUrl('http://github.com/foo/bar'),      { owner: 'foo', repo: 'bar' });
});

test('parseGithubRemoteUrl rejects other hosts', () => {
	assert.equal(parseGithubRemoteUrl('git@gitlab.com:foo/bar.git'), null);
	assert.equal(parseGithubRemoteUrl('https://bitbucket.org/foo/bar'), null);
	assert.equal(parseGithubRemoteUrl(''), null);
});

// ---------------------------------------------------------------------------
// parseGitRemoteOwnerRepo (integration — real git repo)
// ---------------------------------------------------------------------------

test('parseGitRemoteOwnerRepo returns owner/repo for a repo with a GitHub origin', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-gh-'));
	try {
		execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
		execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:myorg/myrepo.git'], { cwd: repo, stdio: 'ignore' });
		assert.deepEqual(parseGitRemoteOwnerRepo(repo), { owner: 'myorg', repo: 'myrepo' });
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('parseGitRemoteOwnerRepo returns null on a repo with no origin', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-gh-'));
	try {
		execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
		assert.equal(parseGitRemoteOwnerRepo(repo), null);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('parseGitRemoteOwnerRepo returns null on a non-git dir', () => {
	const dir = mkdtempSync(join(tmpdir(), 'insrc-gh-'));
	try {
		assert.equal(parseGitRemoteOwnerRepo(dir), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
