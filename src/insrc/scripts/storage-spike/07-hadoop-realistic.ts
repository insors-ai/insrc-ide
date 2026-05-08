/**
 * Phase 0.4 spike test 7: Full Hadoop YARN indexing.
 *
 * THE size-validation gate. Walks the actual hadoop YARN repo at
 * /Users/subhagho/work/projects/insors/hadoop, parses every supported
 * source file via the existing tree-sitter parsers, writes entities +
 * relations to the spike LMDB store, generates fake 1024-dim
 * embeddings (random; not testing embedding quality, only substrate
 * write throughput) and writes them to Lance.
 *
 * Plan expectation: completes without OOM; RSS stable; LMDB ~150 MiB,
 * Lance ~700 MiB (approximate; depends on actual entity count). The
 * direct successor to "the workload that broke DuckDB at 148 GiB."
 */

import { readFileSync, readdirSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { extname } from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import {
	openSpikeLmdb,
	encodeOutEdgeKey,
	encodeEntityKey,
	rssMb,
	dirSizeMb,
	fmtMs,
	printResult,
	type SpikeResult,
} from './spike-store.js';

// Auto-register all language parsers
import '../../indexer/parser/typescript.js';
import '../../indexer/parser/python.js';
import '../../indexer/parser/go.js';
import '../../indexer/parser/java.js';
import '../../indexer/parser/scala.js';
import { getParser } from '../../indexer/parser/registry.js';

const HADOOP_PATH = '/Users/subhagho/work/projects/insors/hadoop';
const DIM         = 1024;
const SUPPORTED_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java', '.scala']);

// Map relation kind strings → u8 (matches the design doc's 12-kind enum).
// Unknown kinds get bucketed to 0 so we don't drop edges; spike only.
const KIND_BYTE: Record<string, number> = {
	CONTAINS: 1, DEFINES: 2, INHERITS: 3, IMPLEMENTS: 4, CALLS: 5,
	IMPORTS: 6, EXPORTS: 7, DEPENDS_ON: 8, REFERENCES: 9, READS: 10, WRITES: 11,
	STEP_DEPENDS_ON: 12,
};
function kindToByte(s: string): number { return KIND_BYTE[s] ?? 0; }

// Map deterministic SHA-32 entity IDs → sequential u64 (the design's eventual ID).
// The mapping table itself stays in memory for the spike (~10 MiB at 100k entities).
let nextId = 1n;
const idMap = new Map<string, bigint>();
function idToU64(s: string): bigint {
	let v = idMap.get(s);
	if (v === undefined) {
		v = nextId++;
		idMap.set(s, v);
	}
	return v;
}

// Random fake embedding (not exercising Ollama; this test isolates substrate
// write throughput, not embedding quality)
function fakeEmbed(seed: bigint): Float32Array {
	const v = new Float32Array(DIM);
	const s = Number(seed % 1_000_000n);
	for (let d = 0; d < DIM; d++) {
		v[d] = Math.sin((s * 31 + d) * 0.001) * 0.1;
	}
	return v;
}

function* walkSourceFiles(root: string): Generator<string> {
	const stack = [root];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		let entries: import('node:fs').Dirent[];
		try {
			entries = readdirSync(cur, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const full = join(cur, e.name);
			if (e.isDirectory()) {
				stack.push(full);
			} else if (e.isFile() && SUPPORTED_EXT.has(extname(e.name).toLowerCase())) {
				yield full;
			}
		}
	}
}

async function main(): Promise<SpikeResult> {
	const dir = mkdtempSync(join(tmpdir(), 'spike-07-hadoop-'));
	const lmdbPath = join(dir, 'lmdb');
	const lancePath = join(dir, 'lance');

	const lmdb = openSpikeLmdb(lmdbPath, 8 * 1024); // 8 GiB mapsize
	const lance = await lancedb.connect(lancePath);

	const t0 = Date.now();
	let peakRss = rssMb();
	let filesScanned = 0;
	let filesParsed = 0;
	let filesSkipped = 0;
	let totalEntities = 0;
	let totalRelations = 0;

	const VEC_BATCH = 5_000;
	let vecBatch: Array<{ id: string; embedding: Float32Array }> = [];
	let lanceTable: lancedb.Table | null = null;

	async function flushVecBatch(): Promise<void> {
		if (vecBatch.length === 0) return;
		if (lanceTable === null) {
			lanceTable = await lance.createTable('entity_vec', vecBatch);
		} else {
			await lanceTable.add(vecBatch);
		}
		vecBatch = [];
	}

	console.log(`  walking ${HADOOP_PATH}...`);
	const ENTITY_BATCH = 50_000;
	let entityBatch: Array<{ key: Buffer; value: Buffer }> = [];
	let edgeBatch: Buffer[] = [];

	function flushLmdbBatch(): void {
		if (entityBatch.length === 0 && edgeBatch.length === 0) return;
		lmdb.root.transactionSync(() => {
			for (const { key, value } of entityBatch) {
				lmdb.entity.put(key, value);
			}
			for (const k of edgeBatch) {
				lmdb.outEdge.put(k, Buffer.alloc(0));
			}
		});
		entityBatch = [];
		edgeBatch = [];
	}

	for (const filePath of walkSourceFiles(HADOOP_PATH)) {
		filesScanned++;
		const parser = getParser(filePath);
		if (!parser) {
			filesSkipped++;
			continue;
		}
		let source: string;
		try {
			source = readFileSync(filePath, 'utf8');
		} catch {
			filesSkipped++;
			continue;
		}
		try {
			// Spike uses a synthetic repoId (1) -- no registry interaction
			// in the benchmark fixture.
			const result = parser.parse(filePath, source, HADOOP_PATH, 1);
			filesParsed++;

			for (const e of result.entities) {
				const u64 = idToU64(e.id);
				const valueJson = Buffer.from(JSON.stringify({
					id: e.id, kind: e.kind, name: e.name,
					file: relative(HADOOP_PATH, filePath),
					startLine: e.startLine, endLine: e.endLine,
					language: e.language,
				}), 'utf8');
				entityBatch.push({ key: encodeEntityKey(u64), value: valueJson });
				vecBatch.push({ id: e.id, embedding: fakeEmbed(u64) });
				totalEntities++;
			}
			for (const r of result.relations) {
				if (typeof r.from !== 'string' || typeof r.to !== 'string') continue;
				if (!r.resolved) continue;
				const fromU64 = idToU64(r.from);
				const toU64 = idToU64(r.to);
				edgeBatch.push(encodeOutEdgeKey(fromU64, kindToByte(r.kind), toU64));
				totalRelations++;
			}

			if (entityBatch.length >= ENTITY_BATCH || edgeBatch.length >= ENTITY_BATCH) {
				flushLmdbBatch();
			}
			if (vecBatch.length >= VEC_BATCH) {
				await flushVecBatch();
			}
		} catch {
			filesSkipped++;
		}

		if (filesScanned % 500 === 0) {
			const rss = rssMb();
			if (rss > peakRss) peakRss = rss;
			console.log(
				`  scanned=${filesScanned} parsed=${filesParsed} skipped=${filesSkipped} ` +
				`entities=${totalEntities} edges=${totalRelations} ` +
				`rss=${rss}MB elapsed=${fmtMs(Date.now() - t0)}`,
			);
		}
	}

	flushLmdbBatch();
	await flushVecBatch();

	const elapsed = Date.now() - t0;
	const lmdbMb = dirSizeMb(lmdbPath);
	const lanceMb = dirSizeMb(lancePath);
	const finalRss = rssMb();

	lmdb.close();

	// Pass criteria: completed without throwing; RSS within reasonable
	// bound (we use 4 GiB as the hard ceiling matching Lance's index
	// rebuild budget; substrate write should be much lower)
	const pass = peakRss < 4 * 1024 && totalEntities > 0 && totalRelations > 0;

	const result: SpikeResult = {
		test: '07-hadoop-realistic (full YARN repo via spike write path)',
		pass,
		metrics: {
			'files scanned':    filesScanned.toLocaleString(),
			'files parsed':     filesParsed.toLocaleString(),
			'files skipped':    filesSkipped.toLocaleString(),
			'total entities':   totalEntities.toLocaleString(),
			'total relations':  totalRelations.toLocaleString(),
			'edge:entity':      (totalRelations / Math.max(1, totalEntities)).toFixed(2),
			'elapsed':          fmtMs(elapsed),
			'LMDB file':        `${lmdbMb} MiB`,
			'Lance file':       `${lanceMb} MiB`,
			'total on disk':    `${lmdbMb + lanceMb} MiB`,
			'peak RSS':         `${peakRss} MiB`,
			'final RSS':        `${finalRss} MiB`,
		},
		expectations: {
			'completes':        'yes',
			'peak RSS':         '< 4096 MiB (4 GiB)',
			'projected size':   '~150 MiB LMDB + ~700 MiB Lance (approximate)',
			'comparison':       'DuckDB hit 148 GiB on this same workload',
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
