/**
 * Tests for `code.repo.git-status` (Plan 4 Phase 1a).
 *
 * Pure-parser tests against the canonical `git diff --name-status -z`
 * output format + end-to-end smoke against a fixture git repo
 * created at runtime with child_process.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

import { runSkillIsolated } from '../test-harness.js';
import { _resetSkillRegistryForTests } from '../registry.js';
import { _resetRegistryForTests } from '../../tools/registry.js';
import { registerAllSkills } from '../index.js';
import { registerSkillTools } from '../../tools/builtins/skills/invoke-skill.js';
import {
	_parseNameStatusForTest as parseNameStatus,
	_mapStatusLetterForTest as mapStatusLetter,
} from '../built-ins/code.repo.git-status.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup(): string {
	_resetSkillRegistryForTests();
	_resetRegistryForTests();
	registerAllSkills();
	registerSkillTools();
	return mkdtempSync(join(tmpdir(), 'insrc-gitstatus-'));
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

test('parseNameStatus: single modified file', () => {
	const raw = 'M\0src/app.ts\0';
	const files = parseNameStatus(raw);
	assert.equal(files.length, 1);
	assert.equal(files[0]!.path, 'src/app.ts');
	assert.equal(files[0]!.status, 'modified');
});

test('parseNameStatus: multiple files mixed statuses', () => {
	const raw = 'M\0src/a.ts\0A\0src/b.ts\0D\0src/c.ts\0';
	const files = parseNameStatus(raw);
	assert.equal(files.length, 3);
	assert.equal(files[0]!.status, 'modified');
	assert.equal(files[1]!.status, 'added');
	assert.equal(files[2]!.status, 'deleted');
});

test('parseNameStatus: rename with from + to', () => {
	const raw = 'R100\0src/old.ts\0src/new.ts\0';
	const files = parseNameStatus(raw);
	assert.equal(files.length, 1);
	assert.equal(files[0]!.path, 'src/new.ts');
	assert.equal(files[0]!.status, 'renamed');
	assert.equal(files[0]!.from, 'src/old.ts');
});

test('parseNameStatus: copy with from + to', () => {
	const raw = 'C75\0src/source.ts\0src/copy.ts\0';
	const files = parseNameStatus(raw);
	assert.equal(files.length, 1);
	assert.equal(files[0]!.status, 'copied');
	assert.equal(files[0]!.from, 'src/source.ts');
});

test('parseNameStatus: empty input -> empty list', () => {
	assert.equal(parseNameStatus('').length, 0);
});

test('mapStatusLetter: covers all known + unknown', () => {
	assert.equal(mapStatusLetter('M'), 'modified');
	assert.equal(mapStatusLetter('A'), 'added');
	assert.equal(mapStatusLetter('D'), 'deleted');
	assert.equal(mapStatusLetter('R'), 'renamed');
	assert.equal(mapStatusLetter('C'), 'copied');
	assert.equal(mapStatusLetter('Z'), 'unknown');
});

// ---------------------------------------------------------------------------
// End-to-end against a real git repo
// ---------------------------------------------------------------------------

test('git-status: real repo with uncommitted modification', async () => {
	const dir = setup();
	try {
		git(dir, 'init', '-q');
		git(dir, 'config', 'user.email', 'test@example.com');
		git(dir, 'config', 'user.name',  'Test');
		writeFileSync(join(dir, 'a.txt'), 'hello\n');
		git(dir, 'add', 'a.txt');
		git(dir, 'commit', '-q', '-m', 'initial');
		writeFileSync(join(dir, 'a.txt'), 'hello modified\n');
		writeFileSync(join(dir, 'b.txt'), 'new file\n');
		git(dir, 'add', 'b.txt');

		const { result } = await runSkillIsolated<{ repoPath: string }, {
			ref: string;
			files: { path: string; status: string }[];
			truncated: boolean;
		}>(
			'code.repo.git-status',
			{ repoPath: dir },
			{},
		);
		assert.equal(result.value.ref, 'HEAD');
		const paths = result.value.files.map(f => f.path).sort();
		assert.deepEqual(paths, ['a.txt', 'b.txt']);
		const aFile = result.value.files.find(f => f.path === 'a.txt')!;
		const bFile = result.value.files.find(f => f.path === 'b.txt')!;
		assert.equal(aFile.status, 'modified');
		assert.equal(bFile.status, 'added');
		assert.equal(result.confidence, 'high');
	} finally {
		teardown(dir);
	}
});

test('git-status: refuses non-absolute repoPath', async () => {
	setup();
	const { result } = await runSkillIsolated<{ repoPath: string }, unknown>(
		'code.repo.git-status',
		{ repoPath: 'relative/path' },
		{},
	);
	assert.equal(result.confidence, 'low');
	assert.ok(result.notes.some(n => n.includes('absolute')));
});

test('git-status: non-git directory -> low confidence with git error', async () => {
	const dir = setup();
	try {
		const { result } = await runSkillIsolated<{ repoPath: string }, unknown>(
			'code.repo.git-status',
			{ repoPath: dir },
			{},
		);
		assert.equal(result.confidence, 'low');
		assert.ok(result.notes.some(n => n.includes('git diff failed')));
	} finally {
		teardown(dir);
	}
});

test('git-status: clean repo (no changes) -> empty files + medium confidence', async () => {
	const dir = setup();
	try {
		git(dir, 'init', '-q');
		git(dir, 'config', 'user.email', 'test@example.com');
		git(dir, 'config', 'user.name',  'Test');
		writeFileSync(join(dir, 'a.txt'), 'hello\n');
		git(dir, 'add', 'a.txt');
		git(dir, 'commit', '-q', '-m', 'initial');
		// no further changes

		const { result } = await runSkillIsolated<{ repoPath: string }, {
			files: unknown[];
		}>(
			'code.repo.git-status',
			{ repoPath: dir },
			{},
		);
		assert.equal(result.value.files.length, 0);
		assert.equal(result.confidence, 'medium');
		assert.ok(result.notes.some(n => n.includes('no changes')));
	} finally {
		teardown(dir);
	}
});

// silence unused
void mkdirSync;
