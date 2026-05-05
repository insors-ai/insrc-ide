/**
 * Phase 0.4 spike test 3: LMDB transitive-closure throughput.
 *
 * Builds a 10M-edge env, then runs BFS from 100 random roots through
 * a fixed relation kind (DEPENDS_ON-equivalent = kind 1) to exhaustion.
 * Tests the traversal performance ceiling on top of mmap'd cursor
 * scans.
 *
 * Plan expectation: < 5 seconds for any single closure on the 10M-edge env.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	openSpikeLmdb,
	encodeOutEdgeKey,
	encodeOutEdgePrefix,
	rssMb,
	dirSizeMb,
	fmtMs,
	printResult,
	type SpikeResult,
} from './spike-store.js';

const TOTAL_EDGES = 10_000_000;
const N_NODES     = 1_000_000;
const KIND_RANGE  = 12;
const ROOTS       = 100;
const TRAVERSAL_KIND = 1; // arbitrary kind to traverse on

function loadEdges(lmdb: ReturnType<typeof openSpikeLmdb>): void {
	const BATCH = 100_000;
	for (let batch = 0; batch < TOTAL_EDGES / BATCH; batch++) {
		lmdb.root.transactionSync(() => {
			for (let i = 0; i < BATCH; i++) {
				const idx = batch * BATCH + i;
				const fromCandidate = idx % N_NODES;
				const from = (fromCandidate % 1000 === 0)
					? BigInt((fromCandidate / 1000) % N_NODES)
					: BigInt(fromCandidate);
				const kind = (idx & 0xff) % KIND_RANGE + 1;
				const to   = BigInt((idx * 7919) % N_NODES);
				lmdb.outEdge.put(encodeOutEdgeKey(from, kind, to), Buffer.alloc(0));
			}
		});
	}
}

function incrementBuffer(b: Buffer): Buffer {
	const out = Buffer.from(b);
	for (let i = out.length - 1; i >= 0; i--) {
		const v = out[i]!;
		if (v < 0xff) {
			out[i] = v + 1;
			return out;
		}
		out[i] = 0;
	}
	return Buffer.concat([Buffer.from([0x01]), out]);
}

function bfs(
	lmdb: ReturnType<typeof openSpikeLmdb>,
	root: bigint,
	kindFilter: number,
): { reached: number; depth: number; ms: number } {
	const visited = new Set<bigint>();
	let frontier: bigint[] = [root];
	visited.add(root);
	let depth = 0;
	const t0 = performance.now();

	while (frontier.length > 0) {
		const next: bigint[] = [];
		for (const node of frontier) {
			const prefix = encodeOutEdgePrefix(node, kindFilter);
			for (const { key } of lmdb.outEdge.getRange({ start: prefix, end: incrementBuffer(prefix) })) {
				const buf = key as Buffer;
				const to = buf.readBigUInt64BE(9);
				if (!visited.has(to)) {
					visited.add(to);
					next.push(to);
				}
			}
		}
		if (next.length === 0) break;
		frontier = next;
		depth++;
	}
	return { reached: visited.size, depth, ms: performance.now() - t0 };
}

async function main(): Promise<SpikeResult> {
	const dir = mkdtempSync(join(tmpdir(), 'spike-03-closure-'));
	const path = join(dir, 'lmdb');
	const lmdb = openSpikeLmdb(path, 32 * 1024);

	console.log('  loading 10M edges...');
	const tLoad0 = Date.now();
	loadEdges(lmdb);
	console.log(`  loaded in ${fmtMs(Date.now() - tLoad0)}; file=${dirSizeMb(path)} MiB`);

	console.log('  running BFS from 100 random roots...');
	const closures: { reached: number; depth: number; ms: number }[] = [];
	let maxMs = 0;
	let totalReached = 0;
	let maxDepth = 0;
	const tBfs0 = Date.now();
	for (let i = 0; i < ROOTS; i++) {
		const root = BigInt(Math.floor(Math.random() * N_NODES));
		const r = bfs(lmdb, root, TRAVERSAL_KIND);
		closures.push(r);
		if (r.ms > maxMs) maxMs = r.ms;
		totalReached += r.reached;
		if (r.depth > maxDepth) maxDepth = r.depth;
	}
	const totalMs = Date.now() - tBfs0;

	const sorted = closures.map(c => c.ms).sort((a, b) => a - b);
	const p50 = sorted[Math.floor(sorted.length / 2)]!;
	const p99 = sorted[Math.floor(sorted.length * 0.99)]!;

	const peakRss = rssMb();
	lmdb.close();

	const pass = maxMs < 5_000;

	const result: SpikeResult = {
		test: '03-lmdb-closure (BFS from 100 roots, 10M-edge env)',
		pass,
		metrics: {
			'roots':           ROOTS,
			'total time':      fmtMs(totalMs),
			'avg time/root':   fmtMs(totalMs / ROOTS),
			'p50 per closure': fmtMs(p50),
			'p99 per closure': fmtMs(p99),
			'max per closure': fmtMs(maxMs),
			'avg reached':     (totalReached / ROOTS).toFixed(0),
			'max depth':       maxDepth,
			'peak RSS':        `${peakRss} MiB`,
		},
		expectations: {
			'max per closure': '< 5 s',
		},
	};

	rmSync(dir, { recursive: true, force: true });
	return result;
}

main().then(r => {
	printResult(r);
	process.exit(r.pass ? 0 : 1);
}).catch(err => {
	console.error(err);
	process.exit(2);
});
