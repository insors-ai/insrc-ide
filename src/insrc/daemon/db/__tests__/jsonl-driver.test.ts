/**
 * JSONL driver end-to-end via the pool.
 */

import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalHome = process.env['HOME'];
const tmpHome = mkdtempSync(join(tmpdir(), 'insrc-jsonl-'));
process.env['HOME'] = tmpHome;

await import('../drivers/jsonl.js');
const { DriverPool } = await import('../pool.js');
const { connectionsPath } = await import('../config.js');

const repoRoot = mkdtempSync(join(tmpdir(), 'insrc-jsonl-repo-'));
writeFileSync(join(repoRoot, 'events.jsonl'), [
	'{"id":1,"type":"login","user":"alice","at":100}',
	'',
	'{"id":2,"type":"login","user":"bob","at":101}',
	'{"id":3,"type":"logout","user":"alice","at":150,"reason":null}',
	'{"id":4,"type":"login","user":"alice","at":200}',
].join('\n'), 'utf8');

async function writeConn(): Promise<void> {
	const p = connectionsPath(repoRoot);
	await mkdir(join(p, '..'), { recursive: true });
	await writeFile(p, JSON.stringify({
		connections: [{ id: 'events', kind: 'jsonl', path: 'events.jsonl' }],
	}), 'utf8');
}

describe('JsonlDriver (via pool)', () => {
	it('describe + sample + where', async () => {
		await writeConn();
		const pool = new DriverPool(repoRoot);
		await pool.reload();
		const drv = await pool.acquire('events');
		const schema = await (drv as { describe: () => Promise<unknown> }).describe();
		const cols = (schema as { columns: { name: string }[] }).columns.map(c => c.name);
		assert.deepEqual(cols.sort(), ['at', 'id', 'reason', 'type', 'user']);

		const res = await (drv as { sample: (t: string | undefined, o: unknown) => Promise<unknown> }).sample(
			undefined,
			{ limit: 10, where: [{ column: 'user', op: '=', value: 'alice' }] },
		);
		const rows = (res as { rows: { user: string }[] }).rows;
		assert.equal(rows.length, 3);
		assert.ok(rows.every(r => r.user === 'alice'));
		await pool.closeAll();
	});

	it('rejects a file with malformed JSON on one line', async () => {
		const bad = mkdtempSync(join(tmpdir(), 'insrc-jsonl-bad-'));
		writeFileSync(join(bad, 'events.jsonl'), '{"ok":true}\nnot json\n', 'utf8');
		const p = connectionsPath(bad);
		await mkdir(join(p, '..'), { recursive: true });
		await writeFile(p, JSON.stringify({
			connections: [{ id: 'events', kind: 'jsonl', path: 'events.jsonl' }],
		}), 'utf8');
		const pool = new DriverPool(bad);
		await pool.reload();
		const drv = await pool.acquire('events');
		await assert.rejects(
			(drv as { sample: (t: string | undefined, o: unknown) => Promise<unknown> }).sample(undefined, { limit: 10 }),
			/invalid JSON on line 2/,
		);
		rmSync(bad, { recursive: true, force: true });
	});
});

after(() => {
	if (originalHome !== undefined) { process.env['HOME'] = originalHome; }
	else { delete process.env['HOME']; }
	try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
	try { rmSync(repoRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
