/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 4 Day 1 spawnCodex tests.
 *
 * Mirrors spawn-claude-code.test.ts structure: stub `codex` script
 * + the Day-1 hook config + MCP config writers. No real Codex CLI
 * required.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeCodexHooksConfig, writeCodexMcpConfig } from '../spawn/base.js';
import { spawnCodex } from '../spawn/codex.js';

const FAKE_MCP_SERVER = '/abs/path/to/insrc-mcp-server.js';
const FAKE_HOOK_BIN   = '/abs/path/to/insrc-permission-hook.js';

function makeWorktree(): string {
	return mkdtempSync(join(tmpdir(), 'insrc-codex-test-'));
}

function writeStub(dir: string, name: string, body: string): string {
	const file = join(dir, name);
	writeFileSync(file, `#!/usr/bin/env bash\n${body}`);
	chmodSync(file, 0o755);
	return file;
}

const tokenStub = () => 'stub-token-abc';

// ---------------------------------------------------------------------------
// writeCodexMcpConfig
// ---------------------------------------------------------------------------

test('writeCodexMcpConfig: writes .codex/config.toml with [mcp_servers.insrc] block + env_vars', () => {
	const wt = makeWorktree();
	const file = writeCodexMcpConfig(wt, FAKE_MCP_SERVER);
	assert.equal(file, join(wt, '.codex', 'config.toml'));
	const body = readFileSync(file, 'utf8');
	assert.match(body, /\[mcp_servers\.insrc\]/);
	assert.match(body, /command = "node"/);
	assert.match(body, new RegExp(`args = \\["${FAKE_MCP_SERVER}"\\]`));
	assert.match(body, /env_vars = \["INSRC_SESSION_TOKEN", "INSRC_SESSION_ID", "INSRC_DAEMON_SOCKET", "INSRC_SPEC_ID"\]/);
});

test('writeCodexMcpConfig: backslashes and quotes in server path are TOML-escaped', () => {
	const wt = makeWorktree();
	const tricky = '/path with spaces/and"quote/server.js';
	const file = writeCodexMcpConfig(wt, tricky);
	const body = readFileSync(file, 'utf8');
	assert.match(body, /and\\"quote/);
});

// ---------------------------------------------------------------------------
// writeCodexHooksConfig
// ---------------------------------------------------------------------------

test('writeCodexHooksConfig: writes .codex/hooks.json with both PreToolUse and PermissionRequest pointing at the hook bin', () => {
	const wt = makeWorktree();
	const file = writeCodexHooksConfig(wt, FAKE_HOOK_BIN);
	assert.equal(file, join(wt, '.codex', 'hooks.json'));
	const arr = JSON.parse(readFileSync(file, 'utf8')) as { event: string; matcher: { tool: string }; command: string }[];
	assert.equal(arr.length, 2);
	const events = arr.map(e => e.event);
	assert.ok(events.includes('PreToolUse'));
	assert.ok(events.includes('PermissionRequest'));
	for (const e of arr) {
		assert.equal(e.matcher.tool, '*');
		assert.equal(e.command,      FAKE_HOOK_BIN);
	}
});

// ---------------------------------------------------------------------------
// spawnCodex (the high-level wrapper)
// ---------------------------------------------------------------------------

test('spawnCodex: writes .codex/config.toml into the worktree before spawn', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'noop.sh', 'cat - >/dev/null; exit 0\n');
	await spawnCodex({
		worktreePath:  wt,
		spec:          'spec body',
		sessionId:     'sess-1',
		specId:        'spec-1',
		mcpServerPath: FAKE_MCP_SERVER,
		codexBinPath:  bin,
		issueToken:    tokenStub,
	});
	assert.equal(existsSync(join(wt, '.codex', 'config.toml')), true);
});

test('spawnCodex: hookBinPath set -> .codex/hooks.json written before spawn', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'noop.sh', 'cat - >/dev/null; exit 0\n');
	await spawnCodex({
		worktreePath:  wt,
		spec:          'spec body',
		sessionId:     'sess-1',
		specId:        'spec-1',
		mcpServerPath: FAKE_MCP_SERVER,
		hookBinPath:   FAKE_HOOK_BIN,
		codexBinPath:  bin,
		issueToken:    tokenStub,
	});
	assert.equal(existsSync(join(wt, '.codex', 'hooks.json')), true);
});

test('spawnCodex: hookBinPath undefined -> NO .codex/hooks.json written (Mode B opt-in)', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'noop.sh', 'cat - >/dev/null; exit 0\n');
	await spawnCodex({
		worktreePath:  wt,
		spec:          'spec body',
		sessionId:     'sess-1',
		specId:        'spec-1',
		mcpServerPath: FAKE_MCP_SERVER,
		codexBinPath:  bin,
		issueToken:    tokenStub,
	});
	assert.equal(existsSync(join(wt, '.codex', 'hooks.json')), false);
});

test('spawnCodex: spec is piped to codex stdin verbatim', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'echo-stdin.sh', 'cat -\n');
	const result = await spawnCodex({
		worktreePath:  wt,
		spec:          '# Debug Session\nfix the flake',
		sessionId:     'sess-1',
		specId:        'spec-1',
		mcpServerPath: FAKE_MCP_SERVER,
		codexBinPath:  bin,
		issueToken:    tokenStub,
	});
	assert.equal(result.exitCode, 0);
	assert.equal(result.stdout, '# Debug Session\nfix the flake');
});

test('spawnCodex: default flags == exec --cd <wt> --add-dir <wt> --sandbox workspace-write --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'echo-args.sh', 'printf "%s\\n" "$@"\n');
	const result = await spawnCodex({
		worktreePath:  wt,
		spec:          'unused',
		sessionId:     'sess-1',
		specId:        'spec-1',
		mcpServerPath: FAKE_MCP_SERVER,
		codexBinPath:  bin,
		issueToken:    tokenStub,
	});
	const args = result.stdout.split('\n').filter(s => s.length > 0);
	assert.deepEqual(args, [
		'exec',
		'--cd',      wt,
		'--add-dir', wt,
		'--sandbox', 'workspace-write',
		'--skip-git-repo-check',
		'--dangerously-bypass-approvals-and-sandbox',
	]);
});

test('spawnCodex: custom sandboxMode propagates (other defaults preserved)', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'echo-args.sh', 'printf "%s\\n" "$@"\n');
	const result = await spawnCodex({
		worktreePath:  wt,
		spec:          'unused',
		sessionId:     'sess-1',
		specId:        'spec-1',
		mcpServerPath: FAKE_MCP_SERVER,
		sandboxMode:   'read-only',
		codexBinPath:  bin,
		issueToken:    tokenStub,
	});
	const args = result.stdout.split('\n').filter(s => s.length > 0);
	assert.deepEqual(args, [
		'exec',
		'--cd',      wt,
		'--add-dir', wt,
		'--sandbox', 'read-only',
		'--skip-git-repo-check',
		'--dangerously-bypass-approvals-and-sandbox',
	]);
});

test('spawnCodex: skipApprovalsAndSandbox=false omits the bypass flag', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'echo-args.sh', 'printf "%s\\n" "$@"\n');
	const result = await spawnCodex({
		worktreePath:           wt,
		spec:                   'unused',
		sessionId:              'sess-1',
		specId:                 'spec-1',
		mcpServerPath:          FAKE_MCP_SERVER,
		codexBinPath:           bin,
		issueToken:             tokenStub,
		skipApprovalsAndSandbox: false,
	});
	const args = result.stdout.split('\n').filter(s => s.length > 0);
	assert.deepEqual(args, [
		'exec',
		'--cd',      wt,
		'--add-dir', wt,
		'--sandbox', 'workspace-write',
		'--skip-git-repo-check',
	]);
});

test('spawnCodex: hookBinPath set -> args include --dangerously-bypass-hook-trust', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'echo-args.sh', 'printf "%s\\n" "$@"\n');
	const result = await spawnCodex({
		worktreePath:  wt,
		spec:          'unused',
		sessionId:     'sess-1',
		specId:        'spec-1',
		mcpServerPath: FAKE_MCP_SERVER,
		hookBinPath:   FAKE_HOOK_BIN,
		codexBinPath:  bin,
		issueToken:    tokenStub,
	});
	const args = result.stdout.split('\n').filter(s => s.length > 0);
	assert.ok(args.includes('--dangerously-bypass-hook-trust'),
		`expected --dangerously-bypass-hook-trust in ${JSON.stringify(args)}`);
});

test('spawnCodex: env vars INSRC_SESSION_TOKEN, SESSION_ID, DAEMON_SOCKET, SPEC_ID reach the child', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'dump-env.sh',
		'echo "T:$INSRC_SESSION_TOKEN"\necho "I:$INSRC_SESSION_ID"\necho "S:$INSRC_DAEMON_SOCKET"\necho "P:$INSRC_SPEC_ID"\n');
	const result = await spawnCodex({
		worktreePath:  wt,
		spec:          'unused',
		sessionId:     'sess-99',
		specId:        'spec-99',
		mcpServerPath: FAKE_MCP_SERVER,
		codexBinPath:  bin,
		issueToken:    () => 'tok-codex',
	});
	const lines = result.stdout.split('\n');
	assert.equal(lines[0], 'T:tok-codex');
	assert.equal(lines[1], 'I:sess-99');
	assert.match(lines[2]!, /^S:.*daemon\.sock$/);
	assert.equal(lines[3], 'P:spec-99');
});

test('spawnCodex: spawn-failure case surfaces exitCode=-1 + stderr; never throws', async () => {
	const wt = makeWorktree();
	const result = await spawnCodex({
		worktreePath:  wt,
		spec:          '',
		sessionId:     'sess-1',
		specId:        'spec-1',
		mcpServerPath: FAKE_MCP_SERVER,
		codexBinPath:  '/no/such/codex-' + Date.now(),
		issueToken:    tokenStub,
	});
	assert.equal(result.exitCode, -1);
	assert.match(result.stderr, /spawn error|ENOENT/);
});

test('spawnCodex: timeout forwarded to the subprocess', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'long.sh', 'sleep 60\n');
	const result = await spawnCodex({
		worktreePath:  wt,
		spec:          '',
		sessionId:     'sess-1',
		specId:        'spec-1',
		mcpServerPath: FAKE_MCP_SERVER,
		codexBinPath:  bin,
		timeoutMs:     200,
		issueToken:    tokenStub,
	});
	assert.equal(result.exitCode, -9);
});
