/**
 * Lance scale probe -- find the breakpoint where ANN search starts
 * to hang on a fresh entity_vec table.
 *
 * Phase-7.3 follow-up after the full-tier bench hung at 1M vectors
 * (the 200k tier completes in ~25s + 25s search; 1M completes the
 * insert phase but the first search never returns).
 *
 * Usage:
 *   npx tsx scripts/lance-scale-probe.ts <N>
 *
 * Reports per-phase timings:
 *   bulk insert    -- N rows in batches via table.add() directly
 *                     (skips writeEntityEmbeddings' delete-then-add
 *                     overhead so we measure raw insert capacity)
 *   first search   -- one searchEntityVecs() call (this is what
 *                     hangs at scale)
 *   warm searches  -- 10 follow-up searches if the first returned
 *
 * Drives a hard wall-clock timeout via Promise.race; if first search
 * hasn't returned by FIRST_SEARCH_TIMEOUT_MS, prints HANG and exits 1.
 */

import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as lancedb from '@lancedb/lancedb';
import { setLanceConnPath, closeLanceConn, getLanceConn } from '../db/lance/conn.js';
import {
	searchEntityVecs,
	_resetEntityVecCache,
} from '../db/lance/entity-vec.js';
import { loadConfig } from '../agent/config.js';

const DIM = loadConfig().models.providers.local.embeddingDim;
const REPO = '/probe-repo';
const BATCH_SIZE = 25_000;
const FIRST_SEARCH_TIMEOUT_MS = 180_000;  // 3 min

function vec(seed: number): number[] {
	const v = new Array<number>(DIM);
	for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed * (i + 1) * 0.0007) * 0.1;
	return v;
}

function dirSizeMb(path: string): number {
	if (!path) return 0;
	let total = 0;
	const stack = [path];
	try {
		while (stack.length > 0) {
			const cur = stack.pop()!;
			const st = statSync(cur);
			if (st.isFile()) total += st.size;
			else if (st.isDirectory()) for (const n of readdirSync(cur)) stack.push(join(cur, n));
		}
	} catch { /* ignore */ }
	return Math.round(total / 1024 / 1024);
}

function fmtMs(ms: number): string {
	return ms < 1000 ? `${ms.toFixed(0)} ms`
		: ms < 60_000 ? `${(ms / 1000).toFixed(2)} s`
		: `${(ms / 60_000).toFixed(2)} min`;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<{ ok: true; value: T } | { ok: false; label: string }> {
	let t: NodeJS.Timeout | undefined;
	const timer = new Promise<'TIMEOUT'>((res) => { t = setTimeout(() => res('TIMEOUT'), ms); });
	try {
		const r = await Promise.race([p.then(v => ({ ok: true as const, value: v })), timer]);
		if (r === 'TIMEOUT') return { ok: false, label };
		return r;
	} finally {
		if (t !== undefined) clearTimeout(t);
	}
}

async function main(): Promise<number> {
	const N = parseInt(process.argv[2] ?? '200000', 10);
	if (Number.isNaN(N) || N < 1000) {
		console.error('usage: lance-scale-probe <N>  (N >= 1000)');
		return 2;
	}
	console.log(`# Lance scale probe -- N=${N.toLocaleString()}, dim=${DIM}`);

	const dir = mkdtempSync(join(tmpdir(), `insrc-lance-probe-${N}-`));
	const lancePath = join(dir, 'lance');
	await closeLanceConn();
	_resetEntityVecCache();
	setLanceConnPath(lancePath);

	let exitCode = 0;
	try {
		// Open the table directly via the Lance connection so we can
		// use raw .add() for the insert benchmark (skipping the
		// delete-then-add upsert path).
		const conn = await getLanceConn();
		// Bootstrap with a sentinel row so the table schema exists.
		await conn.createTable('entity_vec', [{
			id: '_seed', embedding: new Array<number>(DIM).fill(0),
			repo: '_seed', kind: '_seed', artifact: false,
		}]);
		const table = await conn.openTable('entity_vec');

		// Phase 1: bulk insert N vectors via direct .add()
		console.log(`# Phase 1: insert ${N.toLocaleString()} vectors in batches of ${BATCH_SIZE.toLocaleString()}...`);
		const t0 = Date.now();
		for (let batch = 0; batch * BATCH_SIZE < N; batch++) {
			const start = batch * BATCH_SIZE;
			const end   = Math.min(start + BATCH_SIZE, N);
			const rows = new Array(end - start);
			for (let i = 0; i < end - start; i++) {
				const idx = start + i;
				rows[i] = {
					id:        `e${idx}`,
					embedding: vec(idx),
					repo:      REPO,
					kind:      idx % 7 === 0 ? 'class' : 'function',
					artifact:  false,
				};
			}
			const tBatch = Date.now();
			await table.add(rows);
			const elapsed = Date.now() - tBatch;
			console.log(`  batch ${batch + 1}/${Math.ceil(N / BATCH_SIZE)} (${(end).toLocaleString()} rows total): ${fmtMs(elapsed)}`);
		}
		const insertMs = Date.now() - t0;
		const sizeMb   = dirSizeMb(lancePath);
		console.log(`# Phase 1 done: insert=${fmtMs(insertMs)}  on-disk=${sizeMb} MiB\n`);

		// Phase 2: first search (this is the hang point at scale)
		console.log(`# Phase 2: first search (likely triggers Lance index work)...`);
		const tSearch = Date.now();
		const r = await withTimeout(
			searchEntityVecs(vec(42), [REPO], 10),
			FIRST_SEARCH_TIMEOUT_MS,
			'first search',
		);
		if (!r.ok) {
			console.log(`# Phase 2: HANG -- first search did not return within ${fmtMs(FIRST_SEARCH_TIMEOUT_MS)}`);
			console.log(`# RESULT N=${N}: HANG`);
			exitCode = 1;
		} else {
			const firstSearchMs = Date.now() - tSearch;
			console.log(`# Phase 2 done: first search=${fmtMs(firstSearchMs)}, hits=${r.value.length}`);

			// Phase 3: 10 warm searches
			console.log(`# Phase 3: 10 warm searches...`);
			const tWarm = Date.now();
			for (let i = 0; i < 10; i++) {
				await searchEntityVecs(vec(42 + i), [REPO], 10);
			}
			const warmMs = Date.now() - tWarm;
			const warmAvg = warmMs / 10;
			console.log(`# Phase 3 done: 10 searches in ${fmtMs(warmMs)} (avg ${fmtMs(warmAvg)} per search)\n`);
			console.log(`# RESULT N=${N}: PASS  insert=${fmtMs(insertMs)}  first=${fmtMs(firstSearchMs)}  warm-avg=${fmtMs(warmAvg)}  on-disk=${sizeMb} MiB`);
		}
	} catch (err) {
		console.error(`# Probe failed:`, err);
		exitCode = 2;
	} finally {
		await closeLanceConn();
		_resetEntityVecCache();
		rmSync(dir, { recursive: true, force: true });
	}
	return exitCode;
}

void lancedb;

main().then(code => process.exit(code)).catch(err => {
	console.error(err);
	process.exit(2);
});
