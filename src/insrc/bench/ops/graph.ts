/**
 * LMDB graph benchmarks.
 *
 * Phase 7.3 of plans/storage-migration-lmdb-lance.md. Synthetic edge
 * graph with light hub skew (every 1000th node has 10× outgoing
 * edges, mimicking shared modules), exercised through the production
 * graph store + edge / traversal helpers.
 *
 * Smoke tier: 100k edges, 10k nodes. Full tier: 1M / 10M.
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	closeGraphStore,
	getGraphStore,
	setGraphStorePath,
	withWriteTxn,
} from '../../db/graph/store.js';
import {
	encodeOutEdgeKey,
	encodeInEdgeKey,
	RELATION_KIND_BYTE,
} from '../../db/graph/keys.js';
import {
	outNeighbors,
	inNeighbors,
} from '../../db/graph/edges.js';
import { transitiveClosure, scc } from '../../db/graph/traversal.js';
import type { Bench, Tier } from '../harness.js';

interface GraphParams {
	readonly edges:           number;
	readonly nodes:           number;
	readonly batchSize:       number;
	readonly lookupSamples:   number;
	readonly closureSamples:  number;
	readonly closureMaxDepth: number;
	readonly sccSamples:      number;
}

const SMOKE: GraphParams = {
	edges:           100_000,
	nodes:            10_000,
	batchSize:        25_000,
	lookupSamples:    1_000,
	closureSamples:     100,
	closureMaxDepth:      4,
	sccSamples:          50,
};

const FULL: GraphParams = {
	edges:         1_000_000,
	nodes:           100_000,
	batchSize:        50_000,
	lookupSamples:     5_000,
	closureSamples:      500,
	closureMaxDepth:       6,
	sccSamples:          200,
};

export async function benchGraph(bench: Bench, tier: Tier): Promise<void> {
	const params = tier === 'smoke' ? SMOKE : FULL;
	const dir = mkdtempSync(join(tmpdir(), `insrc-bench-${tier}-graph-`));
	const lmdbPath = join(dir, 'graph.lmdb');

	try {
		await closeGraphStore();
		setGraphStorePath(lmdbPath);
		await getGraphStore();

		// 1. Bulk-insert edges via the production write txn helper.
		await bench.runOnce(`graph.insert ${params.edges.toLocaleString()} edges`, async () => {
			await bulkInsertEdges(params);
		});

		// 2. 1-hop forward lookup over deterministic samples.
		const fromIds = sampleNodeIds(params.lookupSamples, params.nodes);
		await bench.run('graph.outNeighbors (1-hop)', params.lookupSamples, async () => {
			const u = fromIds[counter('out') % fromIds.length]!;
			await outNeighbors(u);
		});

		// 3. 1-hop reverse lookup (in_edge mirror -- both directions
		//    should be index-served).
		await bench.run('graph.inNeighbors (1-hop)', params.lookupSamples, async () => {
			const u = fromIds[counter('in') % fromIds.length]!;
			await inNeighbors(u);
		});

		// 4. Bounded transitive closure. CALLS-only filter to mimic the
		//    common dead-code precondition shape.
		const closureRoots = sampleNodeIds(params.closureSamples, params.nodes);
		await bench.run('graph.transitiveClosure (depth=' + params.closureMaxDepth + ')', params.closureSamples, async () => {
			const u = closureRoots[counter('cls') % closureRoots.length]!;
			await transitiveClosure([u], { kindFilter: ['CALLS'], maxDepth: params.closureMaxDepth });
		});

		// 5. SCC over a small frontier.
		const sccRoots = sampleNodeIds(params.sccSamples, params.nodes);
		await bench.run('graph.scc (single root)', params.sccSamples, async () => {
			const u = sccRoots[counter('scc') % sccRoots.length]!;
			await scc([u], { kindFilter: ['CALLS'], maxDepth: params.closureMaxDepth });
		});

		// 6. Final file size.
		const fileMb = Math.round(statSync(lmdbPath).size / 1024 / 1024);
		bench.recordFileSizeMb('lmdb.graph', fileMb);
	} finally {
		await closeGraphStore();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Bulk insert `params.edges` synthetic out_edge + in_edge rows in
 * batches. Hub skew matches the spike (every 1000th node concentrates
 * 10× outgoing edges).
 */
async function bulkInsertEdges(params: GraphParams): Promise<void> {
	const { edges, nodes, batchSize } = params;
	const KIND_RANGE = 12;

	for (let batch = 0; batch < edges / batchSize; batch++) {
		await withWriteTxn(s => {
			for (let i = 0; i < batchSize; i++) {
				const idx = batch * batchSize + i;
				const fromCandidate = idx % nodes;
				const from = (fromCandidate % 1000 === 0)
					? BigInt((fromCandidate / 1000) % nodes)
					: BigInt(fromCandidate);
				const kind = (idx & 0xff) % KIND_RANGE + 1;
				const to   = BigInt((idx * 7919) % nodes);
				s.outEdge.put(encodeOutEdgeKey(from, kind, to), Buffer.alloc(0));
				s.inEdge.put(encodeInEdgeKey(to, kind, from), Buffer.alloc(0));
			}
		});
	}
}

/**
 * Deterministic pseudo-random node id sample. Uses the same `(idx *
 * 7919) % N` jump the spike used; reproducible across runs.
 */
function sampleNodeIds(count: number, nodes: number): bigint[] {
	const out: bigint[] = new Array(count);
	for (let i = 0; i < count; i++) {
		out[i] = BigInt((i * 7919) % nodes);
	}
	return out;
}

const counters = new Map<string, number>();
function counter(key: string): number {
	const c = (counters.get(key) ?? 0) + 1;
	counters.set(key, c);
	return c;
}

void RELATION_KIND_BYTE;  // referenced in comments only
