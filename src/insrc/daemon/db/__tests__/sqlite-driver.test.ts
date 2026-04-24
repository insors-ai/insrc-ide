/**
 * SQLite driver end-to-end via the pool.
 *
 * Builds a tmp .sqlite file with a small users+orders schema (incl.
 * PK + FK); exercises describe + sample.
 */

import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';

const originalHome = process.env['HOME'];
const tmpHome = mkdtempSync(join(tmpdir(), 'insrc-sqlite-'));
process.env['HOME'] = tmpHome;

await import('../drivers/sqlite.js');
const { DriverPool } = await import('../pool.js');
const { connectionsPath } = await import('../config.js');

const repoRoot = mkdtempSync(join(tmpdir(), 'insrc-sqlite-repo-'));
const dbPath = join(repoRoot, 'app.sqlite');

const seed = new BetterSqlite3(dbPath);
seed.exec(`
	CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
	CREATE TABLE orders (
		id INTEGER PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id),
		amount REAL
	);
	INSERT INTO users (id, name, email) VALUES (1, 'alice', 'a@x'), (2, 'bob', NULL);
	INSERT INTO orders (id, user_id, amount) VALUES (1, 1, 12.5), (2, 2, 7.0), (3, 1, 99.99);
`);
seed.close();

async function writeConn(): Promise<void> {
	const p = connectionsPath(repoRoot);
	await mkdir(join(p, '..'), { recursive: true });
	await writeFile(p, JSON.stringify({
		connections: [{ id: 'app', kind: 'sqlite', path: 'app.sqlite' }],
	}), 'utf8');
}

describe('SqliteDriver (via pool)', () => {
	it('describe returns columns + PK + FK + nullability', async () => {
		await writeConn();
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const drv = await pool.acquire('app');
		assert.equal(drv.family, 'rdbms');

		const schema = await (drv as { describe: (t: string) => Promise<unknown> }).describe('users');
		const cols = (schema as { columns: { name: string; primaryKey?: boolean; nullable?: boolean }[] }).columns;
		const byName = new Map(cols.map(c => [c.name, c]));
		assert.equal(byName.get('id')?.primaryKey, true);
		assert.equal(byName.get('name')?.nullable, false);
		assert.equal(byName.get('email')?.nullable, true);

		const ordersSchema = await (drv as { describe: (t: string) => Promise<unknown> }).describe('orders');
		const ordersCols = (ordersSchema as { columns: { name: string; foreignKey?: { table: string; column: string } }[] }).columns;
		const fk = ordersCols.find(c => c.name === 'user_id')?.foreignKey;
		assert.deepEqual(fk, { table: 'users', column: 'id' });

		await pool.closeAll();
	});

	it('sample with where + limit', async () => {
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const drv = await pool.acquire('app');
		const res = await (drv as { sample: (t: string, o: unknown) => Promise<unknown> }).sample(
			'orders',
			{ limit: 10, where: [{ column: 'user_id', op: '=', value: 1 }] },
		);
		const rows = (res as { rows: { id: number }[] }).rows;
		assert.equal(rows.length, 2);
		assert.deepEqual(rows.map(r => r.id).sort(), [1, 3]);
		await pool.closeAll();
	});

	it('rejects unknown columns in where', async () => {
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const drv = await pool.acquire('app');
		await assert.rejects(
			(drv as { sample: (t: string, o: unknown) => Promise<unknown> }).sample(
				'users',
				{ limit: 10, where: [{ column: 'no_such', op: '=', value: 1 }] },
			),
			/unknown column 'no_such'/,
		);
		await pool.closeAll();
	});

	it('rejects invalid target identifiers', async () => {
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const drv = await pool.acquire('app');
		await assert.rejects(
			(drv as { describe: (t: string) => Promise<unknown> }).describe('users; DROP TABLE users'),
			/invalid table identifier/,
		);
		await pool.closeAll();
	});
});

after(() => {
	if (originalHome !== undefined) { process.env['HOME'] = originalHome; }
	else { delete process.env['HOME']; }
	try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
	try { rmSync(repoRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
