/**
 * Tests for the per-session TOC builder
 * (Phase 1 of plans/section-flow-architecture-redesign.md).
 *
 * Exercises:
 *   - newest-first ordering propagated from listArtifactsForSession
 *   - structural-summary fallback when the reviewer-emitted summary
 *     is empty
 *   - skillIdPrefix + afterTimestamp filters propagate
 *   - empty-session short-circuit
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeLanceConn, setLanceConnPath } from '../../../db/lance/conn.js';
import {
	upsertArtifactVec,
	upsertArtifactVecBatch,
	_resetArtifactVecCache,
} from '../../../db/lance/artifact-vec.js';
import { loadConfig } from '../../config.js';

import { buildToc, structuralSummary } from '../toc-builder.js';

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
	dir = mkdtempSync(join(tmpdir(), 'insrc-toc-builder-'));
	setLanceConnPath(join(dir, 'lance'));
});

test.afterEach(async () => {
	await closeLanceConn();
	_resetArtifactVecCache();
	rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

test('structuralSummary: short preview unchanged', () => {
	assert.equal(
		structuralSummary('code.class.extract-fields', 'hello world'),
		'code.class.extract-fields output: hello world',
	);
});

test('structuralSummary: truncates at 80 chars with ellipsis', () => {
	const preview = 'x'.repeat(200);
	const out = structuralSummary('shared.fs.peek', preview);
	assert.equal(out.startsWith('shared.fs.peek output: '), true);
	assert.equal(out.endsWith('...'), true);
});

test('structuralSummary: collapses whitespace', () => {
	const preview = '  multi\n\nline   text\t\twith   gaps  ';
	const out = structuralSummary('data.x', preview);
	assert.equal(out, 'data.x output: multi line text with gaps');
});

// ---------------------------------------------------------------------------
// End-to-end via real artifact_vec
// ---------------------------------------------------------------------------

test('buildToc: newest-first ordering carries over from artifact_vec', async () => {
	await upsertArtifactVecBatch([
		{ id: 's:100:older', embedding: vec(1), session_id: 's', intent: 'i', skill_id: 'a', timestamp: BigInt(100), path: '/p', preview: 'old',    summary: 'Summary OLD' },
		{ id: 's:300:newer', embedding: vec(2), session_id: 's', intent: 'i', skill_id: 'b', timestamp: BigInt(300), path: '/p', preview: 'new',    summary: 'Summary NEW' },
		{ id: 's:200:mid',   embedding: vec(3), session_id: 's', intent: 'i', skill_id: 'c', timestamp: BigInt(200), path: '/p', preview: 'mid',    summary: 'Summary MID' },
	]);
	const toc = await buildToc({ sessionId: 's' });
	assert.deepEqual(toc.entries.map(e => e.id), ['s:300:newer', 's:200:mid', 's:100:older']);
});

test('buildToc: uses structural fallback when reviewer summary is empty', async () => {
	await upsertArtifactVec({
		id:         's:1:no-summary',
		embedding:  vec(1),
		session_id: 's',
		intent:     'i',
		skill_id:   'shared.fs.list-files',
		timestamp:  BigInt(1),
		path:       '/p',
		preview:    '{"files": ["a.json", "b.json", "c.json"], "truncated": false}',
		// summary intentionally omitted
	});
	const toc = await buildToc({ sessionId: 's' });
	assert.equal(toc.entries.length, 1);
	assert.match(
		toc.entries[0]!.summary,
		/^shared\.fs\.list-files output: \{"files":/,
	);
});

test('buildToc: keeps explicit summary verbatim when present', async () => {
	await upsertArtifactVec({
		id:         's:1:summarized',
		embedding:  vec(1),
		session_id: 's',
		intent:     'i',
		skill_id:   'code.class.extract-fields',
		timestamp:  BigInt(1),
		path:       '/p',
		preview:    'noisy-preview',
		summary:    'INGRN: 21 fields; CLOSES gap "ingrn-fields" fully',
	});
	const toc = await buildToc({ sessionId: 's' });
	assert.equal(toc.entries[0]!.summary, 'INGRN: 21 fields; CLOSES gap "ingrn-fields" fully');
});

test('buildToc: skillIdPrefix filter propagates', async () => {
	await upsertArtifactVecBatch([
		{ id: 's:1:code', embedding: vec(1), session_id: 's', intent: 'i', skill_id: 'code.source.grep',           timestamp: BigInt(1), path: '/p', preview: 'x' },
		{ id: 's:2:data', embedding: vec(2), session_id: 's', intent: 'i', skill_id: 'data.source.file.describe', timestamp: BigInt(2), path: '/p', preview: 'x' },
	]);
	const codeOnly = await buildToc({ sessionId: 's', skillIdPrefix: 'code.' });
	assert.equal(codeOnly.entries.length, 1);
	assert.equal(codeOnly.entries[0]!.id, 's:1:code');
});

test('buildToc: afterTimestamp filter propagates (exclusive)', async () => {
	await upsertArtifactVecBatch([
		{ id: 's:50:before',  embedding: vec(1), session_id: 's', intent: 'i', skill_id: 'a', timestamp: BigInt(50),  path: '/p', preview: 'x' },
		{ id: 's:150:after',  embedding: vec(2), session_id: 's', intent: 'i', skill_id: 'a', timestamp: BigInt(150), path: '/p', preview: 'x' },
	]);
	const recent = await buildToc({ sessionId: 's', afterTimestamp: BigInt(100) });
	assert.equal(recent.entries.length, 1);
	assert.equal(recent.entries[0]!.id, 's:150:after');
});

test('buildToc: empty sessionId returns empty entries', async () => {
	const toc = await buildToc({ sessionId: '' });
	assert.deepEqual(toc.entries, []);
});
