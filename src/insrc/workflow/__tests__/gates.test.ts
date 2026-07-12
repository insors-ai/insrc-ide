/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Approval / rejection gate helpers.
 *
 * Run:
 *   npx tsx --test src/insrc/workflow/__tests__/gates.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	approveArtifactByJsonPath,
	ArtifactMissingError,
	ArtifactNotApprovedError,
	jsonPathForMd,
	rejectArtifactByJsonPath,
	requireApprovedEpic,
} from '../gates.js';

// ---------------------------------------------------------------------------
// jsonPathForMd
// ---------------------------------------------------------------------------

test('jsonPathForMd swaps md → json', () => {
	assert.equal(jsonPathForMd('/a/b/c.md'), '/a/b/c.json');
});

test('jsonPathForMd returns json paths unchanged', () => {
	assert.equal(jsonPathForMd('/a/b/c.json'), '/a/b/c.json');
});

test('jsonPathForMd rejects unknown extensions', () => {
	assert.throws(() => jsonPathForMd('/a/b/c.txt'));
});

// ---------------------------------------------------------------------------
// approve / reject round-trip
// ---------------------------------------------------------------------------

function writeFixture(repo: string): string {
	mkdirSync(join(repo, 'docs/defines'), { recursive: true });
	const path = join(repo, 'docs/defines/x.json');
	writeFileSync(path, JSON.stringify({
		meta: { workflow: 'define', runId: 'r1' },
		body: { flavor: 'new-capability', problem: 'x', nonGoals: [], assumptions: [], constraints: [], stories: [{ id: 's1', title: 't', userValue: 'v', acceptanceCriteria: [] }], openQuestions: [] },
		citations: [],
	}, null, 2));
	return path;
}

test('approveArtifactByJsonPath sets meta.approvedAt', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-gate-'));
	try {
		const path = writeFixture(repo);
		const r = approveArtifactByJsonPath(path);
		assert.equal(r.workflow, 'define');
		assert.match(r.approvedAt, /^\d{4}-\d{2}-\d{2}T/);
		const raw = JSON.parse(readFileSync(path, 'utf8'));
		assert.ok(raw.meta.approvedAt);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('rejectArtifactByJsonPath sets meta.rejectedAt + reason', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-gate-'));
	try {
		const path = writeFixture(repo);
		const r = rejectArtifactByJsonPath(path, 'not enough stories');
		assert.equal(r.workflow, 'define');
		const raw = JSON.parse(readFileSync(path, 'utf8'));
		assert.equal(raw.meta.rejectReason, 'not enough stories');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('rejectArtifactByJsonPath refuses empty reason', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-gate-'));
	try {
		const path = writeFixture(repo);
		assert.throws(() => rejectArtifactByJsonPath(path, ''));
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('reject then approve clears the rejection', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-gate-'));
	try {
		const path = writeFixture(repo);
		rejectArtifactByJsonPath(path, 'try again');
		approveArtifactByJsonPath(path);
		const raw = JSON.parse(readFileSync(path, 'utf8'));
		assert.ok(raw.meta.approvedAt);
		assert.equal(raw.meta.rejectedAt, undefined);
		assert.equal(raw.meta.rejectReason, undefined);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// requireApprovedEpic
// ---------------------------------------------------------------------------

test('requireApprovedEpic throws ArtifactMissingError when no Define exists', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-gate-'));
	try {
		assert.throws(
			() => requireApprovedEpic(repo, 'missing-slug'),
			(err: Error) => err instanceof ArtifactMissingError,
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('requireApprovedEpic throws ArtifactNotApprovedError when Define is not approved', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-gate-'));
	try {
		writeFixture(repo);   // writes docs/defines/x.json
		assert.throws(
			() => requireApprovedEpic(repo, 'x'),
			(err: Error) => err instanceof ArtifactNotApprovedError,
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('requireApprovedEpic returns the Define artifact after approval', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-gate-'));
	try {
		const path = writeFixture(repo);
		approveArtifactByJsonPath(path);
		const epic = requireApprovedEpic(repo, 'x');
		assert.equal(epic.body.flavor, 'new-capability');
		assert.equal(epic.body.stories[0]!.id, 's1');
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
