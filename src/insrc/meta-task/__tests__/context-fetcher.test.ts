/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Context-fetcher tests.
 *
 * Two layers:
 *   1. Driver-level (fulfill): exercises the `sufficient` short-circuit and the
 *      request-loop / meta tally with fetchers that hit disk.
 *   2. Per-slot fetchers: covers the deterministic fetchers (files, deliverable,
 *      trace, git) against tmp dirs / scripted catalogs. DB-backed slots
 *      (entities, semantic, graph, memory) are tested through the orchestrator
 *      smoke test in M2; here we only sanity-check the shape they return.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { fulfill } from '../context-fetcher.js';
import {
	fetchDeliverable,
	fetchFiles,
	fetchTrace,
	fetchGit,
	type FetchInputs,
} from '../fetchers.js';
import type { DeliverableCatalog, Phase1Ask, ScopeManifest } from '../types.js';


function scopeFor(repoPath: string): ScopeManifest {
	return {
		intent:          'test',
		repoPath,
		inScopeGlobs:    ['**'],
		outOfScopePaths: [],
	};
}

const noEmbed = async (): Promise<number[]> => [];


// ---------------------------------------------------------------------------
// Driver-level
// ---------------------------------------------------------------------------

test('fulfill: sufficient short-circuits to null', async () => {
	const ask: Phase1Ask = { kind: 'sufficient' };
	const r = await fulfill(ask, {
		scope:   scopeFor('/tmp/empty'),
		catalog: [],
		embed:   noEmbed,
	});
	assert.equal(r, null);
});

test('fulfill: meta tally counts chunks + dropped requests', async () => {
	// One request to a missing deliverable -> needs-narrowing chunk; not error.
	const ask: Phase1Ask = {
		kind: 'context-needed',
		requests: [{ kind: 'deliverable', specId: 'missing' }],
	};
	const r = await fulfill(ask, {
		scope:   scopeFor('/tmp/empty'),
		catalog: [],
		embed:   noEmbed,
	});
	assert.ok(r !== null);
	assert.equal(r.chunks.length, 1);
	assert.equal(r.chunks[0]!.status, 'needs-narrowing');
	assert.equal(r.meta.droppedRequests, 0);  // narrowing is not an error
});


// ---------------------------------------------------------------------------
// fetchDeliverable
// ---------------------------------------------------------------------------

function fetchInputs(scope: ScopeManifest, catalog: DeliverableCatalog, byteCap = 50 * 1024): FetchInputs {
	return { scope, catalog, byteCap, embed: noEmbed };
}

test('fetchDeliverable: returns ok with body when catalog matches', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'mt-deliverable-'));
	const file = join(dir, 'deliv.md');
	writeFileSync(file, '# Title\n\nBody text here.\n\n## Section A\n\nA content.\n');
	const catalog: DeliverableCatalog = [
		{ id: 'spec-1', label: 'Test', headings: ['Title', 'Section A'], bytes: 100, absPath: file },
	];
	const chunk = await fetchDeliverable(
		{ kind: 'deliverable', specId: 'spec-1' },
		fetchInputs(scopeFor(dir), catalog),
	);
	assert.equal(chunk.status, 'ok');
	const payload = chunk.payload as { body: string };
	assert.ok(payload.body.includes('Body text here'));
});

test('fetchDeliverable: heading slice returns just that section', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'mt-deliverable-'));
	const file = join(dir, 'deliv.md');
	writeFileSync(file, '# Title\n\n## A\n\nA body\n\n## B\n\nB body\n');
	const catalog: DeliverableCatalog = [
		{ id: 'spec-1', label: 'Test', headings: ['Title', 'A', 'B'], bytes: 100, absPath: file },
	];
	const chunk = await fetchDeliverable(
		{ kind: 'deliverable', specId: 'spec-1', heading: 'A' },
		fetchInputs(scopeFor(dir), catalog),
	);
	assert.equal(chunk.status, 'ok');
	const payload = chunk.payload as { body: string };
	assert.ok(payload.body.includes('A body'));
	assert.ok(!payload.body.includes('B body'));
});

test('fetchDeliverable: missing specId -> needs-narrowing with catalog list', async () => {
	const catalog: DeliverableCatalog = [
		{ id: 'spec-1', label: 'Test', headings: ['Title'], bytes: 0, absPath: '/dev/null' },
	];
	const chunk = await fetchDeliverable(
		{ kind: 'deliverable', specId: 'missing' },
		fetchInputs(scopeFor('/tmp'), catalog),
	);
	assert.equal(chunk.status, 'needs-narrowing');
	assert.ok(chunk.narrowingHint !== undefined);
	const hint = chunk.narrowingHint!;
	assert.ok(hint.suggestedFilters!.some(f => f.includes('spec-1')));
});

test('fetchDeliverable: missing heading -> needs-narrowing with heading list', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'mt-deliverable-'));
	const file = join(dir, 'deliv.md');
	writeFileSync(file, '# Title\n');
	const catalog: DeliverableCatalog = [
		{ id: 'spec-1', label: 'Test', headings: ['Title'], bytes: 0, absPath: file },
	];
	const chunk = await fetchDeliverable(
		{ kind: 'deliverable', specId: 'spec-1', heading: 'NoSuch' },
		fetchInputs(scopeFor(dir), catalog),
	);
	assert.equal(chunk.status, 'needs-narrowing');
});


// ---------------------------------------------------------------------------
// fetchFiles
// ---------------------------------------------------------------------------

test('fetchFiles: ok within cap, payload carries content', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'mt-files-'));
	mkdirSync(join(dir, 'src'));
	writeFileSync(join(dir, 'src/a.ts'), 'export const A = 1;\n');
	writeFileSync(join(dir, 'src/b.ts'), 'export const B = 2;\n');
	const chunk = await fetchFiles(
		{ kind: 'files', globs: ['src/*.ts'] },
		fetchInputs(scopeFor(dir), []),
	);
	assert.equal(chunk.status, 'ok');
	const payload = chunk.payload as { path: string; content: string }[];
	assert.equal(payload.length, 2);
	const paths = payload.map(p => p.path).sort();
	assert.deepEqual(paths, ['src/a.ts', 'src/b.ts']);
});

test('fetchFiles: empty on no match', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'mt-files-'));
	const chunk = await fetchFiles(
		{ kind: 'files', globs: ['nothing/**/*.xyz'] },
		fetchInputs(scopeFor(dir), []),
	);
	assert.equal(chunk.status, 'empty');
});

test('fetchFiles: respects out-of-scope paths', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'mt-files-'));
	mkdirSync(join(dir, 'src'));
	mkdirSync(join(dir, 'vendor'));
	writeFileSync(join(dir, 'src/a.ts'), 'export const A = 1;\n');
	writeFileSync(join(dir, 'vendor/lib.ts'), 'export const X = 0;\n');
	const scope: ScopeManifest = {
		intent:          'test',
		repoPath:        dir,
		inScopeGlobs:    ['**'],
		outOfScopePaths: ['vendor'],
	};
	const chunk = await fetchFiles(
		{ kind: 'files', globs: ['**/*.ts'] },
		fetchInputs(scope, []),
	);
	assert.equal(chunk.status, 'ok');
	const payload = chunk.payload as { path: string }[];
	assert.equal(payload.length, 1);
	assert.equal(payload[0]!.path, join('src', 'a.ts'));
});

test('fetchFiles: byte cap -> partial', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'mt-files-'));
	mkdirSync(join(dir, 'src'));
	const big = 'x'.repeat(500);
	writeFileSync(join(dir, 'src/a.ts'), big);
	writeFileSync(join(dir, 'src/b.ts'), big);
	writeFileSync(join(dir, 'src/c.ts'), big);
	const chunk = await fetchFiles(
		{ kind: 'files', globs: ['src/*.ts'] },
		fetchInputs(scopeFor(dir), [], 800),     // cap is 800; two files fit
	);
	assert.equal(chunk.status, 'partial');
	const payload = chunk.payload as { path: string }[];
	assert.ok(payload.length < 3);
});

test('fetchFiles: too broad -> needs-narrowing', async () => {
	// Build a scope with many small files across > 3 top-level dirs.
	const dir = mkdtempSync(join(tmpdir(), 'mt-files-'));
	for (const top of ['src', 'lib', 'cli', 'tools']) {
		mkdirSync(join(dir, top));
		writeFileSync(join(dir, top, 'f.ts'), 'x');
	}
	const chunk = await fetchFiles(
		{ kind: 'files', globs: ['**/*.ts'] },
		fetchInputs(scopeFor(dir), [], 10_000),
	);
	assert.equal(chunk.status, 'needs-narrowing');
	assert.ok(chunk.narrowingHint !== undefined);
});


// ---------------------------------------------------------------------------
// fetchTrace
// ---------------------------------------------------------------------------

test('fetchTrace: missing spec -> needs-narrowing', async () => {
	const chunk = await fetchTrace(
		{ kind: 'trace', specId: 'definitely-not-a-real-spec-id-xyz-12345' },
		fetchInputs(scopeFor('/tmp'), []),
	);
	assert.equal(chunk.status, 'needs-narrowing');
});


// ---------------------------------------------------------------------------
// fetchGit
// ---------------------------------------------------------------------------

function initRepo(dir: string): void {
	const run = (args: string[]) => spawnSync('git', args, { cwd: dir });
	run(['init', '-q']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name',  'Meta-task Fetcher Test']);
	run(['config', 'commit.gpgsign', 'false']);
	writeFileSync(join(dir, 'a.txt'), 'hello\n');
	run(['add', '.']);
	run(['commit', '-q', '-m', 'init commit']);
}

test('fetchGit: returns recent commits', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'mt-git-'));
	initRepo(dir);
	const chunk = await fetchGit(
		{ kind: 'git' },
		fetchInputs(scopeFor(dir), []),
	);
	assert.equal(chunk.status, 'ok');
	const payload = chunk.payload as { hash: string; subject: string }[];
	assert.equal(payload.length, 1);
	assert.equal(payload[0]!.subject, 'init commit');
});
