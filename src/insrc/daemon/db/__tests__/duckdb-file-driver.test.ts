/**
 * DuckDB-backed FileDriver end-to-end (Phase 1 of
 * plans/data-driver-duckdb-files.md). Spins up a tmp dir + writes a
 * small CSV and a JSON-array doc, opens a connection per kind, and
 * exercises describe / sample / sampleShape / aggregate.
 *
 * Avoids better-sqlite3 / parquetjs-lite -- only Node + DuckDB +
 * the data-driver pool layer are involved, so the test runs in CI
 * without native-binding ABI alignment.
 */

import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalHome = process.env['HOME'];
const tmpHome = mkdtempSync(join(tmpdir(), 'insrc-duckdb-file-'));
process.env['HOME'] = tmpHome;

// Self-registers via top-level import. duckdb-file.ts is imported
// last to override the bespoke csv / json / etc. registrations.
await import('../drivers/csv.js');
await import('../drivers/json.js');
await import('../drivers/jsonl.js');
await import('../drivers/parquet.js');
await import('../drivers/duckdb-file.js');

const { DriverPool } = await import('../pool.js');
const { connectionsPath } = await import('../config.js');
const { closeDuckDB } = await import('../duckdb-pool.js');

const repoRoot = mkdtempSync(join(tmpdir(), 'insrc-duckdb-file-repo-'));
const csvPath  = join(repoRoot, 'orders.csv');
const jsonPath = join(repoRoot, 'orders.json');

writeFileSync(csvPath,
	'id,user_id,amount\n' +
	'1,1,12.5\n' +
	'2,2,7.0\n' +
	'3,1,99.99\n',
	'utf8',
);
writeFileSync(jsonPath,
	JSON.stringify([
		{ id: 1, user_id: 1, amount: 12.5,  meta: { tag: 'x' } },
		{ id: 2, user_id: 2, amount: 7.0,   meta: { tag: 'y' } },
		{ id: 3, user_id: 1, amount: 99.99, meta: { tag: 'x' } },
	]),
	'utf8',
);

async function writeConn(): Promise<void> {
	const p = connectionsPath(repoRoot);
	await mkdir(join(p, '..'), { recursive: true });
	await writeFile(p, JSON.stringify({
		connections: [
			{ id: 'csv-orders',  kind: 'csv',  path: 'orders.csv'  },
			{ id: 'json-orders', kind: 'json', path: 'orders.json' },
		],
	}), 'utf8');
}

describe('DuckDBFileDriver -- csv', () => {
	it('describe via DESCRIBE returns column / type', async () => {
		await writeConn();
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const drv = await pool.acquire('csv-orders');
		assert.equal(drv.family, 'file');
		assert.equal(drv.kind, 'csv');

		const schema = await (drv as { describe: (t?: string) => Promise<{ columns: { name: string; type: string }[] }> }).describe();
		assert.deepEqual(schema.columns.map(c => c.name).sort(), ['amount', 'id', 'user_id']);
		// DuckDB's auto-detect picks numeric types for amount / id / user_id
		const amountType = schema.columns.find(c => c.name === 'amount')!.type;
		assert.match(amountType, /DOUBLE|FLOAT|DECIMAL/i);
		await pool.closeAll();
	});

	it('sample with where + limit returns matching rows', async () => {
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const drv = await pool.acquire('csv-orders');
		const res = await (drv as {
			sample: (t: string | undefined, o: unknown) => Promise<{ rows: { id: number }[] }>;
		}).sample(undefined, {
			limit: 10,
			where: [{ column: 'user_id', op: '=', value: 1 }],
		});
		assert.equal(res.rows.length, 2);
		assert.deepEqual(res.rows.map(r => Number(r.id)).sort(), [1, 3]);
		await pool.closeAll();
	});

	it('aggregate count / sum / avg / min / max', async () => {
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const drv = await pool.acquire('csv-orders');
		const res = await (drv as {
			aggregate: (t: string | undefined, r: unknown) => Promise<{ values: Record<string, number | null> }>;
		}).aggregate(undefined, {
			aggregations: [
				{ column: '*',      function: 'count' },
				{ column: 'amount', function: 'sum' },
				{ column: 'amount', function: 'min' },
				{ column: 'amount', function: 'max' },
				{ column: 'user_id', function: 'distinct_count' },
				{ column: 'amount', function: 'percentile', args: { p: 0.5 } },
			],
		});
		assert.equal(res.values['*__count'], 3);
		// 12.5 + 7.0 + 99.99 = 119.49
		assert.equal(Math.round((res.values['amount__sum'] ?? 0) * 100), 11949);
		assert.equal(res.values['amount__min'], 7);
		assert.equal(res.values['amount__max'], 99.99);
		assert.equal(res.values['user_id__distinct_count'], 2);
		// median of [7.0, 12.5, 99.99] = 12.5
		assert.equal(res.values['amount__percentile_0_5'], 12.5);
		await pool.closeAll();
	});

	it('rejects unknown column in WHERE + invalid aggregate column', async () => {
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const drv = await pool.acquire('csv-orders');
		await assert.rejects(
			(drv as { sample: (t: string | undefined, o: unknown) => Promise<unknown> }).sample(
				undefined, { limit: 10, where: [{ column: 'no_such', op: '=', value: 1 }] },
			),
			/unknown column 'no_such'/,
		);
		await assert.rejects(
			(drv as { aggregate: (t: string | undefined, r: unknown) => Promise<unknown> }).aggregate(
				undefined, { aggregations: [{ column: 'discount', function: 'avg' }] },
			),
			/unknown column 'discount'/,
		);
		await pool.closeAll();
	});
});

describe('DuckDBFileDriver -- json', () => {
	it('describe + sample on JSON array', async () => {
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const drv = await pool.acquire('json-orders');
		assert.equal(drv.kind, 'json');

		const schema = await (drv as { describe: (t?: string) => Promise<{ columns: { name: string; type: string }[] }> }).describe();
		assert.ok(schema.columns.find(c => c.name === 'id'));
		assert.ok(schema.columns.find(c => c.name === 'amount'));
		assert.ok(schema.columns.find(c => c.name === 'meta'));

		const sample = await (drv as { sample: (t: string | undefined, o: unknown) => Promise<{ rows: unknown[] }> })
			.sample(undefined, { limit: 50 });
		assert.equal(sample.rows.length, 3);

		await pool.closeAll();
	});

	it('sampleShape on JSON array runs nested-shape inference', async () => {
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const drv = await pool.acquire('json-orders');
		const shape = await (drv as { sampleShape: (o: unknown) => Promise<{ sampleSize: number }> })
			.sampleShape({ limit: 10 });
		assert.ok(shape.sampleSize >= 1);
		await pool.closeAll();
	});

	it('aggregate over JSON', async () => {
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const drv = await pool.acquire('json-orders');
		const res = await (drv as {
			aggregate: (t: string | undefined, r: unknown) => Promise<{ values: Record<string, number | null> }>;
		}).aggregate(undefined, {
			aggregations: [{ column: 'amount', function: 'avg' }],
		});
		// avg(12.5, 7.0, 99.99) = 39.83
		assert.equal(Math.round((res.values['amount__avg'] ?? 0) * 100), 3983);
		await pool.closeAll();
	});
});

describe('DuckDBFileDriver -- option validation', () => {
	it('rejects bad CSV delimiter at factory time', async () => {
		const altRoot = mkdtempSync(join(tmpdir(), 'insrc-duckdb-file-bad-'));
		writeFileSync(join(altRoot, 'orders.csv'), 'a,b\n1,2\n', 'utf8');
		const altConfPath = connectionsPath(altRoot);
		await mkdir(join(altConfPath, '..'), { recursive: true });
		await writeFile(altConfPath, JSON.stringify({
			connections: [{
				id: 'bad', kind: 'csv', path: 'orders.csv',
				options: { delimiter: "',quote=\"X\"" },  // injection-shaped
			}],
		}), 'utf8');
		const pool = new DriverPool(altRoot);
		await pool.reload();
		await assert.rejects(
			pool.acquire('bad'),
			/csv delimiter|unsupported character/i,
		);
		await pool.closeAll();
		try { rmSync(altRoot, { recursive: true, force: true }); } catch { /* ignore */ }
	});
});

after(async () => {
	if (originalHome !== undefined) { process.env['HOME'] = originalHome; }
	else { delete process.env['HOME']; }
	try { await closeDuckDB(); } catch { /* ignore */ }
	try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
	try { rmSync(repoRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
