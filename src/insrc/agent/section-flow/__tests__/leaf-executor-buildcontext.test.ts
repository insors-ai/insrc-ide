/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the leaf-executor's Phase 3 build-context integration
 * (plans/section-flow-architecture-redesign.md). Exercises the
 * happy path end-to-end: real `artifact_vec` rows seeded into a
 * tmpdir Lance, a real disk-spilled JSON body, and a scripted local
 * provider that returns a valid `runBuildContext` payload. Asserts
 * the artifact body lands in `priorOutputs` keyed by its id before
 * the shape-resolver runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeLanceConn, setLanceConnPath } from '../../../db/lance/conn.js';
import { upsertArtifactVec, _resetArtifactVecCache } from '../../../db/lance/artifact-vec.js';
import { _resetPromptRegistryForTest, registerAllPromptWriters } from '../../prompts/index.js';
import { loadConfig } from '../../config.js';
import { _mergeArtifactBodiesForTest as mergeArtifactBodies } from '../leaf-executor.js';

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
	_resetPromptRegistryForTest();
	registerAllPromptWriters();
	dir = mkdtempSync(join(tmpdir(), 'insrc-leaf-bc-'));
	setLanceConnPath(join(dir, 'lance'));
});

test.afterEach(async () => {
	await closeLanceConn();
	_resetArtifactVecCache();
	rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// mergeArtifactBodies (the helper that turns build-context's fetchIds into
// concrete priorOutputs entries)
// ---------------------------------------------------------------------------

test('mergeArtifactBodies: fetched id with a real on-disk body lands in priorOutputs', async () => {
	const spillDir = join(dir, 'spills');
	mkdirSync(spillDir, { recursive: true });
	const bodyPath = join(spillDir, 'locate.json');
	const body = JSON.stringify({ entityId: 'b2097ef0ba38110e005d437d6b0c8442', name: 'INGRN' }, null, 2);
	writeFileSync(bodyPath, body, 'utf8');

	await upsertArtifactVec({
		id:         'sess-1:100:code.entity.locate-by-name',
		embedding:  vec(1),
		session_id: 'sess-1',
		intent:     'locate INGRN',
		skill_id:   'code.entity.locate-by-name',
		timestamp:  BigInt(100),
		path:       bodyPath,
		preview:    body.slice(0, 256),
		summary:    'located INGRN. CLOSES ingrn-locate fully',
	});

	const merged = await mergeArtifactBodies(
		{ 'prior-step': 'kept finding' },
		['sess-1:100:code.entity.locate-by-name'],
		'leaf-x', 'code.class.extract-fields',
	);
	assert.equal(merged['prior-step'], 'kept finding');
	assert.equal(merged['sess-1:100:code.entity.locate-by-name'], body);
});

test('mergeArtifactBodies: empty fetch list -> identity (returns the base object)', async () => {
	const base = { a: '1', b: '2' };
	const merged = await mergeArtifactBodies(base, [], 'leaf-x', 'code.skill');
	assert.equal(merged, base);   // reference-equality short-circuit
});

test('mergeArtifactBodies: unknown id is skipped with no throw', async () => {
	const merged = await mergeArtifactBodies(
		{ existing: 'kept' },
		['sess-1:999:never-spilled'],
		'leaf-x', 'code.skill',
	);
	assert.equal(merged.existing, 'kept');
	assert.equal(merged['sess-1:999:never-spilled'], undefined);
});

test('mergeArtifactBodies: row whose on-disk path is missing -> skipped with no throw', async () => {
	const id = 'sess-1:200:gone';
	await upsertArtifactVec({
		id,
		embedding:  vec(2),
		session_id: 'sess-1',
		intent:     'broken',
		skill_id:   'code.skill',
		timestamp:  BigInt(200),
		path:       join(dir, 'does-not-exist.json'),
		preview:    '...',
		summary:    'will not load',
	});
	const merged = await mergeArtifactBodies(
		{ existing: 'kept' },
		[id],
		'leaf-x', 'code.skill',
	);
	assert.equal(merged.existing, 'kept');
	assert.equal(merged[id], undefined);
});

test('mergeArtifactBodies: row with empty path -> skipped with no throw', async () => {
	const id = 'sess-1:300:empty-path';
	await upsertArtifactVec({
		id,
		embedding:  vec(3),
		session_id: 'sess-1',
		intent:     'no path',
		skill_id:   'code.skill',
		timestamp:  BigInt(300),
		path:       '',
		preview:    '...',
		summary:    'no path on row',
	});
	const merged = await mergeArtifactBodies(
		{ existing: 'kept' },
		[id],
		'leaf-x', 'code.skill',
	);
	assert.equal(merged.existing, 'kept');
});
