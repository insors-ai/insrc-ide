/**
 * Throw-away spike store for Phase 0.4 substrate validation.
 *
 * NOT a production GraphStore -- this is a minimal LMDB + Lance wrapper
 * just sufficient to exercise the substrates at scale. The real
 * GraphStore lands in Phase 1.1; this file is deleted at the end of
 * Phase 0.4.
 *
 * Goal: validate that LMDB and LanceDB don't fail at production scale
 * (the failure mode that bit DuckDB).
 */

import { open, type RootDatabase, type Database } from 'lmdb';
import * as lancedb from '@lancedb/lancedb';
import { mkdirSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// lmdb-js Database has a generic constraint we don't bother narrowing
// for the spike. The runtime API accepts Buffer keys/values just fine.
type AnyDb = Database;

// ---------------------------------------------------------------------------
// Key codec helpers (binary BE for sequential-insert-friendly B+ tree)
// ---------------------------------------------------------------------------

export function encodeOutEdgeKey(from: bigint, kind: number, to: bigint): Buffer {
	const buf = Buffer.alloc(17);
	buf.writeBigUInt64BE(from, 0);
	buf.writeUInt8(kind, 8);
	buf.writeBigUInt64BE(to, 9);
	return buf;
}

export function encodeOutEdgePrefix(from: bigint, kind?: number): Buffer {
	const buf = Buffer.alloc(kind === undefined ? 8 : 9);
	buf.writeBigUInt64BE(from, 0);
	if (kind !== undefined) {
		buf.writeUInt8(kind, 8);
	}
	return buf;
}

export function decodeOutEdgeKey(buf: Buffer): { from: bigint; kind: number; to: bigint } {
	return {
		from: buf.readBigUInt64BE(0),
		kind: buf.readUInt8(8),
		to:   buf.readBigUInt64BE(9),
	};
}

export function encodeEntityKey(id: bigint): Buffer {
	const buf = Buffer.alloc(8);
	buf.writeBigUInt64BE(id, 0);
	return buf;
}

// ---------------------------------------------------------------------------
// LMDB env wrapper
// ---------------------------------------------------------------------------

export interface SpikeLmdb {
	root:    RootDatabase;
	entity:  AnyDb;
	outEdge: AnyDb;
	inEdge:  AnyDb;
	close(): void;
}

export function openSpikeLmdb(path: string, mapSizeMb = 16 * 1024): SpikeLmdb {
	mkdirSync(path, { recursive: true });
	const root = open({
		path,
		mapSize: mapSizeMb * 1024 * 1024,
		maxDbs: 8,
		// Full durability default per design doc Phase 1.5
		// (no MDB_NOSYNC / MDB_NOMETASYNC / MDB_MAPASYNC)
	});
	const entity  = root.openDB({ name: 'entity',   keyEncoding: 'binary', encoding: 'binary' });
	const outEdge = root.openDB({ name: 'out_edge', keyEncoding: 'binary', encoding: 'binary' });
	const inEdge  = root.openDB({ name: 'in_edge',  keyEncoding: 'binary', encoding: 'binary' });
	return {
		root,
		entity,
		outEdge,
		inEdge,
		close: () => root.close(),
	};
}

// ---------------------------------------------------------------------------
// Lance table wrapper
// ---------------------------------------------------------------------------

export interface SpikeLance {
	conn:  lancedb.Connection;
	table: lancedb.Table;
	close(): Promise<void>;
}

export async function openSpikeLance(path: string, dim = 1024): Promise<SpikeLance> {
	mkdirSync(path, { recursive: true });
	const conn = await lancedb.connect(path);
	const tables = await conn.tableNames();
	const table = tables.includes('entity_vec')
		? await conn.openTable('entity_vec')
		: await conn.createTable('entity_vec', [
			{ id: 'bootstrap', repo: 0, embedding: new Array<number>(dim).fill(0) },
		]);
	return {
		conn,
		table,
		close: async () => { /* connections close on GC */ },
	};
}

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

export function rssMb(): number {
	return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

export function dirSizeMb(path: string): number {
	if (!existsSync(path)) return 0;
	let total = 0;
	const stack = [path];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		const stat = statSync(cur);
		if (stat.isFile()) {
			total += stat.size;
		} else if (stat.isDirectory()) {
			for (const e of readdirSync(cur)) {
				stack.push(join(cur, e));
			}
		}
	}
	return Math.round(total / 1024 / 1024);
}

export function fmtMs(ms: number): string {
	return ms < 1000 ? `${ms.toFixed(1)} ms`
		: ms < 60_000 ? `${(ms / 1000).toFixed(1)} s`
		: `${(ms / 60_000).toFixed(1)} min`;
}

// ---------------------------------------------------------------------------
// Result reporting
// ---------------------------------------------------------------------------

export interface SpikeResult {
	test: string;
	pass: boolean;
	metrics: Record<string, string | number>;
	expectations: Record<string, string>;
	notes?: string;
}

export function printResult(r: SpikeResult): void {
	const status = r.pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
	console.log(`\n[${status}] ${r.test}`);
	console.log('  metrics:');
	for (const [k, v] of Object.entries(r.metrics)) {
		console.log(`    ${k}: ${v}`);
	}
	console.log('  expectations:');
	for (const [k, v] of Object.entries(r.expectations)) {
		console.log(`    ${k}: ${v}`);
	}
	if (r.notes) {
		console.log(`  notes: ${r.notes}`);
	}
}
