/**
 * Phase 0.4 spike test 5: Lance ANN throughput.
 *
 * Builds a 1M-vector table, creates an HNSW index on the embedding
 * column, runs 10k ANN queries. Measures p50, p99 latency.
 *
 * Plan expectation: p99 < 50 ms warm.
 */

import * as lancedb from '@lancedb/lancedb';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	rssMb,
	dirSizeMb,
	fmtMs,
	printResult,
	type SpikeResult,
} from './spike-store.js';

const TOTAL_VECTORS = 1_000_000;
const BATCH_SIZE    = 10_000;
const DIM           = 1024;
const QUERIES       = 10_000;
const N_REPOS       = 8;

function makeBatch(start: number, count: number): Array<{ id: string; repo: number; embedding: Float32Array }> {
	const out: Array<{ id: string; repo: number; embedding: Float32Array }> = [];
	for (let i = 0; i < count; i++) {
		const idx = start + i;
		const v = new Float32Array(DIM);
		for (let d = 0; d < DIM; d++) {
			v[d] = Math.sin((idx * 31 + d) * 0.001) * 0.1 + (idx % N_REPOS) * 0.01;
		}
		out.push({ id: `e${idx}`, repo: idx % N_REPOS, embedding: v });
	}
	return out;
}

function makeQueryVec(seed: number): Float32Array {
	const v = new Float32Array(DIM);
	for (let d = 0; d < DIM; d++) {
		v[d] = Math.sin((seed * 31 + d) * 0.001) * 0.1;
	}
	return v;
}

function quantile(arr: Float64Array, q: number): number {
	const sorted = Array.from(arr).sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}

async function main(): Promise<SpikeResult> {
	const dir = mkdtempSync(join(tmpdir(), 'spike-05-lance-ann-'));
	const conn = await lancedb.connect(dir);

	console.log('  loading 1M vectors...');
	const tLoad0 = Date.now();
	const table = await conn.createTable('entity_vec', makeBatch(0, BATCH_SIZE));
	for (let batch = 1; batch < TOTAL_VECTORS / BATCH_SIZE; batch++) {
		await table.add(makeBatch(batch * BATCH_SIZE, BATCH_SIZE));
	}
	console.log(`  loaded in ${fmtMs(Date.now() - tLoad0)}`);

	console.log('  creating HNSW index...');
	const tIdx0 = Date.now();
	await table.createIndex('embedding', { config: lancedb.Index.hnswPq({}) });
	const idxMs = Date.now() - tIdx0;
	console.log(`  index built in ${fmtMs(idxMs)}; file=${dirSizeMb(dir)} MiB`);

	console.log('  warming up (1000 queries)...');
	for (let i = 0; i < 1000; i++) {
		await table.search(makeQueryVec(i)).limit(10).toArray();
	}

	console.log(`  running ${QUERIES} ANN queries...`);
	const latencies = new Float64Array(QUERIES);
	const tQuery0 = Date.now();
	for (let i = 0; i < QUERIES; i++) {
		const t0 = performance.now();
		await table.search(makeQueryVec(i + 1000)).limit(10).toArray();
		latencies[i] = performance.now() - t0;
	}
	const queryMs = Date.now() - tQuery0;

	const p50 = quantile(latencies, 0.50);
	const p99 = quantile(latencies, 0.99);
	const p999 = quantile(latencies, 0.999);
	const peakRss = rssMb();

	const pass = p99 < 50.0;

	const result: SpikeResult = {
		test: '05-lance-ann (10k queries on 1M-vector HNSW)',
		pass,
		metrics: {
			'total vectors':   TOTAL_VECTORS.toLocaleString(),
			'index build':     fmtMs(idxMs),
			'index file':      `${dirSizeMb(dir)} MiB`,
			'queries':         QUERIES.toLocaleString(),
			'total query time': fmtMs(queryMs),
			'p50':             `${p50.toFixed(2)} ms`,
			'p99':             `${p99.toFixed(2)} ms`,
			'p99.9':           `${p999.toFixed(2)} ms`,
			'queries/sec':     Math.round(QUERIES / (queryMs / 1000)).toLocaleString(),
			'peak RSS':        `${peakRss} MiB`,
		},
		expectations: {
			'p99 warm': '< 50 ms',
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
