/**
 * Tests for the shared "DB empty -> read the file" fallback helper.
 *
 * Background: YAML / Dockerfile / shell-script files are indexed as
 * `kind: 'file'` graph entities with no body and no embedding. Skills
 * that look those up would otherwise return empty. The helper reads
 * the file from disk, bounded and safe-by-default, so the calling
 * skill can return a meaningful excerpt instead of a blank.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	tryReadFileForFallback,
	DEFAULT_MAX_FILE_BYTES,
	DEFAULT_MAX_LINES,
} from '../built-ins/_fallback-file-read.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function withTmp(fn: (dir: string) => Promise<void> | void): () => Promise<void> {
	return async () => {
		const dir = mkdtempSync(join(tmpdir(), 'insrc-fallback-test-'));
		try { await fn(dir); }
		finally { rmSync(dir, { recursive: true, force: true }); }
	};
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('tryReadFileForFallback: reads small text file', withTmp(async (dir) => {
	const path = join(dir, 'Dockerfile');
	writeFileSync(path, 'FROM python:3.11\nWORKDIR /app\nCOPY . .\nCMD ["python", "main.py"]\n');
	const result = await tryReadFileForFallback(path);
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.match(result.content, /FROM python:3.11/);
		assert.equal(result.truncated, false);
	}
}));

test('tryReadFileForFallback: returns byteSize on success', withTmp(async (dir) => {
	const path = join(dir, 'config.yaml');
	const body = 'key: value\nnested:\n  - a\n  - b\n';
	writeFileSync(path, body);
	const result = await tryReadFileForFallback(path);
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.byteSize, body.length);
	}
}));

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

test('tryReadFileForFallback: caps at maxBytes when file larger', withTmp(async (dir) => {
	const path = join(dir, 'big.yaml');
	writeFileSync(path, 'x: 1\n'.repeat(1000));  // 5000 bytes
	const result = await tryReadFileForFallback(path, 200);  // 200-byte cap
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.truncated, true);
		assert.match(result.content, /<truncated>$/);
	}
}));

test('tryReadFileForFallback: caps at maxLines when file has more lines', withTmp(async (dir) => {
	const path = join(dir, 'long.txt');
	const lines = Array.from({ length: 500 }, (_, i) => `line-${i}`).join('\n');
	writeFileSync(path, lines);
	const result = await tryReadFileForFallback(path, DEFAULT_MAX_FILE_BYTES, 10);
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.truncated, true);
		assert.match(result.content, /line-0/);
		// 10 lines kept + truncation marker; line-10 must NOT appear
		assert.equal(result.content.includes('line-10\n'), false);
	}
}));

// ---------------------------------------------------------------------------
// Refuse cases
// ---------------------------------------------------------------------------

test('tryReadFileForFallback: empty path -> not ok', async () => {
	const result = await tryReadFileForFallback('');
	assert.equal(result.ok, false);
});

test('tryReadFileForFallback: relative path refused', async () => {
	const result = await tryReadFileForFallback('not/absolute/path.txt');
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.reason, /not absolute/);
});

test('tryReadFileForFallback: missing file -> not ok', async () => {
	const result = await tryReadFileForFallback('/tmp/does-not-exist-9999.yaml');
	assert.equal(result.ok, false);
});

test('tryReadFileForFallback: empty file -> not ok (no useful excerpt)', withTmp(async (dir) => {
	const path = join(dir, 'empty.txt');
	writeFileSync(path, '');
	const result = await tryReadFileForFallback(path);
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.reason, /empty/);
}));

test('tryReadFileForFallback: directory path -> not ok', withTmp(async (dir) => {
	const result = await tryReadFileForFallback(dir);
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.reason, /not a regular file/);
}));

test('tryReadFileForFallback: binary file (NUL byte) refused', withTmp(async (dir) => {
	const path = join(dir, 'binary.bin');
	const buf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02]);  // ELF-ish header w/ NUL
	writeFileSync(path, buf);
	const result = await tryReadFileForFallback(path);
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.reason, /binary/);
}));

test('tryReadFileForFallback: huge file refused at stat layer (sanity cap)', withTmp(async (dir) => {
	// Build a file larger than 64x DEFAULT_MAX_FILE_BYTES (== 1 MB).
	// Use repeated tiny content to keep the test fast.
	const path = join(dir, 'huge.txt');
	writeFileSync(path, 'x'.repeat(DEFAULT_MAX_FILE_BYTES * 64 + 100));
	const result = await tryReadFileForFallback(path);
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.reason, /too large/);
}));

// ---------------------------------------------------------------------------
// Defaults pinned
// ---------------------------------------------------------------------------

test('defaults: DEFAULT_MAX_FILE_BYTES is 16 KB', () => {
	assert.equal(DEFAULT_MAX_FILE_BYTES, 16 * 1024);
});

test('defaults: DEFAULT_MAX_LINES is 200', () => {
	assert.equal(DEFAULT_MAX_LINES, 200);
});
