/**
 * Tests for file-detect.ts -- file/directory path detection in the
 * data-analyzer's ephemeral-connection bootstrap.
 *
 * Coverage:
 *   - Single-file detection (explicit path, with extension)
 *   - Directory walks aggregate by kind:
 *       * dirs with >= DIR_COLLAPSE_MIN_FILES files of the same kind
 *         emit ONE directory-group ephemeral (isDirectory: true)
 *       * dirs with < threshold files of a given kind emit per-file
 *         ephemerals as before
 *       * mixed-kind dirs emit one group per qualifying kind
 *   - Hidden files / node_modules skipped
 *   - Stable connection ids across calls
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectFilePaths } from '../file-detect.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function mkScratch(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'file-detect-'));
	return {
		dir,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

function writeFiles(dirAbs: string, names: readonly string[]): void {
	mkdirSync(dirAbs, { recursive: true });
	for (const name of names) {
		writeFileSync(join(dirAbs, name), '{}');
	}
}

// ---------------------------------------------------------------------------
// Single-file detection
// ---------------------------------------------------------------------------

test('detectFilePaths: explicit .json file -> single ephemeral', () => {
	const { dir, cleanup } = mkScratch();
	try {
		writeFiles(dir, ['customers.json']);
		const out = detectFilePaths(`describe ${dir}/customers.json`, dir);
		assert.equal(out.length, 1);
		assert.equal(out[0]!.kind, 'json');
		assert.equal(out[0]!.isDirectory, undefined);
		assert.equal(out[0]!.absPath, join(dir, 'customers.json'));
	} finally {
		cleanup();
	}
});

test('detectFilePaths: nonexistent path -> dropped', () => {
	const { dir, cleanup } = mkScratch();
	try {
		const out = detectFilePaths(`look at ${dir}/missing.json`, dir);
		assert.equal(out.length, 0);
	} finally {
		cleanup();
	}
});

// ---------------------------------------------------------------------------
// Directory aggregation (the main fix)
// ---------------------------------------------------------------------------

test('detectFilePaths: dir with N >= 2 same-kind files -> one directory-group entry', () => {
	const { dir, cleanup } = mkScratch();
	try {
		writeFiles(dir, ['a.json', 'b.json', 'c.json']);
		const out = detectFilePaths(`analyze ${dir}`, dir);
		assert.equal(out.length, 1, 'expected 1 directory-group entry, got per-file ephemerals');
		assert.equal(out[0]!.isDirectory, true);
		assert.equal(out[0]!.kind, 'json');
		assert.equal(out[0]!.memberCount, 3);
		assert.equal(out[0]!.absPath, dir);
		// The connection id encodes the kind so a sibling dir with .csv
		// files would get a distinct id.
		assert.match(out[0]!.connectionId, /-json-/);
	} finally {
		cleanup();
	}
});

test('detectFilePaths: dir with 1 file of a kind -> per-file ephemeral (below threshold)', () => {
	const { dir, cleanup } = mkScratch();
	try {
		writeFiles(dir, ['only-one.json']);
		const out = detectFilePaths(`analyze ${dir}`, dir);
		// One file -> below DIR_COLLAPSE_MIN_FILES; keep per-file
		assert.equal(out.length, 1);
		assert.equal(out[0]!.isDirectory, undefined);
		assert.match(out[0]!.absPath, /only-one\.json$/);
	} finally {
		cleanup();
	}
});

test('detectFilePaths: mixed-kind dir -> one group per qualifying kind', () => {
	const { dir, cleanup } = mkScratch();
	try {
		writeFiles(dir, ['a.json', 'b.json', 'c.json', 'data.csv', 'more.csv']);
		const out = detectFilePaths(`analyze ${dir}`, dir);
		assert.equal(out.length, 2, 'expected one group per kind');
		const byKind = new Map(out.map(e => [e.kind, e]));
		assert.ok(byKind.has('json'));
		assert.ok(byKind.has('csv'));
		assert.equal(byKind.get('json')!.isDirectory, true);
		assert.equal(byKind.get('json')!.memberCount, 3);
		assert.equal(byKind.get('csv')!.isDirectory,  true);
		assert.equal(byKind.get('csv')!.memberCount,  2);
	} finally {
		cleanup();
	}
});

test('detectFilePaths: mixed-kind dir, one kind below threshold -> per-file for that kind', () => {
	const { dir, cleanup } = mkScratch();
	try {
		writeFiles(dir, ['a.json', 'b.json', 'c.json', 'lonely.csv']);
		const out = detectFilePaths(`analyze ${dir}`, dir);
		assert.equal(out.length, 2);
		const byKind = new Map(out.map(e => [e.kind, e]));
		assert.equal(byKind.get('json')!.isDirectory, true);
		assert.equal(byKind.get('json')!.memberCount, 3);
		assert.equal(byKind.get('csv')!.isDirectory, undefined,
			'single .csv should be a per-file ephemeral, not a group');
	} finally {
		cleanup();
	}
});

test('detectFilePaths: stable connection id across calls (no timestamps)', () => {
	const { dir, cleanup } = mkScratch();
	try {
		writeFiles(dir, ['a.json', 'b.json']);
		const out1 = detectFilePaths(`analyze ${dir}`, dir);
		const out2 = detectFilePaths(`analyze ${dir}`, dir);
		assert.equal(out1.length, 1);
		assert.equal(out2.length, 1);
		assert.equal(out1[0]!.connectionId, out2[0]!.connectionId);
	} finally {
		cleanup();
	}
});

test('detectFilePaths: hidden files skipped in directory walk', () => {
	const { dir, cleanup } = mkScratch();
	try {
		writeFiles(dir, ['.hidden.json', '.config.json', 'real-a.json', 'real-b.json']);
		const out = detectFilePaths(`analyze ${dir}`, dir);
		assert.equal(out.length, 1);
		assert.equal(out[0]!.memberCount, 2, '.hidden* files should be excluded');
	} finally {
		cleanup();
	}
});

test('detectFilePaths: node_modules subdir not recursed', () => {
	const { dir, cleanup } = mkScratch();
	try {
		writeFiles(dir, ['a.json', 'b.json']);
		// Plant node_modules with json files that should NOT be counted.
		writeFiles(join(dir, 'node_modules'), ['package.json', 'lockfile.json']);
		const out = detectFilePaths(`analyze ${dir}`, dir);
		assert.equal(out.length, 1);
		assert.equal(out[0]!.memberCount, 2, 'node_modules entries should be excluded');
	} finally {
		cleanup();
	}
});

// ---------------------------------------------------------------------------
// Sibling subdir handling -- DIR_WALK_MAX_DEPTH = 1
// ---------------------------------------------------------------------------

test('detectFilePaths: nested subdir files DO get counted at depth=1', () => {
	const { dir, cleanup } = mkScratch();
	try {
		writeFiles(dir, ['top1.json']);
		writeFiles(join(dir, 'sub'), ['nested1.json', 'nested2.json']);
		const out = detectFilePaths(`analyze ${dir}`, dir);
		// Three .json files visible at depth 0+1 -> single directory group.
		assert.equal(out.length, 1);
		assert.equal(out[0]!.memberCount, 3);
	} finally {
		cleanup();
	}
});
