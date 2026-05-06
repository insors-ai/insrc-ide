/**
 * Lance vector benchmarks.
 *
 * Phase 7.3 of plans/storage-migration-lmdb-lance.md. Bulk-inserts
 * synthetic embeddings into `entity_vec` and runs ANN searches
 * against scoped repos. Uses the production
 * writeEntityEmbeddings / searchEntityVecs surface.
 *
 * Smoke tier: 50k vectors, 1k searches. Full tier: 1M / 5k.
 */

import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeLanceConn, setLanceConnPath } from '../../db/lance/conn.js';
import {
	writeEntityEmbeddings,
	searchEntityVecs,
	_resetEntityVecCache,
	type EntityVecRow,
} from '../../db/lance/entity-vec.js';
import { loadConfig } from '../../agent/config.js';
import type { Bench, Tier } from '../harness.js';

interface VectorParams {
	readonly vectors:        number;
	readonly batchSize:      number;
	readonly searchSamples:  number;
	readonly searchLimit:    number;
}

const SMOKE: VectorParams = {
	vectors:        20_000,
	batchSize:      10_000,
	searchSamples:     200,
	searchLimit:        10,
};

const FULL: VectorParams = {
	vectors:     1_000_000,
	batchSize:      50_000,
	searchSamples:   5_000,
	searchLimit:        10,
};

const REPO = '/bench-repo';
const DIM  = loadConfig().models.providers.local.embeddingDim;

export async function benchVectors(bench: Bench, tier: Tier): Promise<void> {
	const params = tier === 'smoke' ? SMOKE : FULL;
	const dir = mkdtempSync(join(tmpdir(), `insrc-bench-${tier}-vectors-`));
	const lancePath = join(dir, 'lance');

	try {
		await closeLanceConn();
		_resetEntityVecCache();
		setLanceConnPath(lancePath);

		// 1. Bulk insert.
		await bench.runOnce(`vectors.insert ${params.vectors.toLocaleString()}`, async () => {
			await bulkInsertVectors(params);
		});

		// 2. ANN search. Reuse a small pool of pre-generated query
		//    vectors so each call hits the index, not the embed stub.
		const queries = makeQueryVectors(64);
		await bench.run(`vectors.searchEntityVecs (limit=${params.searchLimit})`, params.searchSamples, async () => {
			const q = queries[counter('vsearch') % queries.length]!;
			await searchEntityVecs(q, [REPO], params.searchLimit, 'all');
		});

		// 3. Final on-disk size.
		const lanceMb = Math.round(directorySize(lancePath) / 1024 / 1024);
		bench.recordFileSizeMb('lance.entity_vec', lanceMb);
	} finally {
		await closeLanceConn();
		_resetEntityVecCache();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function bulkInsertVectors(params: VectorParams): Promise<void> {
	const { vectors, batchSize } = params;
	for (let batch = 0; batch < vectors / batchSize; batch++) {
		const rows: EntityVecRow[] = new Array(batchSize);
		for (let i = 0; i < batchSize; i++) {
			const idx = batch * batchSize + i;
			rows[i] = {
				id:        `e${idx}`,
				embedding: makeVec(idx),
				repo:      REPO,
				kind:      idx % 7 === 0 ? 'class' : 'function',
				artifact:  false,
			};
		}
		await writeEntityEmbeddings(rows);
	}
}

function makeVec(seed: number): number[] {
	const v = new Array<number>(DIM);
	// Deterministic spread: trig-based fill normalised away from zero.
	for (let i = 0; i < DIM; i++) {
		v[i] = Math.sin(seed * (i + 1) * 0.0007) * 0.1;
	}
	return v;
}

function makeQueryVectors(n: number): number[][] {
	const out: number[][] = new Array(n);
	for (let i = 0; i < n; i++) out[i] = makeVec(i * 13 + 1);
	return out;
}

function directorySize(dir: string): number {
	let total = 0;
	const stack = [dir];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		const st = statSync(cur);
		if (st.isFile()) {
			total += st.size;
		} else if (st.isDirectory()) {
			for (const n of readdirSync(cur)) stack.push(join(cur, n));
		}
	}
	return total;
}

const counters = new Map<string, number>();
function counter(key: string): number {
	const c = (counters.get(key) ?? 0) + 1;
	counters.set(key, c);
	return c;
}
