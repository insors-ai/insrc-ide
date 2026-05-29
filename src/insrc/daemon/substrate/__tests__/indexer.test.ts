/**
 * Substrate indexer unit tests -- P2.4 of plans/skills/substrate-implementation-status.md.
 *
 * Each test uses an isolated tmpdir for both the substrate root + the
 * Lance connection. A deterministic fake embedder produces 1024-dim
 * vectors from a string seed so byEmbedding queries are reproducible.
 *
 * Coverage:
 *   - 'always' policy: put triggers an embed + Lance row write.
 *   - 'never' policy: put doesn't touch Lance (embedder never invoked).
 *   - 'derived' policy: indexer feeds the from(entry) output to embed.
 *   - delete: file removed + Lance row removed.
 *   - searchByEmbedding: returns the most-similar entries in distance order.
 *   - searchByEmbedding scoping: hits from other (owner|namespace) are
 *     filtered out by the Lance where-clause.
 *   - Runtime without an embedder: searchByEmbedding falls back to the
 *     base store's empty-list stub (legacy P0/P1 behavior preserved).
 *   - Indexer failure swallow: a throwing embedder doesn't break put.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeLanceConn, setLanceConnPath } from '../../../db/lance/conn.js';
import { _resetSubstrateVecCache } from '../substrate-vec.js';
import { loadConfig } from '../../../agent/config.js';

import { createMemoryStore } from '../memory-store.js';
import { createSubstrateRuntime } from '../runtime.js';
import type { Embedder, NamespaceSpec } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIM = loadConfig().models.providers.local.embeddingDim;

/**
 * Deterministic embedder: maps a string to a unit-ish vector using a
 * sinusoidal seed derived from the string hash. Two different strings
 * give clearly distinct vectors; the same string is bit-for-bit stable.
 */
function makeFakeEmbedder(): Embedder & { calls: { text: string }[] } {
	const calls: { text: string }[] = [];
	const embed = async (text: string): Promise<Float32Array> => {
		calls.push({ text });
		// Simple stable hash so two distinct strings get distinct seeds.
		let h = 2166136261;
		for (let i = 0; i < text.length; i++) {
			h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
		}
		const v = new Float32Array(DIM);
		for (let i = 0; i < DIM; i++) {
			v[i] = Math.sin((h + i) * 0.001);
		}
		return v;
	};
	const e: Embedder & { calls: { text: string }[] } = Object.assign(
		{ embed } as Embedder,
		{ calls },
	);
	return e;
}

interface Fixture {
	readonly root:    string;
	readonly lance:   string;
	dispose(): Promise<void>;
}

async function setupFixture(): Promise<Fixture> {
	const root  = mkdtempSync(join(tmpdir(), 'insrc-substrate-indexer-'));
	const lance = join(root, 'lance');
	setLanceConnPath(lance);
	return {
		root,
		lance,
		async dispose() {
			await closeLanceConn();
			_resetSubstrateVecCache();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

async function resetLanceBetween(): Promise<void> {
	await closeLanceConn();
	_resetSubstrateVecCache();
}

// One owner + a handful of namespaces with different policies.
const OWNER = 'skill:test.indexer';

const NS_ALWAYS: NamespaceSpec = {
	namespace:   'always-ns',
	valueType:   'object',
	autoDistill: 'on-pin',
	indexing:    { kind: 'always' },
};

const NS_NEVER: NamespaceSpec = {
	namespace:   'never-ns',
	valueType:   'object',
	autoDistill: 'on-pin',
	indexing:    { kind: 'never' },
};

const NS_DERIVED: NamespaceSpec = {
	namespace:   'derived-ns',
	valueType:   'object',
	autoDistill: 'on-pin',
	indexing:    {
		kind: 'derived',
		from: (entry) => {
			const v = entry.value as { description?: string };
			return v.description ?? '';
		},
	},
};

/**
 * Build a runtime with the indexer enabled. Registers a synthetic skill
 * (id only) carrying the namespace specs so the indexer + distill see
 * the schemas at write time.
 */
function makeIndexedRuntime(opts: {
	root:        string;
	embedder:    Embedder;
	workspaceId: string;
	memorySchema: readonly NamespaceSpec[];
}) {
	const memory = createMemoryStore({ workspaceId: opts.workspaceId, rootDir: opts.root });
	const substrate = createSubstrateRuntime({
		memory,
		embedder:    opts.embedder,
		workspaceId: opts.workspaceId,
	});
	// Synthetic skill: only what registerSkill reads off the cast.
	const skill = {
		id:          'test.indexer',
		name:        'test.indexer',
		family:      'test',
		ownerId:     OWNER,
		memorySchema: opts.memorySchema,
	};
	substrate.registerSkill(skill as unknown as Parameters<typeof substrate.registerSkill>[0]);
	return substrate;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('always policy: put triggers embed + Lance row', async () => {
	await resetLanceBetween();
	const fx = await setupFixture();
	try {
		const embedder = makeFakeEmbedder();
		const substrate = makeIndexedRuntime({
			root:         fx.root,
			embedder,
			workspaceId:  'wsTest',
			memorySchema: [NS_ALWAYS],
		});

		const ns = substrate.memory.scope(OWNER, NS_ALWAYS.namespace);
		await ns.put(
			'k1',
			{ thing: 'apple', shade: 'red' },
			{ kind: 'fact', source: { kind: 'test' }, confidence: 0.9 },
		);

		// Embedder called exactly once with the JSON-stringified value.
		assert.equal(embedder.calls.length, 1);
		assert.ok(embedder.calls[0]!.text.includes('apple'));

		// Search returns the row.
		const queryVec = await embedder.embed(JSON.stringify({ thing: 'apple', shade: 'red' }));
		const hits = await ns.searchByEmbedding<{ thing: string }>(queryVec, { topK: 5 });
		assert.equal(hits.length, 1);
		assert.equal(hits[0]!.key, 'k1');
		assert.equal(hits[0]!.value.thing, 'apple');
	} finally { await fx.dispose(); }
});

test('never policy: put does not touch the embedder', async () => {
	await resetLanceBetween();
	const fx = await setupFixture();
	try {
		const embedder = makeFakeEmbedder();
		const substrate = makeIndexedRuntime({
			root:         fx.root,
			embedder,
			workspaceId:  'wsTest',
			memorySchema: [NS_NEVER],
		});

		const ns = substrate.memory.scope(OWNER, NS_NEVER.namespace);
		await ns.put(
			'k1',
			{ thing: 'pear' },
			{ kind: 'fact', source: { kind: 'test' }, confidence: 0.9 },
		);

		assert.equal(embedder.calls.length, 0);
		// And searchByEmbedding returns empty (no row was written).
		const hits = await ns.searchByEmbedding(new Float32Array(DIM), { topK: 5 });
		assert.equal(hits.length, 0);
	} finally { await fx.dispose(); }
});

test('derived policy: indexer embeds the from(entry) text', async () => {
	await resetLanceBetween();
	const fx = await setupFixture();
	try {
		const embedder = makeFakeEmbedder();
		const substrate = makeIndexedRuntime({
			root:         fx.root,
			embedder,
			workspaceId:  'wsTest',
			memorySchema: [NS_DERIVED],
		});

		const ns = substrate.memory.scope(OWNER, NS_DERIVED.namespace);
		await ns.put(
			'k1',
			{ description: 'red apple', other: 'ignored' },
			{ kind: 'fact', source: { kind: 'test' }, confidence: 0.9 },
		);

		assert.equal(embedder.calls.length, 1);
		assert.equal(embedder.calls[0]!.text, 'red apple');
	} finally { await fx.dispose(); }
});

test('delete: file and Lance row both removed', async () => {
	await resetLanceBetween();
	const fx = await setupFixture();
	try {
		const embedder = makeFakeEmbedder();
		const substrate = makeIndexedRuntime({
			root:         fx.root,
			embedder,
			workspaceId:  'wsTest',
			memorySchema: [NS_ALWAYS],
		});

		const ns = substrate.memory.scope(OWNER, NS_ALWAYS.namespace);
		await ns.put(
			'k1',
			{ thing: 'apple' },
			{ kind: 'fact', source: { kind: 'test' }, confidence: 0.9 },
		);
		await ns.delete('k1');

		// File side: gone.
		assert.equal(await ns.get('k1'), undefined);

		// Lance side: searchByEmbedding now returns empty even with the
		// same embedding we used to write.
		const queryVec = await embedder.embed(JSON.stringify({ thing: 'apple' }));
		const hits = await ns.searchByEmbedding(queryVec, { topK: 5 });
		assert.equal(hits.length, 0);
	} finally { await fx.dispose(); }
});

test('searchByEmbedding returns hits in distance order', async () => {
	await resetLanceBetween();
	const fx = await setupFixture();
	try {
		const embedder = makeFakeEmbedder();
		const substrate = makeIndexedRuntime({
			root:         fx.root,
			embedder,
			workspaceId:  'wsTest',
			memorySchema: [NS_DERIVED],
		});

		const ns = substrate.memory.scope(OWNER, NS_DERIVED.namespace);
		await ns.put(
			'apple',
			{ description: 'red apple' },
			{ kind: 'fact', source: { kind: 'test' }, confidence: 0.9 },
		);
		await ns.put(
			'pear',
			{ description: 'green pear' },
			{ kind: 'fact', source: { kind: 'test' }, confidence: 0.9 },
		);

		// Query by the exact "red apple" embedding -- apple must come first.
		const queryVec = await embedder.embed('red apple');
		const hits = await ns.searchByEmbedding<{ description: string }>(queryVec, { topK: 2 });
		assert.equal(hits.length, 2);
		assert.equal(hits[0]!.key, 'apple');
		assert.equal(hits[1]!.key, 'pear');
	} finally { await fx.dispose(); }
});

test('searchByEmbedding is scoped to (owner, namespace)', async () => {
	await resetLanceBetween();
	const fx = await setupFixture();
	try {
		const embedder = makeFakeEmbedder();

		// Two namespaces under the same owner, same workspace.
		const NS_A: NamespaceSpec = { ...NS_ALWAYS, namespace: 'scope-a' };
		const NS_B: NamespaceSpec = { ...NS_ALWAYS, namespace: 'scope-b' };
		const substrate = makeIndexedRuntime({
			root:         fx.root,
			embedder,
			workspaceId:  'wsTest',
			memorySchema: [NS_A, NS_B],
		});

		const nsA = substrate.memory.scope(OWNER, NS_A.namespace);
		const nsB = substrate.memory.scope(OWNER, NS_B.namespace);

		await nsA.put(
			'shared-key',
			{ inA: true, payload: 'distinct-A' },
			{ kind: 'fact', source: { kind: 'test' }, confidence: 0.9 },
		);
		await nsB.put(
			'shared-key',
			{ inB: true, payload: 'distinct-B' },
			{ kind: 'fact', source: { kind: 'test' }, confidence: 0.9 },
		);

		// Probe vector that doesn't match anything specific. Both rows are
		// in Lance; without scoping each search would return both. With
		// scoping, each namespace sees only its own.
		const probe = await embedder.embed('some unrelated query string');

		const hitsA = await nsA.searchByEmbedding<{ inA?: boolean }>(probe, { topK: 5 });
		const hitsB = await nsB.searchByEmbedding<{ inB?: boolean }>(probe, { topK: 5 });

		assert.equal(hitsA.length, 1);
		assert.equal(hitsA[0]!.value.inA, true);
		assert.equal(hitsB.length, 1);
		assert.equal(hitsB[0]!.value.inB, true);
	} finally { await fx.dispose(); }
});

test('without an embedder: searchByEmbedding returns empty (legacy P0/P1)', async () => {
	await resetLanceBetween();
	const fx = await setupFixture();
	try {
		const memory = createMemoryStore({ workspaceId: 'wsTest', rootDir: fx.root });
		// NO embedder, NO workspaceId on runtime -- indexer is inactive.
		const substrate = createSubstrateRuntime({ memory });

		const ns = substrate.memory.scope(OWNER, 'whatever');
		await ns.put('k1', { x: 1 }, { kind: 'fact', source: { kind: 'test' }, confidence: 0.9 });

		const hits = await ns.searchByEmbedding(new Float32Array(DIM), { topK: 5 });
		assert.equal(hits.length, 0);
	} finally { await fx.dispose(); }
});

test('embedder failures are swallowed -- file write succeeds anyway', async () => {
	await resetLanceBetween();
	const fx = await setupFixture();
	try {
		const flaky: Embedder = {
			embed: async () => { throw new Error('upstream embedder down'); },
		};
		const substrate = makeIndexedRuntime({
			root:         fx.root,
			embedder:     flaky,
			workspaceId:  'wsTest',
			memorySchema: [NS_ALWAYS],
		});

		const ns = substrate.memory.scope(OWNER, NS_ALWAYS.namespace);
		// Must not throw.
		await ns.put(
			'k1',
			{ thing: 'apple' },
			{ kind: 'fact', source: { kind: 'test' }, confidence: 0.9 },
		);

		// File side intact.
		const e = await ns.get<{ thing: string }>('k1');
		assert.ok(e);
		assert.equal(e.value.thing, 'apple');

		// Lance side: no row written -> empty search.
		const hits = await ns.searchByEmbedding(new Float32Array(DIM), { topK: 5 });
		assert.equal(hits.length, 0);
	} finally { await fx.dispose(); }
});
