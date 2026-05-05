/**
 * Phase 0.4 spike test 1: LMDB bulk-write throughput.
 *
 * Bulk-load 10M synthetic edges into LMDB env in batches; measure
 * total time, ms/M-edges, peak RSS, final file size. Tests the write
 * path's behaviour at production scale.
 *
 * Plan expectation: < 10 GiB on disk, < 5 minutes total.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	openSpikeLmdb,
	encodeOutEdgeKey,
	rssMb,
	dirSizeMb,
	fmtMs,
	printResult,
	type SpikeResult,
} from './spike-store.js';

const TOTAL_EDGES   = 10_000_000;
const BATCH_SIZE    = 100_000;
const N_NODES       = 1_000_000;       // 10:1 edge:node ratio
const KIND_RANGE    = 12;              // 12 relation kinds in v1

async function main(): Promise<SpikeResult> {
	const dir = mkdtempSync(join(tmpdir(), 'spike-01-bulk-edges-'));
	const path = join(dir, 'lmdb');
	const lmdb = openSpikeLmdb(path, 32 * 1024); // 32 GiB mapsize for headroom

	const t0 = Date.now();
	let peakRss = rssMb();
	let written = 0;

	for (let batch = 0; batch < TOTAL_EDGES / BATCH_SIZE; batch++) {
		await lmdb.root.transaction(() => {
			for (let i = 0; i < BATCH_SIZE; i++) {
				const idx  = batch * BATCH_SIZE + i;
				// Synthetic edges with light skew toward hubs (every 1000th
				// node has 10x more outgoing edges, mimicking shared modules)
				const fromCandidate = idx % N_NODES;
				const from = (fromCandidate % 1000 === 0)
					? BigInt((fromCandidate / 1000) % N_NODES)
					: BigInt(fromCandidate);
				const kind = (idx & 0xff) % KIND_RANGE + 1;
				const to   = BigInt((idx * 7919) % N_NODES);
				const key  = encodeOutEdgeKey(from, kind, to);
				lmdb.outEdge.put(key, Buffer.alloc(0));
			}
		});
		written += BATCH_SIZE;
		const rss = rssMb();
		if (rss > peakRss) peakRss = rss;
		if (batch % 10 === 0 || batch === TOTAL_EDGES / BATCH_SIZE - 1) {
			console.log(
				`  ${written.toLocaleString()} / ${TOTAL_EDGES.toLocaleString()} edges  ` +
				`elapsed=${fmtMs(Date.now() - t0)}  rss=${rss}MB  ` +
				`fileMB=${dirSizeMb(path)}`,
			);
		}
	}

	const elapsed = Date.now() - t0;
	const fileMb  = dirSizeMb(path);
	lmdb.close();

	const msPerM = elapsed / (TOTAL_EDGES / 1_000_000);
	const fileGiB = fileMb / 1024;
	const pass = elapsed < 5 * 60 * 1000 && fileGiB < 10;

	const result: SpikeResult = {
		test: '01-lmdb-bulk-write (10M edges)',
		pass,
		metrics: {
			'total edges':    TOTAL_EDGES.toLocaleString(),
			'elapsed':        fmtMs(elapsed),
			'ms/M edges':     `${msPerM.toFixed(0)} ms`,
			'final file':     `${fileMb} MiB (${fileGiB.toFixed(2)} GiB)`,
			'peak RSS':       `${peakRss} MiB`,
			'edges/sec':      Math.round(TOTAL_EDGES / (elapsed / 1000)).toLocaleString(),
		},
		expectations: {
			'time':      '< 5 min',
			'file size': '< 10 GiB',
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
