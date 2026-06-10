/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Focused tests for the orchestrator's `persistStepSummaries` helper
 * -- Phase 1 batch 3d of plans/section-flow-architecture-redesign.md.
 *
 * Lives in its own file (separate from `todo-orchestrator.test.ts`)
 * because it needs an end-to-end Lance fixture: spin up a temp Lance
 * conn, seed `artifact_vec` rows, run the helper, and verify each
 * row's `summary` field updated through the live
 * `updateArtifactSummary` path. The pure-fixture orchestrator tests
 * in the sibling file don't need Lance and would slow down if we
 * shared `beforeEach`.
 *
 * Covers:
 *   - Happy path: stepSummaries[stepId][callId] -> summary lands on
 *     the right `<sessionId>:<ts>:<skillId>` row.
 *   - Mismatched (stepId, callId) tuples: silently skip; never throw.
 *   - Unknown artifact id (e.g. a call that never spilled): silently
 *     skip via `updateArtifactSummary`'s soft-fail behaviour.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeLanceConn, setLanceConnPath } from '../../../db/lance/conn.js';
import {
	upsertArtifactVec,
	getArtifactById,
	_resetArtifactVecCache,
} from '../../../db/lance/artifact-vec.js';
import { loadConfig } from '../../config.js';
import { _persistStepSummariesForTest as persistStepSummaries } from '../todo-orchestrator.js';

const DIM = loadConfig().models.providers.local.embeddingDim;
let dir: string;

function vec(seed: number): Float32Array {
	const v = new Float32Array(DIM);
	for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed * (i + 1) * 0.001) * 0.1;
	return v;
}

test.beforeEach(async () => {
	await closeLanceConn();
	_resetArtifactVecCache();
	dir = mkdtempSync(join(tmpdir(), 'insrc-orchestrator-persist-'));
	setLanceConnPath(join(dir, 'lance'));
});

test.afterEach(async () => {
	await closeLanceConn();
	_resetArtifactVecCache();
	rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('persistStepSummaries: writes reviewer summary to matching artifact_vec row', async () => {
	const aId = 's:100:code.class.extract-fields';
	const bId = 's:200:data.source.file.sample-shape';
	await upsertArtifactVec({
		id: aId, embedding: vec(1), session_id: 's', intent: 'i',
		skill_id: 'code.class.extract-fields', timestamp: BigInt(100),
		path: '/p', preview: 'noisy preview a',
	});
	await upsertArtifactVec({
		id: bId, embedding: vec(2), session_id: 's', intent: 'i',
		skill_id: 'data.source.file.sample-shape', timestamp: BigInt(200),
		path: '/p', preview: 'noisy preview b',
	});

	const stepSummaries = {
		'step-1': { 's1.a': 'INGRN has 21 fields. CLOSES ingrn-fields fully' },
		'step-2': { 's2.a': 'sampled one row. PARTIALLY supports json-shape' },
	};
	const cycleArtifactIds = {
		'step-1': { 's1.a': aId },
		'step-2': { 's2.a': bId },
	};

	await persistStepSummaries(stepSummaries, cycleArtifactIds);

	const rowA = await getArtifactById(aId);
	const rowB = await getArtifactById(bId);
	assert.equal(rowA?.summary, 'INGRN has 21 fields. CLOSES ingrn-fields fully');
	assert.equal(rowB?.summary, 'sampled one row. PARTIALLY supports json-shape');
});

// ---------------------------------------------------------------------------
// Quiet skips
// ---------------------------------------------------------------------------

test('persistStepSummaries: skips entries with no matching artifact id (call never spilled)', async () => {
	const seeded = 's:100:code.class.extract-fields';
	await upsertArtifactVec({
		id: seeded, embedding: vec(1), session_id: 's', intent: 'i',
		skill_id: 'code.class.extract-fields', timestamp: BigInt(100),
		path: '/p', preview: 'seeded',
	});

	const stepSummaries = {
		'step-1': {
			's1.a': 'CLOSES ingrn-fields fully',     // matches the seeded id
			's1.b': 'OFF-TOPIC',                     // no artifact id -> skip
		},
		'step-2': { 's2.a': 'PARTIALLY supports json-shape' },   // entire step missing
	};
	const cycleArtifactIds = {
		'step-1': { 's1.a': seeded },               // s1.b absent intentionally
		// step-2 absent intentionally
	};

	await persistStepSummaries(stepSummaries, cycleArtifactIds);

	const row = await getArtifactById(seeded);
	assert.equal(row?.summary, 'CLOSES ingrn-fields fully');
});

test('persistStepSummaries: empty stepSummaries -> noop, never throws', async () => {
	await persistStepSummaries({}, { 'step-1': { 's1.a': 'sess:1:s' } });
	// No assertion needed beyond "did not throw".
});

test('persistStepSummaries: artifact id absent from Lance -> soft-fail via updateArtifactSummary', async () => {
	// No seeded rows. updateArtifactSummary returns false; persist swallows it.
	const stepSummaries = { 'step-1': { 's1.a': 'CLOSES ingrn-fields fully' } };
	const cycleArtifactIds = { 'step-1': { 's1.a': 'sess-x:999:made-up' } };
	await persistStepSummaries(stepSummaries, cycleArtifactIds);
	// Confirm nothing was created behind our back.
	assert.equal(await getArtifactById('sess-x:999:made-up'), null);
});
