/**
 * Tests for `shared.fs.list-files`.
 *
 * Covers pure helpers (clampLimit, sortEntries, compileGlob, renderTree)
 * + end-to-end runs against a synthetic fixture tree.
 *
 * The end-to-end cases exercise:
 *   - flat list with default sort
 *   - pattern filter (glob)
 *   - recursive walk
 *   - sortBy 'mtime' returning the most-recent first
 *   - limit + truncation
 *   - tree render
 *   - rejection of non-absolute path
 *   - rejection of non-directory path
 *   - excluded dirs (node_modules) skipped under recursive
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSkillIsolated } from '../test-harness.js';
import { _resetSkillRegistryForTests } from '../registry.js';
import { _resetRegistryForTests } from '../../tools/registry.js';
import { registerAllSkills } from '../index.js';
import { registerSkillTools } from '../../tools/builtins/skills/invoke-skill.js';
import {
	_clampLimitForTest    as clampLimit,
	_sortEntriesForTest   as sortEntries,
	_compileGlobForTest   as compileGlob,
	_renderTreeForTest    as renderTree,
} from '../built-ins/shared.fs.list-files.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup(): string {
	_resetSkillRegistryForTests();
	_resetRegistryForTests();
	registerAllSkills();
	registerSkillTools();
	return mkdtempSync(join(tmpdir(), 'insrc-listfiles-test-'));
}

function teardown(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

interface ListedEntry { path: string; kind: 'file' | 'dir' | 'symlink'; size: number; modifiedAt: number; }
interface ListFilesOutput { files: ListedEntry[]; truncated: boolean; rendered?: string; }

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('clampLimit: undefined -> default', () => {
	assert.equal(clampLimit(undefined), 200);
});

test('clampLimit: zero / negative -> default', () => {
	assert.equal(clampLimit(0),  200);
	assert.equal(clampLimit(-5), 200);
});

test('clampLimit: caps at max', () => {
	assert.equal(clampLimit(99_999), 2000);
});

test('clampLimit: floors fractional', () => {
	assert.equal(clampLimit(10.7), 10);
});

test('sortEntries: by name (ascending)', () => {
	const out = sortEntries([
		{ path: '/a/c', kind: 'file', size: 1, modifiedAt: 1 },
		{ path: '/a/a', kind: 'file', size: 1, modifiedAt: 1 },
		{ path: '/a/b', kind: 'file', size: 1, modifiedAt: 1 },
	], 'name');
	assert.deepEqual(out.map(o => o.path), ['/a/a', '/a/b', '/a/c']);
});

test('sortEntries: by mtime (most-recent first)', () => {
	const out = sortEntries([
		{ path: '/a/old',    kind: 'file', size: 1, modifiedAt: 100 },
		{ path: '/a/recent', kind: 'file', size: 1, modifiedAt: 999 },
		{ path: '/a/mid',    kind: 'file', size: 1, modifiedAt: 500 },
	], 'mtime');
	assert.deepEqual(out.map(o => o.path), ['/a/recent', '/a/mid', '/a/old']);
});

test('sortEntries: by size (largest first)', () => {
	const out = sortEntries([
		{ path: '/a/small', kind: 'file', size: 10,  modifiedAt: 1 },
		{ path: '/a/big',   kind: 'file', size: 999, modifiedAt: 1 },
	], 'size');
	assert.equal(out[0]!.path, '/a/big');
});

test('compileGlob: anchored at both ends -- *.json matches foo.json but not foo.json.bak', () => {
	const m = compileGlob('*.json');
	assert.equal(m('foo.json'),     true);
	assert.equal(m('grn.json'),     true);
	assert.equal(m('foo.json.bak'), false);
	assert.equal(m('foo.jsona'),    false);
});

test('compileGlob: ? matches single char', () => {
	const m = compileGlob('foo?.ts');
	assert.equal(m('foo1.ts'), true);
	assert.equal(m('foo12.ts'), false);
});

test('compileGlob: charset [abc]', () => {
	const m = compileGlob('foo[12].txt');
	assert.equal(m('foo1.txt'), true);
	assert.equal(m('foo3.txt'), false);
});

test('compileGlob: literal dots escaped', () => {
	const m = compileGlob('file.txt');
	assert.equal(m('file.txt'), true);
	assert.equal(m('fileXtxt'), false);
});

test('renderTree: empty entry list -> placeholder', () => {
	const out = renderTree('/root', []);
	assert.match(out, /\(empty\)/);
});

test('renderTree: builds nested structure', () => {
	const out = renderTree('/root', [
		{ path: '/root/src/a.ts',     kind: 'file', size: 1, modifiedAt: 1 },
		{ path: '/root/src/b.ts',     kind: 'file', size: 1, modifiedAt: 1 },
		{ path: '/root/README.md',    kind: 'file', size: 1, modifiedAt: 1 },
	]);
	// root header
	assert.match(out, /^root\//m);
	// last-entry connector
	assert.match(out, /└──/);
	// not-last connector
	assert.match(out, /├──/);
	// a.ts AND b.ts both rendered
	assert.match(out, /a\.ts/);
	assert.match(out, /b\.ts/);
});

// ---------------------------------------------------------------------------
// End-to-end against fixture tree
// ---------------------------------------------------------------------------

test('list-files: flat list with default sort', async () => {
	const dir = setup();
	try {
		writeFileSync(join(dir, 'a.json'), '{}');
		writeFileSync(join(dir, 'b.txt'),  'hi');
		writeFileSync(join(dir, 'c.json'), '[]');

		const { result } = await runSkillIsolated<{ path: string }, ListFilesOutput>(
			'shared.fs.list-files',
			{ path: dir },
			{},
		);
		const paths = result.value.files.map(f => f.path).sort();
		assert.equal(result.value.files.length, 3);
		assert.equal(result.value.truncated, false);
		assert.deepEqual(paths, [join(dir, 'a.json'), join(dir, 'b.txt'), join(dir, 'c.json')].sort());
	} finally {
		teardown(dir);
	}
});

test('list-files: pattern filter -- only *.json', async () => {
	const dir = setup();
	try {
		writeFileSync(join(dir, 'a.json'),       '{}');
		writeFileSync(join(dir, 'b.txt'),        'hi');
		writeFileSync(join(dir, 'c.json'),       '[]');
		writeFileSync(join(dir, 'd.json.bak'),   '{}');   // must NOT match

		const { result } = await runSkillIsolated<{ path: string; pattern: string }, ListFilesOutput>(
			'shared.fs.list-files',
			{ path: dir, pattern: '*.json' },
			{},
		);
		const names = result.value.files.map(f => f.path.split('/').pop()).sort();
		assert.deepEqual(names, ['a.json', 'c.json']);
	} finally {
		teardown(dir);
	}
});

test('list-files: recursive walk descends subdirs', async () => {
	const dir = setup();
	try {
		mkdirSync(join(dir, 'sub'));
		writeFileSync(join(dir, 'top.json'),         '{}');
		writeFileSync(join(dir, 'sub', 'nested.json'), '{}');

		const { result } = await runSkillIsolated<{ path: string; pattern: string; recursive: boolean }, ListFilesOutput>(
			'shared.fs.list-files',
			{ path: dir, pattern: '*.json', recursive: true },
			{},
		);
		const paths = result.value.files.map(f => f.path).sort();
		assert.ok(paths.includes(join(dir, 'top.json')));
		assert.ok(paths.includes(join(dir, 'sub', 'nested.json')));
	} finally {
		teardown(dir);
	}
});

test('list-files: recursive walk skips node_modules', async () => {
	const dir = setup();
	try {
		mkdirSync(join(dir, 'node_modules'));
		mkdirSync(join(dir, 'node_modules', 'pkg'));
		writeFileSync(join(dir, 'wanted.json'),                          '{}');
		writeFileSync(join(dir, 'node_modules', 'pkg', 'unwanted.json'), '{}');

		const { result } = await runSkillIsolated<{ path: string; pattern: string; recursive: boolean }, ListFilesOutput>(
			'shared.fs.list-files',
			{ path: dir, pattern: '*.json', recursive: true },
			{},
		);
		const paths = result.value.files.map(f => f.path);
		assert.ok(paths.includes(join(dir, 'wanted.json')));
		assert.ok(!paths.some(p => p.includes('node_modules')), 'node_modules entries should be excluded');
	} finally {
		teardown(dir);
	}
});

test('list-files: sortBy mtime returns most-recent first', async () => {
	const dir = setup();
	try {
		writeFileSync(join(dir, 'old.json'),    '{}');
		writeFileSync(join(dir, 'recent.json'), '{}');
		// Force distinct mtimes -- the modification ordering can otherwise be
		// flat on fast filesystems with low timestamp resolution.
		utimesSync(join(dir, 'old.json'),    new Date(1_000_000_000_000), new Date(1_000_000_000_000));
		utimesSync(join(dir, 'recent.json'), new Date(2_000_000_000_000), new Date(2_000_000_000_000));

		const { result } = await runSkillIsolated<{ path: string; sortBy: 'mtime' }, ListFilesOutput>(
			'shared.fs.list-files',
			{ path: dir, sortBy: 'mtime' },
			{},
		);
		assert.equal(result.value.files[0]!.path, join(dir, 'recent.json'));
	} finally {
		teardown(dir);
	}
});

test('list-files: limit + truncated flag', async () => {
	const dir = setup();
	try {
		for (let i = 0; i < 10; i++) {
			writeFileSync(join(dir, `f${i}.json`), '{}');
		}
		const { result } = await runSkillIsolated<{ path: string; limit: number }, ListFilesOutput>(
			'shared.fs.list-files',
			{ path: dir, limit: 5 },
			{},
		);
		assert.equal(result.value.files.length, 5);
		assert.equal(result.value.truncated, true);
	} finally {
		teardown(dir);
	}
});

test('list-files: tree format populates `rendered`', async () => {
	const dir = setup();
	try {
		mkdirSync(join(dir, 'src'));
		writeFileSync(join(dir, 'src', 'a.ts'),  '');
		writeFileSync(join(dir, 'README.md'),    '');

		const { result } = await runSkillIsolated<{ path: string; recursive: boolean; format: 'tree' }, ListFilesOutput>(
			'shared.fs.list-files',
			{ path: dir, recursive: true, format: 'tree' },
			{},
		);
		assert.ok(typeof result.value.rendered === 'string');
		assert.match(result.value.rendered!, /a\.ts/);
		assert.match(result.value.rendered!, /README\.md/);
	} finally {
		teardown(dir);
	}
});

test('list-files: refuses non-absolute path', async () => {
	setup();
	const { result } = await runSkillIsolated<{ path: string }, ListFilesOutput>(
		'shared.fs.list-files',
		{ path: 'relative/path' },
		{},
	);
	assert.equal(result.confidence, 'low');
	assert.ok(result.notes.some(n => n.includes('absolute')));
});

test('list-files: refuses non-directory path', async () => {
	const dir = setup();
	try {
		const filePath = join(dir, 'a-file');
		writeFileSync(filePath, '');
		const { result } = await runSkillIsolated<{ path: string }, ListFilesOutput>(
			'shared.fs.list-files',
			{ path: filePath },
			{},
		);
		assert.equal(result.confidence, 'low');
		assert.ok(result.notes.some(n => n.includes('not a directory')));
	} finally {
		teardown(dir);
	}
});

test('list-files: empty directory -> empty list with confidence medium', async () => {
	const dir = setup();
	try {
		const { result } = await runSkillIsolated<{ path: string }, ListFilesOutput>(
			'shared.fs.list-files',
			{ path: dir },
			{},
		);
		assert.equal(result.value.files.length, 0);
		assert.equal(result.value.truncated, false);
		assert.equal(result.confidence, 'medium');
	} finally {
		teardown(dir);
	}
});
