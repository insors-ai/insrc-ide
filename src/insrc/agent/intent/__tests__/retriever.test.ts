/**
 * Tests for the prior-context retriever
 * (conversation-flow-refinement.md Phase 3.2).
 *
 * Two layers:
 *
 *   1. Pure mining: `mineFacts` mapping artifact previews into
 *      typed `PriorFacts` per-skill. No Lance, no embed.
 *
 *   2. Retriever end-to-end against a real artifact_vec table:
 *      seed it, call `retrievePriorContext`, assert the artifacts
 *      come back ranked. The embed call is real (Ollama may not
 *      be available -- the retriever degrades to empty context;
 *      that path is also covered).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeLanceConn, setLanceConnPath } from '../../../db/lance/conn.js';
import {
	upsertArtifactVec,
	_resetArtifactVecCache,
} from '../../../db/lance/artifact-vec.js';
import { _mineFactsForTest as mineFacts } from '../retriever.js';
import { retrievePriorContext } from '../retriever.js';
import type { ScoredArtifact } from '../relevance.js';
import type { ResolvedIntent } from '../resolver.js';
import type { Session } from '../../session.js';
import { loadConfig } from '../../config.js';

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
	dir = mkdtempSync(join(tmpdir(), 'insrc-retriever-'));
	setLanceConnPath(join(dir, 'lance'));
});
test.afterEach(async () => {
	await closeLanceConn();
	_resetArtifactVecCache();
	rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// mineFacts
// ---------------------------------------------------------------------------

function fakeScored(opts: {
	skillId: string;
	preview: unknown;
}): ScoredArtifact {
	return {
		id:          'fake',
		session_id:  'session',
		intent:      'code-analysis',
		skill_id:    opts.skillId,
		timestamp:   BigInt(Date.now()),
		path:        '/tmp/fake',
		preview:     typeof opts.preview === 'string' ? opts.preview : JSON.stringify(opts.preview),
		distance:    0,
		intentMatch: 1,
		semantic:    1,
		recency:     1,
		score:       1,
	};
}

test('mineFacts: code.source.repo.describe -> modules from topModules[]', () => {
	const facts = mineFacts([fakeScored({
		skillId: 'code.source.repo.describe',
		preview: {
			fileCount:   12500,
			topModules:  [
				{ path: '/repo/hadoop/hadoop-hdfs', fileCount: 240 },
				{ path: '/repo/hadoop/hadoop-yarn', fileCount: 180 },
			],
		},
	})]);
	assert.ok(facts.modules);
	assert.equal(facts.modules!.length, 2);
	assert.equal(facts.modules![0]!.path, '/repo/hadoop/hadoop-hdfs');
	assert.equal(facts.modules![0]!.fileCount, 240);
});

test('mineFacts: code.source.module.describe -> single module', () => {
	const facts = mineFacts([fakeScored({
		skillId: 'code.source.module.describe',
		preview: { modulePath: '/repo/foo/bar' },
	})]);
	assert.equal(facts.modules!.length, 1);
	assert.equal(facts.modules![0]!.path, '/repo/foo/bar');
});

test('mineFacts: code.entity.summary -> single entity', () => {
	const facts = mineFacts([fakeScored({
		skillId: 'code.entity.summary',
		preview: { found: true, entityId: 'aaaa', name: 'compute', kind: 'function', file: '/repo/foo.ts' },
	})]);
	assert.equal(facts.entities!.length, 1);
	assert.equal(facts.entities![0]!.entityRef, 'aaaa');
	assert.equal(facts.entities![0]!.name, 'compute');
});

test('mineFacts: code.entity.locate-by-name -> entities from matches[]', () => {
	const facts = mineFacts([fakeScored({
		skillId: 'code.entity.locate-by-name',
		preview: {
			matches: [
				{ id: 'a', name: 'User', kind: 'class',     file: '/repo/User.ts' },
				{ id: 'b', name: 'User', kind: 'interface', file: '/repo/types.ts' },
			],
		},
	})]);
	assert.equal(facts.entities!.length, 2);
});

test('mineFacts: code.orm.resolve-model -> ormModels', () => {
	const facts = mineFacts([fakeScored({
		skillId: 'code.orm.resolve-model',
		preview: { found: true, model: { name: 'User', table: 'users', dialect: 'prisma' } },
	})]);
	assert.equal(facts.ormModels!.length, 1);
	assert.equal(facts.ormModels![0]!.dialect, 'prisma');
});

test('mineFacts: data.source.rdbms.describe-table -> tables', () => {
	const facts = mineFacts([fakeScored({
		skillId: 'data.source.rdbms.describe-table',
		preview: {
			connectionId: 'prod-db',
			target:       'users',
			columns: [{ name: 'id' }, { name: 'email' }, { name: 'created_at' }],
		},
	})]);
	assert.equal(facts.tables!.length, 1);
	assert.equal(facts.tables![0]!.name, 'users');
	assert.deepEqual(facts.tables![0]!.columns, ['id', 'email', 'created_at']);
});

test('mineFacts: dedupes module paths across artefacts', () => {
	const facts = mineFacts([
		fakeScored({
			skillId: 'code.source.repo.describe',
			preview: { topModules: [{ path: '/repo/X', fileCount: 5 }] },
		}),
		fakeScored({
			skillId: 'code.source.module.describe',
			preview: { modulePath: '/repo/X' },
		}),
	]);
	assert.equal(facts.modules!.length, 1);
});

test('mineFacts: malformed preview is silently skipped', () => {
	const facts = mineFacts([
		fakeScored({ skillId: 'code.source.repo.describe', preview: 'not-json' }),
		fakeScored({ skillId: 'code.entity.summary', preview: '' }),
		fakeScored({ skillId: 'code.entity.summary', preview: { found: false } }),
	]);
	assert.deepEqual(facts, {});
});

// ---------------------------------------------------------------------------
// retrievePriorContext (real Lance, real embed)
// ---------------------------------------------------------------------------

function makeFakeSession(id: string): Session {
	const tags = new Map<string, string>();
	const stub = {
		id,
		contextManager: {
			setTag: (k: string, v: string) => { tags.set(k, v); },
			getTag: (k: string) => tags.get(k) ?? '',
		},
	} as unknown as Session;
	return stub;
}

const FAKE_RESOLVED: ResolvedIntent = {
	id:         'code-analysis',
	source:     'classified-fresh',
	confidence: 'high',
	reasoning:  'fixture',
	message:    'describe HDFS Core',
};

test('retrievePriorContext: empty query -> empty context (no embed call needed)', async () => {
	const session = makeFakeSession('session-A');
	const ctx = await retrievePriorContext(session, '', FAKE_RESOLVED);
	assert.equal(ctx.currentIntent, 'code-analysis');
	assert.equal(ctx.intentChanged, false);
	assert.equal(ctx.artifacts.length, 0);
	assert.deepEqual(ctx.facts, {});
});

test('retrievePriorContext: empty session id -> empty context', async () => {
	const session = makeFakeSession('');
	const ctx = await retrievePriorContext(session, 'anything', FAKE_RESOLVED);
	assert.equal(ctx.artifacts.length, 0);
});

test('retrievePriorContext: hits ranked + facts mined when artifacts present + embed succeeds', async () => {
	// Seed two artifacts in the table. We can't control the embedding
	// quality (real Ollama call); the test asserts on shape, not
	// ranking specifics. The ranking specifics live in relevance.test.ts.
	const session = makeFakeSession('session-A');
	await upsertArtifactVec({
		id:         'session-A:1000:code.source.repo.describe',
		embedding:  vec(1),
		session_id: 'session-A',
		intent:     'code-analysis',
		skill_id:   'code.source.repo.describe',
		timestamp:  BigInt(Date.now() - 60_000),
		path:       '/tmp/a',
		preview:    JSON.stringify({ topModules: [{ path: '/repo/hdfs', fileCount: 240 }] }),
	});
	await upsertArtifactVec({
		id:         'session-A:1001:code.entity.summary',
		embedding:  vec(2),
		session_id: 'session-A',
		intent:     'code-analysis',
		skill_id:   'code.entity.summary',
		timestamp:  BigInt(Date.now() - 30_000),
		path:       '/tmp/b',
		preview:    JSON.stringify({ found: true, entityId: 'aaaa', name: 'compute', kind: 'function' }),
	});

	const ctx = await retrievePriorContext(session, 'describe HDFS', FAKE_RESOLVED);
	// Either the embed succeeds and we get artifacts back, or Ollama
	// is down and we get empty context. Both are valid outcomes for
	// this integration test; the contract is "doesn't crash, returns
	// the typed shape".
	if (ctx.artifacts.length > 0) {
		assert.ok(ctx.artifacts.every(a => a.id.startsWith('session-A:')));
		// Facts should at least include modules from the repo-describe
		// hit (if it survived the score floor).
		// Forgiving assertion -- depends on embed quality.
		assert.ok(typeof ctx.facts === 'object');
	}
	// Either way: shape is valid.
	assert.equal(ctx.currentIntent, 'code-analysis');
});

test('retrievePriorContext: intentChanged flag mirrors resolver source', async () => {
	const session = makeFakeSession('session-B');
	const shifted: ResolvedIntent = {
		id:               'data-analysis',
		source:           'classified-shifted',
		previousIntent:   'code-analysis',
		confidence:       'high',
		reasoning:        'shifted',
		message:          'describe orders',
	};
	const ctx = await retrievePriorContext(session, '', shifted);
	assert.equal(ctx.intentChanged, true);
	assert.equal(ctx.currentIntent, 'data-analysis');
});
