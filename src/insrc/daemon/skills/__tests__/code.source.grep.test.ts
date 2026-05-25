/**
 * Tests for `code.source.grep` (Plan 4 Phase 1a).
 *
 * The skill prefers ripgrep when available and falls back to a
 * node walker. Tests exercise both the pure parsing helpers
 * (parseRipgrepOutput) and the end-to-end fallback path against
 * a synthetic fixture filesystem.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSkillIsolated } from '../test-harness.js';
import { _resetSkillRegistryForTests } from '../registry.js';
import { _resetRegistryForTests } from '../../tools/registry.js';
import { registerAllSkills } from '../index.js';
import { registerSkillTools } from '../../tools/builtins/skills/invoke-skill.js';
import {
	_parseRipgrepOutputForTest as parseRipgrepOutput,
	_clampMaxHitsForTest        as clampMaxHits,
	_truncateSnippetForTest     as truncateSnippet,
} from '../built-ins/code.source.grep.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup(): string {
	_resetSkillRegistryForTests();
	_resetRegistryForTests();
	registerAllSkills();
	registerSkillTools();
	return mkdtempSync(join(tmpdir(), 'insrc-grep-test-'));
}

function teardown(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// parseRipgrepOutput
// ---------------------------------------------------------------------------

test('parseRipgrepOutput: parses canonical lines', () => {
	const stdout = [
		'/repo/src/foo.ts:42:export function foo() {',
		'/repo/src/bar.ts:7:import { foo } from "./foo"',
	].join('\n') + '\n';
	const hits = parseRipgrepOutput(stdout, 10);
	assert.equal(hits.length, 2);
	assert.equal(hits[0]!.file, '/repo/src/foo.ts');
	assert.equal(hits[0]!.line, 42);
	assert.match(hits[0]!.snippet, /export function foo/);
});

test('parseRipgrepOutput: caps at maxHits', () => {
	const lines: string[] = [];
	for (let i = 1; i <= 20; i++) {
		lines.push(`/repo/a.ts:${i}:line-${i}`);
	}
	const hits = parseRipgrepOutput(lines.join('\n'), 5);
	assert.equal(hits.length, 5);
});

test('parseRipgrepOutput: skips malformed lines (no second colon)', () => {
	const hits = parseRipgrepOutput('garbage\n/repo/x.ts:10:valid\n', 10);
	assert.equal(hits.length, 1);
	assert.equal(hits[0]!.file, '/repo/x.ts');
});

test('parseRipgrepOutput: skips non-numeric line numbers', () => {
	const hits = parseRipgrepOutput('/repo/x.ts:notanumber:content\n', 10);
	assert.equal(hits.length, 0);
});

test('parseRipgrepOutput: empty input -> empty hits', () => {
	assert.equal(parseRipgrepOutput('', 10).length, 0);
});

// ---------------------------------------------------------------------------
// clampMaxHits + truncateSnippet
// ---------------------------------------------------------------------------

test('clampMaxHits: default when undefined / negative / NaN', () => {
	assert.equal(clampMaxHits(undefined), 30);
	assert.equal(clampMaxHits(0), 30);
	assert.equal(clampMaxHits(-5), 30);
	assert.equal(clampMaxHits(Number.NaN), 30);
});

test('clampMaxHits: caps at ceiling (200)', () => {
	assert.equal(clampMaxHits(500), 200);
	assert.equal(clampMaxHits(50),  50);
});

test('truncateSnippet: trims trailing whitespace', () => {
	assert.equal(truncateSnippet('hello   \n'), 'hello');
});

test('truncateSnippet: truncates long lines at 200 chars + ...', () => {
	const long = 'x'.repeat(300);
	const out = truncateSnippet(long);
	assert.ok(out.length <= 203);
	assert.ok(out.endsWith('...'));
});

// ---------------------------------------------------------------------------
// End-to-end against the fallback walker (no ripgrep dependency)
// ---------------------------------------------------------------------------

test('grep: finds literal matches via fallback walker', async () => {
	const dir = setup();
	try {
		mkdirSync(join(dir, 'src'));
		writeFileSync(join(dir, 'src', 'app.ts'),  'import { foo } from "./foo"\nfoo();\n');
		writeFileSync(join(dir, 'src', 'foo.ts'),  'export function foo() {}\n');
		writeFileSync(join(dir, 'README.md'),      '# project\nuses foo and bar\n');

		const { result } = await runSkillIsolated<{ path: string; pattern: string }, {
			hits: { file: string; line: number; snippet: string }[];
			truncated: boolean;
			searched: number;
		}>(
			'code.source.grep',
			{ path: dir, pattern: 'foo' },
			{},
		);
		const value = result.value;
		// At least 3 matches across the 3 files (1, 2, 1) -- depending on
		// regex behaviour the count varies, but it should be >= 3.
		assert.ok(value.hits.length >= 3);
		// All hits live under the test dir.
		for (const h of value.hits) {
			assert.ok(h.file.startsWith(dir), `unexpected file: ${h.file}`);
		}
	} finally {
		teardown(dir);
	}
});

test('grep: refuses non-absolute path', async () => {
	setup();
	const { result } = await runSkillIsolated<{ path: string; pattern: string }, unknown>(
		'code.source.grep',
		{ path: 'relative/path', pattern: 'foo' },
		{},
	);
	assert.equal(result.confidence, 'low');
	assert.ok(result.notes.some(n => n.includes('absolute')));
});

test('grep: refuses empty pattern', async () => {
	const dir = setup();
	try {
		const { result } = await runSkillIsolated<{ path: string; pattern: string }, unknown>(
			'code.source.grep',
			{ path: dir, pattern: '' },
			{},
		);
		assert.equal(result.confidence, 'low');
		assert.ok(result.notes.some(n => n.includes('pattern')));
	} finally {
		teardown(dir);
	}
});

test('grep: non-existent path -> low confidence', async () => {
	setup();
	const { result } = await runSkillIsolated<{ path: string; pattern: string }, unknown>(
		'code.source.grep',
		{ path: '/tmp/insrc-grep-does-not-exist-9999', pattern: 'foo' },
		{},
	);
	assert.equal(result.confidence, 'low');
});

test('grep: excludes node_modules / .git by default', async () => {
	const dir = setup();
	try {
		mkdirSync(join(dir, 'node_modules'));
		writeFileSync(join(dir, 'node_modules', 'dep.ts'), 'foo from node_modules\n');
		mkdirSync(join(dir, 'src'));
		writeFileSync(join(dir, 'src', 'app.ts'),          'foo from src\n');

		const { result } = await runSkillIsolated<{ path: string; pattern: string }, {
			hits: { file: string; line: number; snippet: string }[];
			truncated: boolean;
			searched: number;
		}>(
			'code.source.grep',
			{ path: dir, pattern: 'foo' },
			{},
		);
		// node_modules hit must be absent.
		assert.ok(!result.value.hits.some(h => h.file.includes('node_modules')));
		// src hit must be present.
		assert.ok(result.value.hits.some(h => h.file.includes('src/app.ts')));
	} finally {
		teardown(dir);
	}
});

test('grep: no matches -> empty hits + medium confidence', async () => {
	const dir = setup();
	try {
		writeFileSync(join(dir, 'a.ts'), 'no match here\n');
		const { result } = await runSkillIsolated<{ path: string; pattern: string }, {
			hits: unknown[];
		}>(
			'code.source.grep',
			{ path: dir, pattern: 'zzzNonexistentToken' },
			{},
		);
		assert.equal(result.value.hits.length, 0);
		assert.ok(['low', 'medium'].includes(result.confidence));
		assert.ok(result.notes.some(n => n.includes('no matches')));
	} finally {
		teardown(dir);
	}
});
