/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * End-to-end integration test for the MCP server against a live insrc
 * daemon.
 *
 * Spawns the COMPILED `out/insrc/mcp/server.js` -- not the .ts source --
 * so this test covers the same path a user gets after
 * `node out/insrc/cli/index.js mcp-setup claude-code`: post-build
 * binary, real stdio handshake, real daemon round-trip.
 *
 * Gated: opt-in via `INSRC_TEST_INTEGRATION=1`. CI without a daemon
 * (or running on a machine where these prerequisites aren't met)
 * silently skips. The gating sentinel is also reported once per run
 * so it's obvious the gate is doing its job.
 *
 * Prerequisites for the gate to be honored:
 *   1. `INSRC_TEST_INTEGRATION=1` in the env.
 *   2. `out/insrc/mcp/server.js` exists (i.e. the project is built).
 *   3. The daemon is running (~/.insrc/daemon.sock exists).
 *
 * The assertions deliberately do NOT depend on specific data being
 * indexed -- empty closures, unknown entity ids, and no-hit queries
 * are all valid responses we assert against. That way the test
 * passes against any local daemon, not just a freshly seeded one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, symlinkSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Compiled server binary. Note: this path is *relative to the compiled
// test file's location* under `out/insrc/mcp/__tests__/`. We resolve
// to `out/insrc/mcp/server.js`. When run via tsx against the source
// (src/insrc/mcp/__tests__/), we still resolve to the compiled out/
// path -- that's the file mcp-setup writes into Claude/Codex configs.
// __dirname = .../src/insrc/mcp/__tests__  --> 4 levels up == repo root.
const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..');
const SERVER_JS  = join(REPO_ROOT, 'out', 'insrc', 'mcp', 'server.js');
const SOCK_PATH  = join(homedir(), '.insrc', 'daemon.sock');

/**
 * The production IDE install bootstraps a symlink
 * `out/insrc/node_modules -> ../../src/insrc/node_modules` so the
 * compiled MCP server can resolve `@modelcontextprotocol/sdk` etc.
 * (Node ESM resolves relative to the .js file's location, not cwd.)
 *
 * The repo's own `out/insrc/` doesn't have this symlink unless we
 * create it. Set it up lazily so the test is self-sufficient on a
 * fresh build; matches the runtime contract the IDE bootstrap
 * documents.
 */
function ensureNodeModulesSymlink(): void {
	const outNodeModules = join(REPO_ROOT, 'out', 'insrc', 'node_modules');
	if (existsSync(outNodeModules)) return;
	try {
		const target = join('..', '..', 'src', 'insrc', 'node_modules');
		symlinkSync(target, outNodeModules);
	} catch {
		// Best effort: if creation fails (e.g. EEXIST race), the next
		// run will see the symlink exist anyway.
	}
}

function shouldSkip(): string | null {
	if (process.env['INSRC_TEST_INTEGRATION'] !== '1') {
		return 'INSRC_TEST_INTEGRATION!=1; skipping';
	}
	if (!existsSync(SERVER_JS)) {
		return `compiled server not found at ${SERVER_JS}; run scripts/build.sh first`;
	}
	try {
		const s = statSync(SOCK_PATH);
		if (!s.isSocket()) return `${SOCK_PATH} exists but is not a Unix socket`;
	} catch {
		return `daemon socket ${SOCK_PATH} not present; start the daemon first`;
	}
	// Sanity: confirm node_modules is reachable from out/insrc/.
	const outNodeModules = join(REPO_ROOT, 'out', 'insrc', 'node_modules');
	try {
		const l = lstatSync(outNodeModules);
		if (!l.isSymbolicLink() && !l.isDirectory()) {
			return `${outNodeModules} exists but is neither a symlink nor a directory`;
		}
	} catch {
		ensureNodeModulesSymlink();
		if (!existsSync(outNodeModules)) {
			return `${outNodeModules} missing and could not auto-link to src/insrc/node_modules`;
		}
	}
	return null;
}

function spawnClient(): Promise<Client> {
	const transport = new StdioClientTransport({
		command: 'node',
		args:    [SERVER_JS],
	});
	const client = new Client({ name: 'insrc-mcp-integration', version: '0.0.1' });
	return client.connect(transport).then(() => client);
}

function readJsonContent(content: unknown): unknown {
	const arr = content as { type: string; text: string }[];
	assert.ok(Array.isArray(arr) && arr.length > 0, 'expected non-empty content array');
	assert.equal(arr[0]!.type, 'text');
	return JSON.parse(arr[0]!.text);
}

/**
 * The daemon IPCs `entity.summary`, `entity.closure`, `entity.unreachable`,
 * `artifact.get`, `artifact.search`, `repo.depends_on`, and
 * `repo.search_cross_repo` were added in Phase 1 Day 2/2.5. If the
 * running daemon was launched before those commits, calls to those
 * IPCs return `unknown method: <name>` as a tool error. Detect that
 * and surface as a skip, not a failure -- the integration test
 * shouldn't break when the developer simply hasn't restarted the
 * daemon to pick up post-Day-2 code.
 */
function isStaleDaemon(res: { isError?: boolean; content?: unknown }): boolean {
	if (res.isError !== true) return false;
	const arr = res.content as { text?: string }[] | undefined;
	const txt = arr?.[0]?.text ?? '';
	return /unknown method:/.test(txt);
}

test('integration: tools/list returns all 14 tools against the compiled server', async (t) => {
	const skip = shouldSkip();
	if (skip !== null) { t.skip(skip); return; }

	const client = await spawnClient();
	try {
		const { tools } = await client.listTools();
		assert.equal(tools.length, 14);
		const familyCount: Record<string, number> = {};
		for (const tool of tools) {
			const fam = tool.name.split('_')[1]!;
			familyCount[fam] = (familyCount[fam] ?? 0) + 1;
		}
		assert.deepEqual(
			familyCount,
			{ entity: 6, artifact: 2, memory: 2, repo: 2, spec: 2 },
			`unexpected per-family counts: ${JSON.stringify(familyCount)}`,
		);
	} finally {
		try { await client.close(); } catch { /* swallow */ }
	}
});

test('integration: insrc_entity_summary with a fake id returns isError (null-hit path)', async (t) => {
	const skip = shouldSkip();
	if (skip !== null) { t.skip(skip); return; }

	const client = await spawnClient();
	try {
		const res = await client.callTool({
			name: 'insrc_entity_summary',
			arguments: { entityId: 'definitely-not-a-real-entity-id-xyz-' + Date.now() },
		});
		if (isStaleDaemon(res)) {
			t.skip('running daemon predates entity.summary IPC (Day 2); restart daemon to enable');
			return;
		}
		assert.equal(res.isError, true, `expected isError=true; got ${JSON.stringify(res)}`);
		const content = res.content as { type: string; text: string }[] | undefined;
		assert.ok(Array.isArray(content) && content.length > 0);
		assert.match(content[0]!.text, /not found/);
	} finally {
		try { await client.close(); } catch { /* swallow */ }
	}
});

test('integration: insrc_entity_search returns a well-shaped { hits } payload (live ANN)', async (t) => {
	const skip = shouldSkip();
	if (skip !== null) { t.skip(skip); return; }

	const client = await spawnClient();
	try {
		const res = await client.callTool({
			name: 'insrc_entity_search',
			arguments: { query: 'integration test sentinel ' + Date.now(), limit: 5 },
		});
		// We don't care WHAT comes back -- depends on what's indexed --
		// but the SHAPE must be `{ hits: [...] }`. Empty array is fine.
		assert.notEqual(res.isError, true, `unexpected isError: ${JSON.stringify(res)}`);
		const payload = readJsonContent(res.content) as { hits: unknown };
		assert.ok(Array.isArray(payload.hits), `expected hits to be an array; got ${typeof payload.hits}`);
	} finally {
		try { await client.close(); } catch { /* swallow */ }
	}
});

test('integration: insrc_repo_depends_on for a non-existent repoId returns an empty closure', async (t) => {
	const skip = shouldSkip();
	if (skip !== null) { t.skip(skip); return; }

	const client = await spawnClient();
	try {
		const fakeRepo = '/nowhere/this/repo/does/not/exist-' + Date.now();
		const res = await client.callTool({
			name: 'insrc_repo_depends_on',
			arguments: { repoId: fakeRepo },
		});
		if (isStaleDaemon(res)) {
			t.skip('running daemon predates repo.depends_on IPC (Day 2.5); restart daemon to enable');
			return;
		}
		assert.notEqual(res.isError, true, `unexpected isError: ${JSON.stringify(res)}`);
		const payload = readJsonContent(res.content) as { closure: unknown; count: number };
		assert.ok(Array.isArray(payload.closure), 'expected closure to be an array');
		assert.equal(payload.closure.length, 0, 'expected empty closure for a non-existent repo');
		assert.equal(payload.count, 0);
	} finally {
		try { await client.close(); } catch { /* swallow */ }
	}
});

test('integration: insrc_artifact_get without a session token short-circuits to isError', async (t) => {
	const skip = shouldSkip();
	if (skip !== null) { t.skip(skip); return; }

	// Session-scoped tools must reject when INSRC_SESSION_TOKEN is not
	// set. This goes through the same registry gate as the smoke test
	// but verifies it survives the compiled build path.
	const client = await spawnClient();
	try {
		const res = await client.callTool({
			name: 'insrc_artifact_get',
			arguments: { artifactId: 'art-x' },
		});
		assert.equal(res.isError, true);
		const content = res.content as { type: string; text: string }[];
		assert.match(content[0]!.text, /session token/i);
	} finally {
		try { await client.close(); } catch { /* swallow */ }
	}
});
