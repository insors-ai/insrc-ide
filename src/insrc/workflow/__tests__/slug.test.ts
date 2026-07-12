/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Slug derivation + collision detection unit tests.
 *
 * Pure functional — no LLM, no I/O apart from filesystem probes
 * against tmp directories.
 *
 * Run:
 *   npx tsx --test src/insrc/workflow/__tests__/slug.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkCollision, deriveSlug } from '../slug.js';

test('deriveSlug drops stopwords + hyphenates the rest', () => {
	assert.equal(
		deriveSlug('Add rate limiting to the RPC layer'),
		'add-rate-limiting-rpc-layer',
	);
});

test('deriveSlug caps at MAX_TOKENS (6) distinctive words', () => {
	const slug = deriveSlug('one two three four five six seven eight');
	assert.equal(slug, 'one-two-three-four-five-six');
});

test('deriveSlug lowercases + strips punctuation', () => {
	assert.equal(
		deriveSlug('Fix the CLI!!! flag handling (broken since v1.2)'),
		'fix-cli-flag-handling-broken-since',
	);
});

test('deriveSlug rejects all-stopword focus', () => {
	assert.throws(() => deriveSlug('the a an is'));
});

test('deriveSlug rejects empty', () => {
	assert.throws(() => deriveSlug(''));
});

test('checkCollision returns the slug as-is when nothing conflicts', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'insrc-slug-'));
	try {
		const r = checkCollision(tmp, 'my-epic');
		assert.deepEqual(r, { slug: 'my-epic', conflicts: [], suggested: 'my-epic' });
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test('checkCollision reports conflicts + suggests -2 variant', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'insrc-slug-'));
	try {
		mkdirSync(join(tmp, 'docs/defines'), { recursive: true });
		writeFileSync(join(tmp, 'docs/defines/foo.md'), '');
		const r = checkCollision(tmp, 'foo');
		assert.deepEqual(r.conflicts, ['docs/defines/foo.md']);
		assert.equal(r.suggested, 'foo-2');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test('checkCollision walks past occupied variants', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'insrc-slug-'));
	try {
		mkdirSync(join(tmp, 'docs/defines'),   { recursive: true });
		mkdirSync(join(tmp, 'docs/designs/foo'), { recursive: true });
		writeFileSync(join(tmp, 'docs/defines/foo.md'), '');
		writeFileSync(join(tmp, 'docs/defines/foo-2.md'), '');
		const r = checkCollision(tmp, 'foo');
		assert.equal(r.suggested, 'foo-3');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});
