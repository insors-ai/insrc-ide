/**
 * Phase 0.4 spike test 2: LMDB random-read latency.
 *
 * Builds a 10M-edge env (same shape as test 1), then runs 100k random
 * outEdges(id, kind) cursor scans. Measures p50, p99, max latency
 * cold-vs-warm.
 *
 * Plan expectation: p99 < 1 ms warm; p99 < 10 ms cold.
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
const QUERIES     = 100_000;

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

function runQueries(
	lmdb: ReturnType<typeof openSpikeLmdb>,
	count: number,
): { latencies: Float64Array; totalNeighbors: number } {
	const latencies = new Float64Array(count);
	let totalNeighbors = 0;
	for (let i = 0; i < count; i++) {
		const from = BigInt(Math.floor(Math.random() * N_NODES));
		const kind = (Math.floor(Math.random() * KIND_RANGE)) + 1;
		const prefix = encodeOutEdgePrefix(from, kind);
		const t0 = performance.now();
		let count = 0;
		for (const _row of lmdb.outEdge.getRange({ start: prefix, end: incrementBuffer(prefix) })) {
			count++;
		}
		const dt = performance.now() - t0;
		latencies[i] = dt;
		totalNeighbors += count;
	}
	return { latencies, totalNeighbors };
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

function quantile(arr: Float64Array, q: number): number {
	const sorted = Array.from(arr).sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}

async function main(): Promise<SpikeResult> {
	const dir = mkdtempSync(join(tmpdir(), 'spike-02-random-read-'));
	const path = join(dir, 'lmdb');
	const lmdb = openSpikeLmdb(path, 32 * 1024);

	console.log('  loading 10M edges...');
	const tLoad0 = Date.now();
	loadEdges(lmdb);
	console.log(`  loaded in ${fmtMs(Date.now() - tLoad0)}; file=${dirSizeMb(path)} MiB`);

	console.log('  running cold queries (cache cleared)...');
	const cold = runQueries(lmdb, 5_000);
	const coldP50 = quantile(cold.latencies, 0.50);
	const coldP99 = quantile(cold.latencies, 0.99);

	console.log('  running warm queries...');
	const warm = runQueries(lmdb, QUERIES);
	const warmP50 = quantile(warm.latencies, 0.50);
	const warmP99 = quantile(warm.latencies, 0.99);
	const avgNeighbors = warm.totalNeighbors / QUERIES;

	const peakRss = rssMb();
	lmdb.close();

	const pass = warmP99 < 1.0 && coldP99 < 10.0;

	const result: SpikeResult = {
		test: '02-lmdb-random-read (100k queries on 10M-edge env)',
		pass,
		metrics: {
			'cold queries':   '5,000 (post-load, single thread)',
			'cold p50':       `${coldP50.toFixed(3)} ms`,
			'cold p99':       `${coldP99.toFixed(3)} ms`,
			'warm queries':   QUERIES.toLocaleString(),
			'warm p50':       `${warmP50.toFixed(3)} ms`,
			'warm p99':       `${warmP99.toFixed(3)} ms`,
			'avg neighbors':  avgNeighbors.toFixed(2),
			'peak RSS':       `${peakRss} MiB`,
		},
		expectations: {
			'warm p99': '< 1 ms',
			'cold p99': '< 10 ms',
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
