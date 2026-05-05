/**
 * Phase 0.4 spike test 6: Lance HNSW index rebuild.
 *
 * Build a 1M-vector table, create HNSW index, then force rebuild via
 * optimize() / replace_index. Tests that rebuild completes without
 * OOM and stays under the 4 GiB RSS budget (the failure mode that bit
 * DuckDB's HNSW persistence).
 *
 * Plan expectation: completes; no OOM at 4 GiB RSS budget.
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
const RSS_BUDGET_MB = 4 * 1024;

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

async function main(): Promise<SpikeResult> {
	const dir = mkdtempSync(join(tmpdir(), 'spike-06-rebuild-'));
	const conn = await lancedb.connect(dir);

	console.log('  loading 1M vectors...');
	const tLoad0 = Date.now();
	const table = await conn.createTable('entity_vec', makeBatch(0, BATCH_SIZE));
	for (let batch = 1; batch < TOTAL_VECTORS / BATCH_SIZE; batch++) {
		await table.add(makeBatch(batch * BATCH_SIZE, BATCH_SIZE));
	}
	console.log(`  loaded in ${fmtMs(Date.now() - tLoad0)}`);

	console.log('  initial HNSW index build...');
	const tIdx0 = Date.now();
	await table.createIndex('embedding', { config: lancedb.Index.hnswPq({}) });
	const initialBuildMs = Date.now() - tIdx0;
	console.log(`  initial build in ${fmtMs(initialBuildMs)}; rss=${rssMb()} MiB`);

	console.log('  forcing rebuild via replace=true...');
	let peakRss = rssMb();
	const rssMonitor = setInterval(() => {
		const r = rssMb();
		if (r > peakRss) peakRss = r;
	}, 100);

	const tRebuild0 = Date.now();
	await table.createIndex('embedding', {
		config: lancedb.Index.hnswPq({}),
		replace: true,
	});
	const rebuildMs = Date.now() - tRebuild0;
	clearInterval(rssMonitor);

	console.log(`  rebuild in ${fmtMs(rebuildMs)}; peak rss=${peakRss} MiB`);

	const fileMb = dirSizeMb(dir);
	const pass = peakRss < RSS_BUDGET_MB && rebuildMs > 0;

	const result: SpikeResult = {
		test: '06-lance-rebuild (force HNSW rebuild on 1M vectors)',
		pass,
		metrics: {
			'total vectors':       TOTAL_VECTORS.toLocaleString(),
			'initial build time':  fmtMs(initialBuildMs),
			'rebuild time':        fmtMs(rebuildMs),
			'rebuild peak RSS':    `${peakRss} MiB`,
			'final file':          `${fileMb} MiB`,
			'rss budget':          `${RSS_BUDGET_MB} MiB`,
			'budget headroom':     `${RSS_BUDGET_MB - peakRss} MiB`,
		},
		expectations: {
			'completes':   'yes',
			'peak RSS':    `< ${RSS_BUDGET_MB} MiB (4 GiB)`,
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
