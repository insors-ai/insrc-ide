/**
 * JSON driver end-to-end: both record-array mode (rdbms-shape) and
 * single-doc mode (kv-shape via get / sampleShape).
 */

import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalHome = process.env['HOME'];
const tmpHome = mkdtempSync(join(tmpdir(), 'insrc-json-'));
process.env['HOME'] = tmpHome;

await import('../drivers/json.js');
const { DriverPool } = await import('../pool.js');
const { connectionsPath } = await import('../config.js');

const repoRoot = mkdtempSync(join(tmpdir(), 'insrc-json-repo-'));

writeFileSync(join(repoRoot, 'users.json'), JSON.stringify([
	{ id: 1, name: 'alice', active: true },
	{ id: 2, name: 'bob', active: false },
	{ id: 3, name: 'carol', active: true },
]), 'utf8');

writeFileSync(join(repoRoot, 'config.json'), JSON.stringify({
	name: 'app',
	version: '1.0.0',
	database: { host: 'localhost', port: 5432 },
}), 'utf8');

async function writeConns(): Promise<void> {
	const p = connectionsPath(repoRoot);
	await mkdir(join(p, '..'), { recursive: true });
	await writeFile(p, JSON.stringify({
		connections: [
			{ id: 'users', kind: 'json', path: 'users.json' },
			{ id: 'config', kind: 'json', path: 'config.json' },
		],
	}), 'utf8');
}

describe('JsonDriver -- record-array mode', () => {
	it('describe + sample with where', async () => {
		await writeConns();
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const drv = await pool.acquire('users');
		const schema = await (drv as { describe: () => Promise<unknown> }).describe();
		const cols = (schema as { columns: { name: string }[] }).columns.map(c => c.name);
		assert.deepEqual(cols.sort(), ['active', 'id', 'name']);

		const res = await (drv as { sample: (t: string | undefined, o: unknown) => Promise<unknown> }).sample(
			undefined,
			{ limit: 10, where: [{ column: 'active', op: '=', value: true }] },
		);
		const rows = (res as { rows: { name: string }[] }).rows;
		assert.equal(rows.length, 2);
		assert.deepEqual(rows.map(r => r.name).sort(), ['alice', 'carol']);
		await pool.closeAll();
	});
});

describe('JsonDriver -- single-doc mode', () => {
	it('get root returns the full doc', async () => {
		await writeConns();
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const drv = await pool.acquire('config');
		const root = await (drv as { get: (p: string) => Promise<unknown> }).get('');
		assert.equal((root as { type: string }).type, 'object');
		assert.equal(((root as { value: { name: string } }).value).name, 'app');
		await pool.closeAll();
	});

	it('get with JSON pointer resolves nested fields', async () => {
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const drv = await pool.acquire('config');
		const host = await (drv as { get: (p: string) => Promise<unknown> }).get('/database/host');
		assert.equal((host as { value: string }).value, 'localhost');
		const port = await (drv as { get: (p: string) => Promise<unknown> }).get('/database/port');
		assert.equal((port as { value: number }).value, 5432);
		await pool.closeAll();
	});

	it('describe on a single-doc rejects with a typed message', async () => {
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const drv = await pool.acquire('config');
		await assert.rejects(
			(drv as { describe: () => Promise<unknown> }).describe(),
			/use db\.file\.sample_shape \/ db\.file\.get instead/,
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
