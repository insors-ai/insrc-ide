/**
 * Tests for `code.repo.git-recent` (Plan 4 Phase 1a).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

import { runSkillIsolated } from '../test-harness.js';
import { _resetSkillRegistryForTests } from '../registry.js';
import { _resetRegistryForTests } from '../../tools/registry.js';
import { registerAllSkills } from '../index.js';
import { registerSkillTools } from '../../tools/builtins/skills/invoke-skill.js';
import {
	_parseGitLogOutputForTest as parseGitLogOutput,
	_clampCountForTest         as clampCount,
} from '../built-ins/code.repo.git-recent.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup(): string {
	_resetSkillRegistryForTests();
	_resetRegistryForTests();
	registerAllSkills();
	registerSkillTools();
	return mkdtempSync(join(tmpdir(), 'insrc-gitrecent-'));
}

function git(repoPath: string, ...args: string[]): void {
	execSync(`git -C ${repoPath} ${args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`, {
		stdio: 'pipe',
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
	});
}

function teardown(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

test('parseGitLogOutput: single commit with multiple files', () => {
	const raw = [
		'COMMIT|abc123|Alice|2026-01-01T00:00:00Z|first commit',
		'src/a.ts',
		'src/b.ts',
		'',
	].join('\n');
	const out = parseGitLogOutput(raw);
	assert.equal(out.commits.length, 1);
	assert.equal(out.commits[0]!.sha, 'abc123');
	assert.equal(out.commits[0]!.author, 'Alice');
	assert.equal(out.commits[0]!.subject, 'first commit');
	assert.equal(out.files.length, 2);
});

test('parseGitLogOutput: multiple commits; file touched by two -> commits array has 2 indices', () => {
	const raw = [
		'COMMIT|c1|A|2026-01-02T00:00:00Z|second',
		'src/shared.ts',
		'',
		'COMMIT|c2|A|2026-01-01T00:00:00Z|first',
		'src/shared.ts',
		'src/other.ts',
		'',
	].join('\n');
	const out = parseGitLogOutput(raw);
	assert.equal(out.commits.length, 2);
	const shared = out.files.find(f => f.path === 'src/shared.ts')!;
	assert.deepEqual(shared.commits, [0, 1]);
	const other = out.files.find(f => f.path === 'src/other.ts')!;
	assert.deepEqual(other.commits, [1]);
});

test('parseGitLogOutput: subject may contain pipes -> preserved', () => {
	const raw = 'COMMIT|c1|A|2026-01-01T00:00:00Z|fix(scope): a | b | c\nsrc/x.ts\n\n';
	const out = parseGitLogOutput(raw);
	assert.equal(out.commits[0]!.subject, 'fix(scope): a | b | c');
});

test('parseGitLogOutput: empty input -> empty', () => {
	const out = parseGitLogOutput('');
	assert.equal(out.commits.length, 0);
	assert.equal(out.files.length, 0);
});

// ---------------------------------------------------------------------------
// clampCount
// ---------------------------------------------------------------------------

test('clampCount: default when undefined / invalid', () => {
	assert.equal(clampCount(undefined), 5);
	assert.equal(clampCount(0), 5);
	assert.equal(clampCount(Number.NaN), 5);
	assert.equal(clampCount(-3), 5);
});

test('clampCount: caps at MAX_COUNT (50)', () => {
	assert.equal(clampCount(100), 50);
	assert.equal(clampCount(10),  10);
});

// ---------------------------------------------------------------------------
// End-to-end against a real git repo
// ---------------------------------------------------------------------------

test('git-recent: real repo with 3 commits returns the touched files', async () => {
	const dir = setup();
	try {
		git(dir, 'init', '-q');
		git(dir, 'config', 'user.email', 'test@example.com');
		git(dir, 'config', 'user.name',  'Test');
		writeFileSync(join(dir, 'a.txt'), 'a1');
		git(dir, 'add', 'a.txt');
		git(dir, 'commit', '-q', '-m', 'add a');
		writeFileSync(join(dir, 'b.txt'), 'b1');
		git(dir, 'add', 'b.txt');
		git(dir, 'commit', '-q', '-m', 'add b');
		writeFileSync(join(dir, 'a.txt'), 'a2');
		git(dir, 'add', 'a.txt');
		git(dir, 'commit', '-q', '-m', 'modify a');

		const { result } = await runSkillIsolated<{ repoPath: string; count?: number }, {
			count: number;
			commits: { sha: string; subject: string; author: string; date: string }[];
			files: { path: string; commits: number[] }[];
			truncated: boolean;
		}>(
			'code.repo.git-recent',
			{ repoPath: dir, count: 3 },
			{},
		);
		assert.equal(result.value.count, 3);
		assert.equal(result.value.commits.length, 3);
		const paths = result.value.files.map(f => f.path).sort();
		assert.deepEqual(paths, ['a.txt', 'b.txt']);
		// a.txt was touched by the first commit and the third (per insertion
		// order, the log is most-recent-first, so a.txt is at indices 0 + 2).
		const aFile = result.value.files.find(f => f.path === 'a.txt')!;
		assert.equal(aFile.commits.length, 2);
		assert.equal(result.confidence, 'high');
	} finally {
		teardown(dir);
	}
});

test('git-recent: refuses non-absolute repoPath', async () => {
	setup();
	const { result } = await runSkillIsolated<{ repoPath: string }, unknown>(
		'code.repo.git-recent',
		{ repoPath: 'relative' },
		{},
	);
	assert.equal(result.confidence, 'low');
});

test('git-recent: non-git directory -> low confidence with git error', async () => {
	const dir = setup();
	try {
		const { result } = await runSkillIsolated<{ repoPath: string }, unknown>(
			'code.repo.git-recent',
			{ repoPath: dir },
			{},
		);
		assert.equal(result.confidence, 'low');
		assert.ok(result.notes.some(n => n.includes('git log failed')));
	} finally {
		teardown(dir);
	}
});
