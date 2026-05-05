/**
 * Phase 4.1 tests for the LMDB graph traversal primitives.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeGraphStore, getGraphStore, setGraphStorePath, withWriteTxn } from '../store.js';
import {
	encodeOutEdgeKey,
	encodeInEdgeKey,
	RELATION_KIND_BYTE,
	type RelationKind,
} from '../keys.js';
import { bfs, dfs, transitiveClosure, scc } from '../traversal.js';

let dir: string;

test.beforeEach(async () => {
	await closeGraphStore();
	dir = mkdtempSync(join(tmpdir(), 'insrc-traversal-4.1-'));
	setGraphStorePath(join(dir, 'graph.lmdb'));
});
test.afterEach(async () => {
	await closeGraphStore();
	rmSync(dir, { recursive: true, force: true });
});

/**
 * Wire a directed edge into both out_edge and in_edge mirror tables.
 * Direct LMDB writes (Phase 2.3 edge API isn't separate; relations.ts
 * is the public surface but it requires an entity_id_by_string lookup
 * which complicates fixture setup -- direct writes keep these tests
 * focused on traversal correctness).
 */
async function wireEdge(from: bigint, kind: RelationKind, to: bigint): Promise<void> {
	const kindByte = RELATION_KIND_BYTE[kind];
	await withWriteTxn(s => {
		s.outEdge.put(encodeOutEdgeKey(from, kindByte, to), Buffer.alloc(0));
		s.inEdge.put(encodeInEdgeKey(to, kindByte, from), Buffer.alloc(0));
	});
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const v of gen) out.push(v);
	return out;
}

// ---------------------------------------------------------------------------
// BFS
// ---------------------------------------------------------------------------

test('bfs from a single root yields the root + transitive descendants', async () => {
	await getGraphStore();
	// Graph:  1 --CALLS--> 2 --CALLS--> 3
	//                       \-CALLS--> 4
	await wireEdge(1n, 'CALLS', 2n);
	await wireEdge(2n, 'CALLS', 3n);
	await wireEdge(2n, 'CALLS', 4n);

	const got = await collect(bfs([1n]));
	assert.deepEqual(got.sort(), [1n, 2n, 3n, 4n]);
});

test('bfs visits each node exactly once even with cycles', async () => {
	await getGraphStore();
	// Cycle: 1 -> 2 -> 3 -> 1
	await wireEdge(1n, 'CALLS', 2n);
	await wireEdge(2n, 'CALLS', 3n);
	await wireEdge(3n, 'CALLS', 1n);
	const got = await collect(bfs([1n]));
	assert.equal(got.length, 3);
});

test('bfs respects maxDepth', async () => {
	await getGraphStore();
	await wireEdge(1n, 'CALLS', 2n);
	await wireEdge(2n, 'CALLS', 3n);
	await wireEdge(3n, 'CALLS', 4n);

	const d0 = await collect(bfs([1n], { maxDepth: 0 }));
	assert.deepEqual(d0.sort(), [1n]);
	const d1 = await collect(bfs([1n], { maxDepth: 1 }));
	assert.deepEqual(d1.sort(), [1n, 2n]);
	const d2 = await collect(bfs([1n], { maxDepth: 2 }));
	assert.deepEqual(d2.sort(), [1n, 2n, 3n]);
});

test('bfs respects kindFilter', async () => {
	await getGraphStore();
	await wireEdge(1n, 'CALLS',   2n);
	await wireEdge(1n, 'IMPORTS', 3n);
	await wireEdge(2n, 'CALLS',   4n);

	const callsOnly = await collect(bfs([1n], { kindFilter: ['CALLS'] }));
	assert.deepEqual(callsOnly.sort(), [1n, 2n, 4n]);

	const importsOnly = await collect(bfs([1n], { kindFilter: ['IMPORTS'] }));
	assert.deepEqual(importsOnly.sort(), [1n, 3n]);
});

test('bfs with direction=in walks reverse edges', async () => {
	await getGraphStore();
	// 1 -> 2 -> 3
	await wireEdge(1n, 'CALLS', 2n);
	await wireEdge(2n, 'CALLS', 3n);

	const fromTip = await collect(bfs([3n], { direction: 'in' }));
	assert.deepEqual(fromTip.sort(), [1n, 2n, 3n]);
});

test('bfs visitor pruning skips subtree expansion', async () => {
	await getGraphStore();
	// 1 -> 2 -> 3, 1 -> 4
	await wireEdge(1n, 'CALLS', 2n);
	await wireEdge(2n, 'CALLS', 3n);
	await wireEdge(1n, 'CALLS', 4n);

	const got = await collect(bfs([1n], {
		visitor: (id) => id !== 2n, // prune at 2 -- don't expand its children
	}));
	assert.deepEqual(got.sort(), [1n, 2n, 4n]);
});

test('bfs from multiple roots merges the closures', async () => {
	await getGraphStore();
	await wireEdge(1n, 'CALLS', 2n);
	await wireEdge(3n, 'CALLS', 4n);
	const got = await collect(bfs([1n, 3n]));
	assert.deepEqual(got.sort(), [1n, 2n, 3n, 4n]);
});

test('bfs deduplicates roots', async () => {
	await getGraphStore();
	await wireEdge(1n, 'CALLS', 2n);
	const got = await collect(bfs([1n, 1n, 1n]));
	assert.deepEqual(got.sort(), [1n, 2n]);
});

// ---------------------------------------------------------------------------
// DFS
// ---------------------------------------------------------------------------

test('dfs visits the same nodes as bfs (different order)', async () => {
	await getGraphStore();
	await wireEdge(1n, 'CALLS', 2n);
	await wireEdge(2n, 'CALLS', 3n);
	await wireEdge(2n, 'CALLS', 4n);
	const dfsResult = await collect(dfs([1n]));
	const bfsResult = await collect(bfs([1n]));
	assert.deepEqual(dfsResult.sort(), bfsResult.sort());
});

test('dfs handles cycles without infinite loop', async () => {
	await getGraphStore();
	await wireEdge(1n, 'CALLS', 2n);
	await wireEdge(2n, 'CALLS', 1n);
	const got = await collect(dfs([1n]));
	assert.deepEqual(got.sort(), [1n, 2n]);
});

test('dfs respects maxDepth', async () => {
	await getGraphStore();
	await wireEdge(1n, 'CALLS', 2n);
	await wireEdge(2n, 'CALLS', 3n);
	const d1 = await collect(dfs([1n], { maxDepth: 1 }));
	assert.deepEqual(d1.sort(), [1n, 2n]);
});

// ---------------------------------------------------------------------------
// transitiveClosure
// ---------------------------------------------------------------------------

test('transitiveClosure returns the BFS-reachable set', async () => {
	await getGraphStore();
	await wireEdge(1n, 'CALLS', 2n);
	await wireEdge(2n, 'CALLS', 3n);
	await wireEdge(5n, 'CALLS', 6n);

	const c = await transitiveClosure([1n]);
	assert.equal(c.size, 3);
	assert.ok(c.has(1n));
	assert.ok(c.has(2n));
	assert.ok(c.has(3n));
	assert.ok(!c.has(5n));
	assert.ok(!c.has(6n));
});

test('transitiveClosure on empty roots returns empty set', async () => {
	await getGraphStore();
	const c = await transitiveClosure([]);
	assert.equal(c.size, 0);
});

// ---------------------------------------------------------------------------
// SCC (Tarjan's algorithm)
// ---------------------------------------------------------------------------

test('scc: isolated nodes are singletons', async () => {
	await getGraphStore();
	// 1 -> 2 -> 3 (no cycle)
	await wireEdge(1n, 'CALLS', 2n);
	await wireEdge(2n, 'CALLS', 3n);
	const components = await scc([1n]);
	assert.equal(components.length, 3);
	for (const c of components) {
		assert.equal(c.length, 1);
	}
});

test('scc: a 3-node cycle is one component of size 3', async () => {
	await getGraphStore();
	await wireEdge(1n, 'CALLS', 2n);
	await wireEdge(2n, 'CALLS', 3n);
	await wireEdge(3n, 'CALLS', 1n);
	const components = await scc([1n]);
	assert.equal(components.length, 1);
	assert.equal(components[0]!.length, 3);
});

test('scc: cycle + tail reports two components', async () => {
	await getGraphStore();
	// 1 -> 2 -> 3 -> 1, and 3 -> 4 (tail)
	await wireEdge(1n, 'CALLS', 2n);
	await wireEdge(2n, 'CALLS', 3n);
	await wireEdge(3n, 'CALLS', 1n);
	await wireEdge(3n, 'CALLS', 4n);
	const components = await scc([1n]);
	const sizes = components.map(c => c.length).sort((a, b) => a - b);
	assert.deepEqual(sizes, [1, 3]);
});

test('scc: two disjoint cycles + reachable from a single root via separate edge', async () => {
	await getGraphStore();
	// 1 -> 2 -> 1 (cycle A), 1 -> 3 -> 4 -> 3 (cycle B reached through 3)
	await wireEdge(1n, 'CALLS', 2n);
	await wireEdge(2n, 'CALLS', 1n);
	await wireEdge(1n, 'CALLS', 3n);
	await wireEdge(3n, 'CALLS', 4n);
	await wireEdge(4n, 'CALLS', 3n);
	const components = await scc([1n]);
	const sizes = components.map(c => c.length).sort((a, b) => a - b);
	assert.deepEqual(sizes, [2, 2]);
});

test('scc respects kindFilter', async () => {
	await getGraphStore();
	// 1 -CALLS-> 2 -CALLS-> 1 forms a cycle on CALLS only
	await wireEdge(1n, 'CALLS',   2n);
	await wireEdge(2n, 'CALLS',   1n);
	// 3 -IMPORTS-> 1 doesn't pull 3 in via CALLS
	await wireEdge(3n, 'IMPORTS', 1n);

	const callsOnly = await scc([1n], { kindFilter: ['CALLS'] });
	const sizes = callsOnly.map(c => c.length).sort((a, b) => a - b);
	assert.deepEqual(sizes, [2]);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('traversal results survive close + reopen', async () => {
	await getGraphStore();
	await wireEdge(1n, 'CALLS', 2n);
	await wireEdge(2n, 'CALLS', 3n);
	await closeGraphStore();
	const c = await transitiveClosure([1n]);
	assert.equal(c.size, 3);
});
