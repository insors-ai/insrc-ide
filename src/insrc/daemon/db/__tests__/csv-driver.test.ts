/**
 * End-to-end test for the CSV driver via the registry + pool.
 *
 * Uses a small tmp-dir repo + fixture CSV; exercises describe +
 * sample (with + without where filters + limits) + the pool's
 * path-escape guard.
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalHome = process.env['HOME'];
const tmpHome = mkdtempSync(join(tmpdir(), 'insrc-csv-test-'));
process.env['HOME'] = tmpHome;

// Side-effect import registers the csv driver.
await import('../drivers/csv.js');
const { DriverPool } = await import('../pool.js');
const { connectionsPath } = await import('../config.js');

const repoRoot = mkdtempSync(join(tmpdir(), 'insrc-csv-repo-'));
const csvPath = join(repoRoot, 'orders.csv');
writeFileSync(csvPath, [
	'id,customer,amount,paid',
	'1,alice,12.50,true',
	'2,bob,7,true',
	'3,alice,,false',
	'4,carol,99.99,true',
].join('\n'), 'utf8');

async function writeConnections(): Promise<void> {
	const path = connectionsPath(repoRoot);
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, JSON.stringify({
		connections: [
			{ id: 'orders', kind: 'csv', path: 'orders.csv' },
		],
	}), 'utf8');
}

// ---------------------------------------------------------------------------

describe('CsvDriver (via pool)', () => {
	before(writeConnections);

	it('describe() returns inferred columns + types', async () => {
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const driver = await pool.acquire('orders');
		assert.equal(driver.family, 'file');
		const schema = await (driver as { describe: (t?: string) => Promise<unknown> }).describe();
		assert.equal((schema as { source: string }).source, 'inferred');
		const columns = (schema as { columns: { name: string; type: string; nullable?: boolean }[] }).columns;
		const byName = new Map(columns.map(c => [c.name, c]));
		assert.deepEqual([...byName.keys()].sort(), ['amount', 'customer', 'id', 'paid']);
		assert.equal(byName.get('id')?.type, 'integer');
		assert.equal(byName.get('customer')?.type, 'string');
		assert.equal(byName.get('paid')?.type, 'boolean');
		// 'amount' has 12.50 + 7 (integer) + '' (null) + 99.99 -> number.
		assert.equal(byName.get('amount')?.type, 'number');
		assert.equal(byName.get('amount')?.nullable, true);
		await pool.closeAll();
	});

	it('sample() without filter returns all rows (under limit)', async () => {
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const driver = await pool.acquire('orders');
		const res = await (driver as { sample: (t: string | undefined, o: { limit: number }) => Promise<unknown> }).sample(undefined, { limit: 10 });
		const rows = (res as { rows: readonly unknown[] }).rows;
		assert.equal(rows.length, 4);
		await pool.closeAll();
	});

	it('sample() applies = filter', async () => {
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const driver = await pool.acquire('orders');
		const res = await (driver as { sample: (t: string | undefined, o: unknown) => Promise<unknown> }).sample(
			undefined,
			{ limit: 10, where: [{ column: 'customer', op: '=', value: 'alice' }] },
		);
		const rows = (res as { rows: { customer: string }[] }).rows;
		assert.equal(rows.length, 2);
		assert.ok(rows.every(r => r.customer === 'alice'));
		await pool.closeAll();
	});

	it('sample() respects limit + sets truncated=true', async () => {
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const driver = await pool.acquire('orders');
		const res = await (driver as { sample: (t: string | undefined, o: { limit: number }) => Promise<unknown> }).sample(undefined, { limit: 2 });
		const { rows, truncated } = res as { rows: unknown[]; truncated: boolean };
		assert.equal(rows.length, 2);
		assert.equal(truncated, true);
		await pool.closeAll();
	});

	it('pool rejects file paths that escape the repo', async () => {
		const badRoot = mkdtempSync(join(tmpdir(), 'insrc-csv-bad-'));
		const path = connectionsPath(badRoot);
		await mkdir(join(path, '..'), { recursive: true });
		await writeFile(path, JSON.stringify({
			connections: [{ id: 'escape', kind: 'csv', path: '../../etc/passwd' }],
		}), 'utf8');
		const pool = new DriverPool(badRoot);
		await pool.reload();
		await assert.rejects(pool.acquire('escape'), /resolves outside the repo root/);
		rmSync(badRoot, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------

after(() => {
	if (originalHome !== undefined) { process.env['HOME'] = originalHome; }
	else { delete process.env['HOME']; }
	try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
	try { rmSync(repoRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
