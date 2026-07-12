/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc workflow chain` — status + next-action decision tree tests.
 *
 * Seeds various on-disk states (no Define / unapproved Define /
 * approved Define + no HLD / approved HLD + no LLD / stale LLD /
 * pending amendment / all approved) and asserts the returned
 * next-action.
 *
 * Run:
 *   npx tsx --test src/insrc/workflow/__tests__/chain.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { approveArtifactByJsonPath } from '../gates.js';
import { defineArtifactPaths, hldArtifactPaths, lldArtifactPaths } from '../storage.js';
import { buildChainReport, formatChainReport } from '../chain.js';
import { computeHldEffectiveHash } from '../artifacts/lld.js';
import { proposeAmendment } from '../amendments/store.js';
import type { AmendmentRecord } from '../amendments/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function writeDefine(repo: string, slug: string, opts: { stories: string[] } = { stories: ['s1', 's2'] }): string {
	const paths = defineArtifactPaths(repo, slug);
	mkdirSync(join(repo, 'docs/defines'), { recursive: true });
	writeFileSync(paths.json, JSON.stringify({
		meta: { workflow: 'define', runId: 'def-1', schemaVersion: 1 },
		body: {
			flavor: 'enhancement',
			problem: 'x', nonGoals: [], assumptions: [], constraints: [],
			stories: opts.stories.map(id => ({
				id, title: `Story ${id}`, userValue: 'v', acceptanceCriteria: [],
			})),
			openQuestions: [],
		},
		citations: [],
	}, null, 2));
	return paths.json;
}

function writeHld(repo: string, slug: string, runId: string): { path: string; runId: string } {
	const paths = hldArtifactPaths(repo, slug);
	mkdirSync(paths.dir, { recursive: true });
	writeFileSync(paths.json, JSON.stringify({
		meta: { workflow: 'design.epic', runId, schemaVersion: 1 },
		body: {
			frameworkSummary: 'x', architectureShape: 'x',
			sharedContracts: [],
			storyBoundaries: [{ storyId: 's1', owns: [], depends: [], internal: 'x' }, { storyId: 's2', owns: [], depends: [], internal: 'x' }],
			nonFunctional: {},
			rolloutOverview: { phases: [], orderingRationale: '', riskyBits: [] },
			alternativesConsidered: [], chosenAlternative: '', openQuestions: [],
		},
		citations: [],
	}, null, 2));
	return { path: paths.json, runId };
}

function writeLld(repo: string, slug: string, storyId: string, hldRunId: string, effectiveHash: string): string {
	const paths = lldArtifactPaths(repo, slug, storyId);
	writeFileSync(paths.json, JSON.stringify({
		meta: {
			workflow: 'design.story', runId: `lld-${storyId}`, schemaVersion: 1,
			epicSlug: slug, storyId,
			hldBaseRunId: hldRunId, hldEffectiveHash: effectiveHash, hldAmendmentsApplied: [],
		},
		body: {
			hldContextSlice: {}, contractDetails: { surfaceLevel: 'internal', api: [] },
			dataModelChanges: [], interactionWithShared: [],
			errorPaths: { errorCases: [], edgeCases: [], invariantsToPreserve: [] },
			testStrategy: { testLevels: [], acceptanceMapping: [], testFramework: 'x' },
			alternativesConsidered: [], chosenAlternative: 'a1', openQuestions: [],
		},
		citations: [],
	}, null, 2));
	return paths.json;
}

function pendingAmendment(slug: string, id: string, baseRunId: string): AmendmentRecord {
	return {
		id, epicSlug: slug, hldBaseRunId: baseRunId,
		amendment: {
			type: 'sharedContract.fieldAdd', contractId: 'sc1',
			field: { name: 'x', type: 'string', optional: true, purpose: 'x' }, breaking: false,
		},
		rationale: 'x', citations: [],
		proposedBy: { workflow: 'design.story', runId: 'lld-1', storyId: 's1', stepId: 's4' },
		proposedAt: new Date().toISOString(),
		status: 'pending',
	};
}

// ---------------------------------------------------------------------------
// Decision tree
// ---------------------------------------------------------------------------

test('chain: no artifacts → next-action run-define', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-chain-'));
	try {
		const r = buildChainReport(repo, 'no-op');
		assert.equal(r.nextAction.kind, 'run-define');
		assert.equal(r.define.exists, false);
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('chain: unapproved Define → approve-define', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-chain-'));
	try {
		writeDefine(repo, 'x');
		const r = buildChainReport(repo, 'x');
		assert.equal(r.nextAction.kind, 'approve-define');
		assert.equal(r.define.exists, true);
		assert.equal(r.define.approved, false);
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('chain: approved Define, no HLD → run-hld', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-chain-'));
	try {
		const path = writeDefine(repo, 'x');
		approveArtifactByJsonPath(path);
		const r = buildChainReport(repo, 'x');
		assert.equal(r.nextAction.kind, 'run-hld');
		assert.equal(r.define.approved, true);
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('chain: unapproved HLD → approve-hld', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-chain-'));
	try {
		approveArtifactByJsonPath(writeDefine(repo, 'x'));
		writeHld(repo, 'x', 'hld-1');
		const r = buildChainReport(repo, 'x');
		assert.equal(r.nextAction.kind, 'approve-hld');
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('chain: approved HLD, no LLDs → run-lld for first Story', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-chain-'));
	try {
		approveArtifactByJsonPath(writeDefine(repo, 'x'));
		approveArtifactByJsonPath(writeHld(repo, 'x', 'hld-1').path);
		const r = buildChainReport(repo, 'x');
		assert.equal(r.nextAction.kind, 'run-lld');
		if (r.nextAction.kind === 'run-lld') {
			assert.equal(r.nextAction.storyId, 's1');
		}
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('chain: unapproved LLD blocks the chain → approve-lld', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-chain-'));
	try {
		approveArtifactByJsonPath(writeDefine(repo, 'x'));
		approveArtifactByJsonPath(writeHld(repo, 'x', 'hld-1').path);
		const hash = computeHldEffectiveHash('hld-1', []);
		writeLld(repo, 'x', 's1', 'hld-1', hash);
		const r = buildChainReport(repo, 'x');
		assert.equal(r.nextAction.kind, 'approve-lld');
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('chain: pending amendment surfaces before further LLDs', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-chain-'));
	try {
		approveArtifactByJsonPath(writeDefine(repo, 'x'));
		approveArtifactByJsonPath(writeHld(repo, 'x', 'hld-1').path);
		// Pending amendment on Epic before LLD runs.
		mkdirSync(join(repo, 'docs/designs/x/_hld-amendments'), { recursive: true });
		proposeAmendment(repo, pendingAmendment('x', 'amend-x-1', 'hld-1'));
		const r = buildChainReport(repo, 'x');
		assert.equal(r.nextAction.kind, 'review-amendment');
		assert.equal(r.amendments.pending, 1);
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('chain: all Stories approved, no tracker → push-tracker', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-chain-'));
	try {
		approveArtifactByJsonPath(writeDefine(repo, 'x', { stories: ['s1'] }));
		approveArtifactByJsonPath(writeHld(repo, 'x', 'hld-1').path);
		const hash = computeHldEffectiveHash('hld-1', []);
		approveArtifactByJsonPath(writeLld(repo, 'x', 's1', 'hld-1', hash));
		const r = buildChainReport(repo, 'x');
		assert.equal(r.nextAction.kind, 'push-tracker');
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

test('formatChainReport prints all section headers', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-chain-'));
	try {
		const r = buildChainReport(repo, 'x');
		const md = formatChainReport(r);
		assert.ok(md.includes('# Chain status: x'));
		assert.ok(md.includes('## Define'));
		assert.ok(md.includes('## HLD'));
		assert.ok(md.includes('## Amendments'));
		assert.ok(md.includes('## Tracker'));
		assert.ok(md.includes('## Next action'));
	} finally { rmSync(repo, { recursive: true, force: true }); }
});
