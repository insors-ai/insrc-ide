/**
 * Phase 0.4 spike test 4: Lance bulk-write throughput.
 *
 * Bulk-insert 1M random 1024-dim vectors into a Lance table; measure
 * total time, peak RSS, final on-disk size.
 *
 * Plan expectation: < 30 minutes; < 10 GiB on disk.
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
const N_REPOS       = 8;

function makeBatch(start: number, count: number): Array<{ id: string; repo: number; embedding: Float32Array }> {
	const out: Array<{ id: string; repo: number; embedding: Float32Array }> = [];
	for (let i = 0; i < count; i++) {
		const idx = start + i;
		const v = new Float32Array(DIM);
		for (let d = 0; d < DIM; d++) {
			// Deterministic pseudorandom; cluster by repo mod N_REPOS so
			// HNSW sees realistic clustering, not pure white noise
			v[d] = Math.sin((idx * 31 + d) * 0.001) * 0.1 + (idx % N_REPOS) * 0.01;
		}
		out.push({ id: `e${idx}`, repo: idx % N_REPOS, embedding: v });
	}
	return out;
}

async function main(): Promise<SpikeResult> {
	const dir = mkdtempSync(join(tmpdir(), 'spike-04-lance-write-'));
	const conn = await lancedb.connect(dir);
	const table = await conn.createTable('entity_vec', makeBatch(0, BATCH_SIZE));

	const t0 = Date.now();
	let peakRss = rssMb();
	let written = BATCH_SIZE;

	for (let batch = 1; batch < TOTAL_VECTORS / BATCH_SIZE; batch++) {
		const rows = makeBatch(batch * BATCH_SIZE, BATCH_SIZE);
		await table.add(rows);
		written += BATCH_SIZE;
		const rss = rssMb();
		if (rss > peakRss) peakRss = rss;
		if (batch % 10 === 0) {
			console.log(
				`  ${written.toLocaleString()} / ${TOTAL_VECTORS.toLocaleString()} vectors  ` +
				`elapsed=${fmtMs(Date.now() - t0)}  rss=${rss}MB  ` +
				`fileMB=${dirSizeMb(dir)}`,
			);
		}
	}

	const elapsed = Date.now() - t0;
	const fileMb = dirSizeMb(dir);
	const finalRows = await table.countRows();

	const fileGiB = fileMb / 1024;
	const pass = elapsed < 30 * 60 * 1000 && fileGiB < 10;

	const result: SpikeResult = {
		test: '04-lance-bulk-write (1M vectors @ 1024-dim)',
		pass,
		metrics: {
			'total vectors':  TOTAL_VECTORS.toLocaleString(),
			'written rows':   finalRows.toLocaleString(),
			'elapsed':        fmtMs(elapsed),
			'final file':     `${fileMb} MiB (${fileGiB.toFixed(2)} GiB)`,
			'peak RSS':       `${peakRss} MiB`,
			'vectors/sec':    Math.round(TOTAL_VECTORS / (elapsed / 1000)).toLocaleString(),
			'bytes/vector':   `${Math.round((fileMb * 1024 * 1024) / TOTAL_VECTORS)} bytes`,
		},
		expectations: {
			'time':      '< 30 min',
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
