/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Storage primitives — writeAtomic + artifact-path helpers.
 *
 * Run:
 *   npx tsx --test src/insrc/workflow/__tests__/storage.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	defineArtifactPaths,
	hldArtifactPaths,
	lldArtifactPaths,
	stubArtifactPaths,
	writeAtomic,
} from '../storage.js';

test('writeAtomic creates parent dirs + writes content', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'insrc-storage-'));
	try {
		const target = join(tmp, 'nested/dir/file.md');
		writeAtomic(target, 'hello world\n');
		assert.equal(readFileSync(target, 'utf8'), 'hello world\n');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test('writeAtomic overwrites existing file', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'insrc-storage-'));
	try {
		const target = join(tmp, 'a.md');
		writeAtomic(target, 'first\n');
		writeAtomic(target, 'second\n');
		assert.equal(readFileSync(target, 'utf8'), 'second\n');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test('writeAtomic refuses relative paths', () => {
	assert.throws(() => writeAtomic('not/absolute', 'x'));
});

test('writeAtomic refuses empty path', () => {
	assert.throws(() => writeAtomic('', 'x'));
});

test('stubArtifactPaths returns docs/stub layout', () => {
	const p = stubArtifactPaths('/repo', 'my-slug');
	assert.equal(p.md,   '/repo/docs/stub/my-slug.md');
	assert.equal(p.json, '/repo/docs/stub/my-slug.json');
});

test('defineArtifactPaths returns docs/defines layout', () => {
	const p = defineArtifactPaths('/repo', 'my-epic');
	assert.equal(p.md,   '/repo/docs/defines/my-epic.md');
	assert.equal(p.json, '/repo/docs/defines/my-epic.json');
});

test('hldArtifactPaths returns docs/designs/<slug>/_hld.*', () => {
	const p = hldArtifactPaths('/repo', 'my-epic');
	assert.equal(p.md,   '/repo/docs/designs/my-epic/_hld.md');
	assert.equal(p.json, '/repo/docs/designs/my-epic/_hld.json');
	assert.equal(p.dir,  '/repo/docs/designs/my-epic');
});

test('lldArtifactPaths returns docs/designs/<slug>/<storyId>.*', () => {
	const p = lldArtifactPaths('/repo', 'my-epic', 's3');
	assert.equal(p.md,   '/repo/docs/designs/my-epic/s3.md');
	assert.equal(p.json, '/repo/docs/designs/my-epic/s3.json');
});
