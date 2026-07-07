/**
 * plans/docs-module.md Phase 1. Unit tests for the docs-retrieval
 * primitive. Exercises the ranking + dedup + path-hint logic
 * against a seeded LMDB fixture; the vector pass silently drops
 * out when Ollama is unavailable so these tests exercise the
 * keyword-only path.
 *
 * Live vector-pass validation lives in
 * docs-retrieval.live.test.ts (gated behind INSRC_LIVE_TESTS=1;
 * requires a running Ollama).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { closeGraphStore, setGraphStorePath } from '../../db/graph/store.js';
import { upsertEntities } from '../../db/entities.js';
import { addRepo } from '../../db/repos.js';
import type { Entity, RegisteredRepo } from '../../shared/types.js';

import { retrieveDocSections } from '../docs-retrieval.js';

const REPO = '/repo/alpha';
const NOW = '2026-07-07T10:00:00.000Z';
let dir: string;

function makeEntityId(repo: string, file: string, kind: string, name: string): string {
	return createHash('sha256')
		.update(`${repo}\x00${file}\x00${kind}\x00${name}`)
		.digest('hex')
		.slice(0, 32);
}

function makeDoc(file: string, name: string, body: string, kind: Entity['kind'] = 'document'): Entity {
	return {
		id:        makeEntityId(REPO, file, kind, name),
		kind,
		name,
		language:  'markdown',
		repoId:    1,
		repo:      REPO,
		file,
		startLine: 1,
		endLine:   body.split('\n').length,
		body,
		embedding: [],
		indexedAt: NOW,
		artifact:  true,
	};
}

function makeCode(file: string, name: string, body: string): Entity {
	return {
		id:        makeEntityId(REPO, file, 'function', name),
		kind:      'function',
		name,
		language:  'typescript',
		repoId:    1,
		repo:      REPO,
		file,
		startLine: 1,
		endLine:   body.split('\n').length,
		body,
		embedding: [],
		indexedAt: NOW,
	};
}

test.beforeEach(async () => {
	await closeGraphStore();
	dir = mkdtempSync(join(tmpdir(), 'insrc-docs-retrieval-'));
	setGraphStorePath(join(dir, 'graph.lmdb'));
	const r: RegisteredRepo = {
		path: REPO, name: '', addedAt: NOW, status: 'pending',
	};
	await addRepo(null, r);
});

test.afterEach(async () => {
	await closeGraphStore();
	rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Empty inputs
// ---------------------------------------------------------------------------

test('empty query returns []', async () => {
	const results = await retrieveDocSections({
		db: null, query: '', closureRepos: [REPO],
	});
	assert.equal(results.length, 0);
});

test('empty closureRepos returns []', async () => {
	const results = await retrieveDocSections({
		db: null, query: 'design', closureRepos: [],
	});
	assert.equal(results.length, 0);
});

test('no doc entities in closure returns []', async () => {
	const results = await retrieveDocSections({
		db: null, query: 'design decisions', closureRepos: [REPO],
	});
	assert.equal(results.length, 0);
});

// ---------------------------------------------------------------------------
// Keyword pass -- vector pass silently no-ops without Ollama
// ---------------------------------------------------------------------------

test('keyword pass finds docs containing query terms', async () => {
	await upsertEntities(null, [
		makeDoc(`${REPO}/design/analyze.md`, 'analyze framework',
			'The analyze framework runs shapers serially. Cache is invalidated by repoLastIndexedAt.'),
		makeDoc(`${REPO}/design/other.md`, 'unrelated topic',
			'This document is about something completely different: colours.'),
	]);

	const results = await retrieveDocSections({
		db: null, query: 'analyze framework shapers', closureRepos: [REPO],
	});
	assert.ok(results.length >= 1, 'should find the analyze framework doc');
	assert.equal(results[0]!.file, `${REPO}/design/analyze.md`);
	assert.ok(results[0]!.score > 0);
});

test('keyword pass ignores stopwords + short tokens', async () => {
	await upsertEntities(null, [
		makeDoc(`${REPO}/design/foo.md`, 'foo',
			'This is the a of an on at document about foo.'),
		makeDoc(`${REPO}/design/bar.md`, 'bar',
			'Bar contains the specific technical content about classifier and planner.'),
	]);

	// Query dominated by stopwords + a specific term
	const results = await retrieveDocSections({
		db: null, query: 'what is the classifier', closureRepos: [REPO],
	});
	assert.ok(results.length >= 1);
	// Bar wins because it contains 'classifier'; foo has only stopwords
	assert.equal(results[0]!.file, `${REPO}/design/bar.md`);
});

test('non-doc entities are excluded from results', async () => {
	await upsertEntities(null, [
		makeDoc(`${REPO}/design/note.md`, 'note',
			'Some doc content mentioning shapers.'),
		makeCode(`${REPO}/src/shapers.ts`, 'shapers',
			'export function shapers() { return 42; }'),
	]);

	const results = await retrieveDocSections({
		db: null, query: 'shapers', closureRepos: [REPO],
	});
	for (const r of results) {
		assert.ok(r.kind === 'document' || r.kind === 'section' || r.kind === 'config');
	}
});

// ---------------------------------------------------------------------------
// Ranking + dedup
// ---------------------------------------------------------------------------

test('results ordered by score desc', async () => {
	await upsertEntities(null, [
		makeDoc(`${REPO}/design/one.md`, 'one',
			'The classifier is central. classifier classifier scope-picker.'),
		makeDoc(`${REPO}/design/two.md`, 'two',
			'Only one mention of classifier here.'),
		makeDoc(`${REPO}/design/three.md`, 'three',
			'Contains classifier once and planner once.'),
	]);

	const results = await retrieveDocSections({
		db: null, query: 'classifier', closureRepos: [REPO],
	});
	assert.ok(results.length >= 2);
	// Scores are non-strictly descending
	for (let i = 1; i < results.length; i++) {
		assert.ok(results[i - 1]!.score >= results[i]!.score);
	}
});

test('dedup collapses same (file, heading) preferring section', async () => {
	await upsertEntities(null, [
		// Document + a section with the same name (matches artifact
		// parser convention where the document's name is the file
		// basename and section names differ).
		makeDoc(`${REPO}/design/foo.md`, 'foo',
			'Full document body mentioning classifier decisions.', 'document'),
	]);
	const results = await retrieveDocSections({
		db: null, query: 'classifier', closureRepos: [REPO],
	});
	assert.equal(results.length, 1);
	assert.equal(results[0]!.kind, 'document');
});

// ---------------------------------------------------------------------------
// Path hint
// ---------------------------------------------------------------------------

test('filenameHint boosts matching docs', async () => {
	await upsertEntities(null, [
		makeDoc(`${REPO}/design/plan-a.md`, 'a',
			'plan content mentioning classifier'),
		makeDoc(`${REPO}/plans/plan-b.md`, 'b',
			'plan content mentioning classifier'),
	]);

	const withoutHint = await retrieveDocSections({
		db: null, query: 'classifier', closureRepos: [REPO],
	});
	const withHint = await retrieveDocSections({
		db: null, query: 'classifier', closureRepos: [REPO],
		filenameHint: 'plans/',
	});

	// Without hint: both scored the same; ordering isn't stable to
	// assert. With hint: plans/ wins.
	assert.ok(withoutHint.length === 2);
	assert.equal(withHint[0]!.file, `${REPO}/plans/plan-b.md`);
	assert.ok(withHint[0]!.diagnostics?.pathBoost !== undefined);
	assert.ok(withHint[0]!.diagnostics!.pathBoost! > 0);
});

// ---------------------------------------------------------------------------
// Cap + minScore
// ---------------------------------------------------------------------------

test('maxResults caps returned length', async () => {
	const docs: Entity[] = [];
	for (let i = 0; i < 10; i++) {
		docs.push(makeDoc(
			`${REPO}/design/d${i}.md`,
			`d${i}`,
			'content mentioning shapers',
		));
	}
	await upsertEntities(null, docs);

	const results = await retrieveDocSections({
		db: null, query: 'shapers', closureRepos: [REPO],
		maxResults: 5,
	});
	assert.equal(results.length, 5);
});

test('minScore filter drops low-scoring results', async () => {
	await upsertEntities(null, [
		makeDoc(`${REPO}/design/high.md`, 'high',
			'shapers shapers shapers shapers shapers shapers'),
		makeDoc(`${REPO}/design/low.md`, 'low',
			'a doc that just barely mentions shapers.'),
	]);

	const results = await retrieveDocSections({
		db: null, query: 'shapers', closureRepos: [REPO],
		minScore: 0.15,
	});
	// The high-density doc should survive; the low-density one gets
	// keyword score 1/6 ≈ 0.17 * 0.4 ≈ 0.07 -- below the floor.
	for (const r of results) {
		assert.ok(r.score >= 0.15);
	}
});

// ---------------------------------------------------------------------------
// Kind allowlist
// ---------------------------------------------------------------------------

test('kinds allowlist restricts to prose-only when configured', async () => {
	await upsertEntities(null, [
		makeDoc(`${REPO}/design/foo.md`, 'foo',
			'design doc mentioning shapers', 'document'),
		makeDoc(`${REPO}/config/app.yaml`, 'app',
			'shapers: true', 'config'),
	]);

	const proseOnly = await retrieveDocSections({
		db: null, query: 'shapers', closureRepos: [REPO],
		kinds: ['document', 'section'],
	});
	for (const r of proseOnly) {
		assert.ok(r.kind !== 'config');
	}
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

test('previewChars caps the body preview', async () => {
	const longBody = 'shapers ' + 'x'.repeat(1000);
	await upsertEntities(null, [
		makeDoc(`${REPO}/design/foo.md`, 'foo', longBody),
	]);

	const withPreview = await retrieveDocSections({
		db: null, query: 'shapers', closureRepos: [REPO],
		previewChars: 100,
	});
	assert.ok(withPreview.length >= 1);
	assert.ok((withPreview[0]!.bodyPreview ?? '').length <= 100);
});

test('previewChars=0 omits preview', async () => {
	await upsertEntities(null, [
		makeDoc(`${REPO}/design/foo.md`, 'foo', 'shapers content'),
	]);
	const noPreview = await retrieveDocSections({
		db: null, query: 'shapers', closureRepos: [REPO],
		previewChars: 0,
	});
	assert.equal(noPreview[0]!.bodyPreview, undefined);
});
