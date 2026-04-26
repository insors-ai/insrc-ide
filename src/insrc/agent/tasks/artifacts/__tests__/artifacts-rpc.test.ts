/**
 * Tests for daemon/artifacts-rpc.ts -- listTemplates /
 * ensureUserTemplate / resetUserTemplate RPC handlers.
 *
 * Uses the test-only `ensureUserTemplate(params, userDir)` +
 * `resetUserTemplate(params, userDir)` entry points so the suite
 * can redirect writes into a tmp dir without polluting the real
 * `~/.insrc/artifacts/templates/`.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
	ensureUserTemplate,
	listTemplatesRpc,
	resetUserTemplate,
} from '../../../../daemon/artifacts-rpc.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTempUserDir<T>(fn: (userDir: string) => Promise<T>): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), 'insrc-arpc-'));
	return fn(root).finally(() => {
		try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
	});
}

// ---------------------------------------------------------------------------
// listTemplatesRpc
// ---------------------------------------------------------------------------

describe('listTemplatesRpc', () => {
	it('returns one entry per known kind, defaulting to bundled', async () => {
		const infos = await listTemplatesRpc({});
		const kinds = infos.map(i => i.kind).sort();
		assert.deepEqual(kinds, ['callflow', 'deployment', 'er', 'flow', 'sequence', 'wireframe']);
		for (const info of infos) {
			assert.ok(
				info.layer === 'bundled' || info.layer === 'user' || info.layer === 'repo',
				`unexpected layer for ${info.kind}: ${info.layer}`,
			);
			assert.ok(info.path.length > 0);
			assert.ok(existsSync(info.path), `resolved path should exist: ${info.path}`);
		}
	});

	it('accepts + threads repoRoot through to the loader', async () => {
		// Setting a non-existent repoRoot shouldn't crash -- the loader
		// just skips that layer and falls through.
		const infos = await listTemplatesRpc({ repoRoot: '/tmp/nonexistent-repo-xyz' });
		assert.equal(infos.length, 6);
	});

	it('rejects non-object params silently (treated as empty opts)', async () => {
		// The RPC should accept undefined / null / other garbage inputs
		// without throwing -- default to empty opts.
		const a = await listTemplatesRpc(undefined);
		const b = await listTemplatesRpc(null);
		assert.equal(a.length, 6);
		assert.equal(b.length, 6);
	});
});

// ---------------------------------------------------------------------------
// ensureUserTemplate
// ---------------------------------------------------------------------------

describe('ensureUserTemplate', () => {
	it('seeds from the bundled default when the user override is missing', async () => {
		await withTempUserDir(async userDir => {
			const result = await ensureUserTemplate({ kind: 'er' }, userDir);
			assert.equal(result.kind, 'er');
			assert.equal(result.seeded, true);
			assert.ok(result.userPath.endsWith('er.html'));
			assert.ok(existsSync(result.userPath));

			// The seeded file's contents should match the bundled template.
			const seeded = readFileSync(result.userPath, 'utf8');
			assert.ok(seeded.includes('insrc-artifact-er'), 'expected bundled ER template markers');
			assert.ok(seeded.length > 0);
		});
	});

	it('returns seeded=false when the file already exists', async () => {
		await withTempUserDir(async userDir => {
			// Seed a user file with custom content first.
			mkdirSync(userDir, { recursive: true });
			const existing = join(userDir, 'sequence.html');
			writeFileSync(existing, '<div>user-custom</div>');

			const result = await ensureUserTemplate({ kind: 'sequence' }, userDir);
			assert.equal(result.seeded, false);
			assert.equal(result.userPath, existing);

			// File contents should be untouched.
			const contents = readFileSync(existing, 'utf8');
			assert.equal(contents, '<div>user-custom</div>');
		});
	});

	it('creates the user dir on demand when it does not exist yet', async () => {
		await withTempUserDir(async userDir => {
			// Nested dir that isn't yet created.
			const nested = join(userDir, 'nested', 'templates');
			const result = await ensureUserTemplate({ kind: 'flow' }, nested);
			assert.equal(result.seeded, true);
			assert.ok(existsSync(result.userPath));
			// Parent dir of the seeded file exists.
			assert.ok(statSync(nested).isDirectory());
		});
	});

	it('rejects unknown kinds with a clear message', async () => {
		await withTempUserDir(async userDir => {
			await assert.rejects(
				ensureUserTemplate({ kind: 'nonsense' }, userDir),
				/must be one of/,
			);
		});
	});

	it('rejects missing kind param', async () => {
		await withTempUserDir(async userDir => {
			await assert.rejects(
				ensureUserTemplate({}, userDir),
				/must be one of/,
			);
		});
	});
});

// ---------------------------------------------------------------------------
// resetUserTemplate
// ---------------------------------------------------------------------------

describe('resetUserTemplate', () => {
	it('deletes the user override when present', async () => {
		await withTempUserDir(async userDir => {
			// Seed first.
			await ensureUserTemplate({ kind: 'wireframe' }, userDir);
			const path = join(userDir, 'wireframe.html');
			assert.ok(existsSync(path));

			const result = await resetUserTemplate({ kind: 'wireframe' }, userDir);
			assert.equal(result.kind, 'wireframe');
			assert.equal(result.removedPath, path);
			assert.equal(existsSync(path), false, 'file should be deleted');
		});
	});

	it('returns removedPath=null when no override exists', async () => {
		await withTempUserDir(async userDir => {
			const result = await resetUserTemplate({ kind: 'deployment' }, userDir);
			assert.equal(result.removedPath, null);
		});
	});

	it('rejects unknown kinds', async () => {
		await withTempUserDir(async userDir => {
			await assert.rejects(
				resetUserTemplate({ kind: 'bogus' }, userDir),
				/must be one of/,
			);
		});
	});
});
