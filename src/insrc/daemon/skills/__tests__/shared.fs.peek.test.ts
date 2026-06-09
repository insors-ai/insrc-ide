/**
 * Tests for `shared.fs.peek`.
 *
 * Covers pure helpers (clampLines, clampBytes, looksBinary) + end-to-end
 * against synthetic files:
 *   - head mode (default) returns first N lines
 *   - tail mode returns last N lines
 *   - line cap hit -> truncated true
 *   - byte cap hit -> truncated true + totalLines omitted
 *   - binary file -> encoding 'binary' + empty content
 *   - rejection of non-absolute path / non-file path
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSkillIsolated } from '../test-harness.js';
import { _resetSkillRegistryForTests } from '../registry.js';
import { _resetRegistryForTests } from '../../tools/registry.js';
import { registerAllSkills } from '../index.js';
import { registerSkillTools } from '../../tools/builtins/skills/invoke-skill.js';
import {
	_clampLinesForTest as clampLines,
	_clampBytesForTest as clampBytes,
	_looksBinaryForTest as looksBinary,
} from '../built-ins/shared.fs.peek.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup(): string {
	_resetSkillRegistryForTests();
	_resetRegistryForTests();
	registerAllSkills();
	registerSkillTools();
	return mkdtempSync(join(tmpdir(), 'insrc-peek-test-'));
}

function teardown(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

interface PeekOutput { content: string; truncated: boolean; totalBytes: number; totalLines?: number; encoding: 'utf-8' | 'binary'; }

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('clampLines: undefined -> default', () => {
	assert.equal(clampLines(undefined), 50);
});

test('clampLines: caps at max', () => {
	assert.equal(clampLines(99_999), 500);
});

test('clampBytes: undefined -> default', () => {
	assert.equal(clampBytes(undefined), 8192);
});

test('clampBytes: caps at max', () => {
	assert.equal(clampBytes(10_000_000), 65_536);
});

test('looksBinary: NUL byte triggers binary detection', () => {
	const buf = Buffer.from([0x68, 0x69, 0x00, 0x6f]);   // "hi\0o"
	assert.equal(looksBinary(buf), true);
});

test('looksBinary: clean ASCII text -> not binary', () => {
	const buf = Buffer.from('hello\nworld\ntab\there\n', 'utf-8');
	assert.equal(looksBinary(buf), false);
});

test('looksBinary: empty buffer -> not binary', () => {
	assert.equal(looksBinary(Buffer.alloc(0)), false);
});

test('looksBinary: dense non-printable bytes -> binary', () => {
	// 60 bytes of 0x01..0x1f (control chars), 40 bytes of printable
	const bytes: number[] = [];
	for (let i = 0; i < 60; i++) { bytes.push(0x01); }
	for (let i = 0; i < 40; i++) { bytes.push(0x41); }   // 'A'
	assert.equal(looksBinary(Buffer.from(bytes)), true);
});

// ---------------------------------------------------------------------------
// End-to-end
// ---------------------------------------------------------------------------

test('peek: head mode reads first N lines (default head:true)', async () => {
	const dir = setup();
	try {
		const path = join(dir, 'sample.txt');
		const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
		writeFileSync(path, lines.join('\n') + '\n');

		const { result } = await runSkillIsolated<{ path: string; lines: number }, PeekOutput>(
			'shared.fs.peek',
			{ path, lines: 5 },
			{},
		);
		const out = result.value;
		assert.equal(out.encoding, 'utf-8');
		assert.equal(out.truncated, true);
		const returnedLines = out.content.split('\n');
		assert.equal(returnedLines[0], 'line-0');
		assert.equal(returnedLines.length, 5);
	} finally {
		teardown(dir);
	}
});

test('peek: tail mode (head:false) reads last N lines', async () => {
	const dir = setup();
	try {
		const path = join(dir, 'log.txt');
		const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
		writeFileSync(path, lines.join('\n') + '\n');

		const { result } = await runSkillIsolated<{ path: string; head: boolean; lines: number }, PeekOutput>(
			'shared.fs.peek',
			{ path, head: false, lines: 3 },
			{},
		);
		const out = result.value;
		// Tail should contain the last few lines.
		assert.ok(out.content.includes('line-19'));
		assert.ok(out.content.includes('line-18'));
		assert.ok(!out.content.includes('line-0'));
	} finally {
		teardown(dir);
	}
});

test('peek: small text file fully read -> truncated false, totalLines populated', async () => {
	const dir = setup();
	try {
		const path = join(dir, 'small.txt');
		writeFileSync(path, 'one\ntwo\nthree\n');

		const { result } = await runSkillIsolated<{ path: string }, PeekOutput>(
			'shared.fs.peek',
			{ path },
			{},
		);
		const out = result.value;
		assert.equal(out.truncated, false);
		assert.equal(out.encoding, 'utf-8');
		assert.equal(out.totalLines, 4);   // "one", "two", "three", "" (trailing newline)
		assert.match(out.content, /one\ntwo\nthree/);
	} finally {
		teardown(dir);
	}
});

test('peek: byte cap hit -> totalLines omitted (partial read)', async () => {
	const dir = setup();
	try {
		const path = join(dir, 'big.txt');
		writeFileSync(path, 'x'.repeat(20_000));

		const { result } = await runSkillIsolated<{ path: string; bytes: number }, PeekOutput>(
			'shared.fs.peek',
			{ path, bytes: 100 },
			{},
		);
		const out = result.value;
		assert.equal(out.truncated, true);
		assert.equal(out.totalBytes, 20_000);
		assert.equal(out.totalLines, undefined);
		assert.equal(out.content.length, 100);
	} finally {
		teardown(dir);
	}
});

test('peek: binary file -> encoding "binary", empty content', async () => {
	const dir = setup();
	try {
		const path = join(dir, 'binary.bin');
		const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0xff, 0xfe, 0x00]);
		writeFileSync(path, buf);

		const { result } = await runSkillIsolated<{ path: string }, PeekOutput>(
			'shared.fs.peek',
			{ path },
			{},
		);
		const out = result.value;
		assert.equal(out.encoding, 'binary');
		assert.equal(out.content, '');
		assert.equal(out.truncated, true);
	} finally {
		teardown(dir);
	}
});

test('peek: refuses non-absolute path', async () => {
	setup();
	const { result } = await runSkillIsolated<{ path: string }, PeekOutput>(
		'shared.fs.peek',
		{ path: 'relative/file.txt' },
		{},
	);
	assert.equal(result.confidence, 'low');
	assert.ok(result.notes.some(n => n.includes('absolute')));
});

test('peek: refuses directory path', async () => {
	const dir = setup();
	try {
		mkdirSync(join(dir, 'sub'));
		const { result } = await runSkillIsolated<{ path: string }, PeekOutput>(
			'shared.fs.peek',
			{ path: join(dir, 'sub') },
			{},
		);
		assert.equal(result.confidence, 'low');
		assert.ok(result.notes.some(n => n.includes('not a regular file')));
	} finally {
		teardown(dir);
	}
});

test('peek: rejects non-existent path', async () => {
	const dir = setup();
	try {
		const { result } = await runSkillIsolated<{ path: string }, PeekOutput>(
			'shared.fs.peek',
			{ path: join(dir, 'does-not-exist.txt') },
			{},
		);
		assert.equal(result.confidence, 'low');
		assert.ok(result.notes.some(n => n.includes('stat failed')));
	} finally {
		teardown(dir);
	}
});
