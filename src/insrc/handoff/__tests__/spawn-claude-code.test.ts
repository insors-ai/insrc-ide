/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 2a Day 3 spawn tests.
 *
 * No real `claude` CLI required: each test writes a tiny shell script
 * that mimics the relevant bit of `claude --print` behaviour (echo
 * stdin, exit 0; or sleep + exit; or echo flags as JSON; etc.) and
 * points spawnClaudeCode at it via the `claudeBinPath` test seam.
 *
 * What we pin:
 *   - The right CLI args are passed (allowedTools, disallowedTools, --print).
 *   - The spec lands on stdin.
 *   - Env vars (INSRC_SESSION_TOKEN, INSRC_DAEMON_SOCKET, INSRC_SPEC_ID)
 *     reach the child.
 *   - `.mcp.json` is written into the worktree.
 *   - Timeout kills the process and yields exitCode = -9.
 *   - stdout / stderr / exitCode round-trip through AgentSpawnResult.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgentSubprocess, writeClaudeHooksConfig, writeMcpConfig } from '../spawn/base.js';
import { spawnClaudeCode } from '../spawn/claude-code.js';

const FAKE_MCP_SERVER = '/abs/path/to/insrc-mcp-server.js';

function makeWorktree(): string {
	return mkdtempSync(join(tmpdir(), 'insrc-spawn-test-'));
}

/**
 * Create an executable shell-script stub at `<dir>/<name>` with the
 * given body. Returns the absolute path.
 */
function writeStub(dir: string, name: string, body: string): string {
	const file = join(dir, name);
	writeFileSync(file, `#!/usr/bin/env bash\n${body}`);
	chmodSync(file, 0o755);
	return file;
}

const tokenStub = () => 'stub-token-abc';

// ---------------------------------------------------------------------------
// writeMcpConfig
// ---------------------------------------------------------------------------

test('writeMcpConfig: writes .mcp.json with {mcpServers.insrc: {command: node, args: [<path>]}}', () => {
	const wt = makeWorktree();
	const file = writeMcpConfig(wt, FAKE_MCP_SERVER);
	assert.equal(file, join(wt, '.mcp.json'));
	const block = JSON.parse(readFileSync(file, 'utf8')) as {
		mcpServers: { insrc: { command: string; args: string[] } };
	};
	assert.equal(block.mcpServers.insrc.command, 'node');
	assert.deepEqual(block.mcpServers.insrc.args, [FAKE_MCP_SERVER]);
});

// ---------------------------------------------------------------------------
// runAgentSubprocess (the low-level primitive)
// ---------------------------------------------------------------------------

test('runAgentSubprocess: stdout/exitCode round-trip; spec lands on stdin', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'echo-stdin.sh', 'cat -; exit 0\n');
	const result = await runAgentSubprocess({
		command: bin, args: [], cwd: wt, env: {},
		spec: '# Spec\nhello',
	});
	assert.equal(result.exitCode, 0);
	assert.equal(result.stdout, '# Spec\nhello');
	assert.equal(result.stderr, '');
	assert.ok(result.durationMs >= 0);
});

test('runAgentSubprocess: timeout kills the subprocess and yields exitCode=-9', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'sleep.sh', 'sleep 60\n');
	const result = await runAgentSubprocess({
		command: bin, args: [], cwd: wt, env: {},
		spec: '',
		timeoutMs: 200,
	});
	assert.equal(result.exitCode, -9);
});

test('runAgentSubprocess: spawn error captured as exitCode=-1 with stderr', async () => {
	const result = await runAgentSubprocess({
		command: '/no/such/binary-' + Date.now(), args: [], cwd: tmpdir(), env: {},
		spec: '',
	});
	assert.equal(result.exitCode, -1);
	assert.match(result.stderr, /spawn error|ENOENT/);
});

// ---------------------------------------------------------------------------
// spawnClaudeCode (the high-level wrapper)
// ---------------------------------------------------------------------------

test('spawnClaudeCode: writes .mcp.json into the worktree before spawn', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'noop.sh', 'cat - >/dev/null; exit 0\n');
	await spawnClaudeCode({
		worktreePath:  wt,
		spec:          'spec body',
		sessionId:     'sess-1',
		specId:        'spec-1',
		mcpServerPath: FAKE_MCP_SERVER,
		claudeBinPath: bin,
		issueToken:    tokenStub,
	});
	assert.equal(existsSync(join(wt, '.mcp.json')), true);
});

test('spawnClaudeCode: piping the spec to stdin -- child receives the markdown body verbatim', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'echo-stdin.sh', 'cat -\n');
	const result = await spawnClaudeCode({
		worktreePath:  wt,
		spec:          '# Debug Session\nfix the flake',
		sessionId:     'sess-1',
		specId:        'spec-1',
		mcpServerPath: FAKE_MCP_SERVER,
		claudeBinPath: bin,
		issueToken:    tokenStub,
	});
	assert.equal(result.exitCode, 0);
	assert.equal(result.stdout, '# Debug Session\nfix the flake');
});

test('spawnClaudeCode: default args include --print, --dangerously-skip-permissions, allowed/disallowed tools', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'echo-args.sh', 'printf "%s\\n" "$@"\n');
	const result = await spawnClaudeCode({
		worktreePath:  wt,
		spec:          'unused',
		sessionId:     'sess-1',
		specId:        'spec-1',
		mcpServerPath: FAKE_MCP_SERVER,
		claudeBinPath: bin,
		issueToken:    tokenStub,
	});
	const args = result.stdout.split('\n').filter(s => s.length > 0);
	assert.deepEqual(args, [
		'--print',
		'--dangerously-skip-permissions',
		'--allowedTools',    'Read,Grep,Bash,Edit,Write',
		'--disallowedTools', 'WebFetch,WebSearch',
	]);
});

test('spawnClaudeCode: custom allowedTools / disallowedTools propagate (with the default permission bypass)', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'echo-args.sh', 'printf "%s\\n" "$@"\n');
	const result = await spawnClaudeCode({
		worktreePath:    wt,
		spec:            'unused',
		sessionId:       'sess-1',
		specId:          'spec-1',
		mcpServerPath:   FAKE_MCP_SERVER,
		allowedTools:    ['Read', 'Grep'],
		disallowedTools: ['WebFetch'],
		claudeBinPath:   bin,
		issueToken:      tokenStub,
	});
	const args = result.stdout.split('\n').filter(s => s.length > 0);
	assert.deepEqual(args, [
		'--print',
		'--dangerously-skip-permissions',
		'--allowedTools',    'Read,Grep',
		'--disallowedTools', 'WebFetch',
	]);
});

test('spawnClaudeCode: skipClaudePermissions=false -> omit --dangerously-skip-permissions (caller opt-out)', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'echo-args.sh', 'printf "%s\\n" "$@"\n');
	const result = await spawnClaudeCode({
		worktreePath:           wt,
		spec:                   'unused',
		sessionId:              'sess-1',
		specId:                 'spec-1',
		mcpServerPath:          FAKE_MCP_SERVER,
		claudeBinPath:          bin,
		issueToken:             tokenStub,
		skipClaudePermissions:  false,
	});
	const args = result.stdout.split('\n').filter(s => s.length > 0);
	assert.deepEqual(args, [
		'--print',
		'--allowedTools',    'Read,Grep,Bash,Edit,Write',
		'--disallowedTools', 'WebFetch,WebSearch',
	]);
});

test('spawnClaudeCode: env vars INSRC_SESSION_TOKEN, INSRC_DAEMON_SOCKET, INSRC_SPEC_ID reach the child', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'dump-env.sh',
		'echo "T:$INSRC_SESSION_TOKEN"\necho "S:$INSRC_DAEMON_SOCKET"\necho "I:$INSRC_SPEC_ID"\n');
	const result = await spawnClaudeCode({
		worktreePath:  wt,
		spec:          'unused',
		sessionId:     'sess-7',
		specId:        'spec-7',
		mcpServerPath: FAKE_MCP_SERVER,
		claudeBinPath: bin,
		issueToken:    () => 'tok-xyz',
	});
	assert.equal(result.exitCode, 0);
	const lines = result.stdout.split('\n');
	assert.equal(lines[0], 'T:tok-xyz');
	assert.match(lines[1]!, /^S:.*daemon\.sock$/);
	assert.equal(lines[2], 'I:spec-7');
});

test('spawnClaudeCode: spawn-failure case surfaces exitCode=-1 + stderr; never throws', async () => {
	const wt = makeWorktree();
	const result = await spawnClaudeCode({
		worktreePath:  wt,
		spec:          '',
		sessionId:     'sess-1',
		specId:        'spec-1',
		mcpServerPath: FAKE_MCP_SERVER,
		claudeBinPath: '/no/such/claude-' + Date.now(),
		issueToken:    tokenStub,
	});
	assert.equal(result.exitCode, -1);
	assert.match(result.stderr, /spawn error|ENOENT/);
});

test('spawnClaudeCode: timeout forwarded to the subprocess', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'long.sh', 'sleep 60\n');
	const result = await spawnClaudeCode({
		worktreePath:  wt,
		spec:          '',
		sessionId:     'sess-1',
		specId:        'spec-1',
		mcpServerPath: FAKE_MCP_SERVER,
		claudeBinPath: bin,
		timeoutMs:     200,
		issueToken:    tokenStub,
	});
	assert.equal(result.exitCode, -9);
});

// ---------------------------------------------------------------------------
// Phase 3 Day 4: hook config writer + INSRC_SESSION_ID env
// ---------------------------------------------------------------------------

test('writeClaudeHooksConfig: writes .claude/settings.json with PreToolUse pointing at the hook bin', () => {
	const wt = makeWorktree();
	const file = writeClaudeHooksConfig(wt, '/abs/path/insrc-permission-hook.js');
	assert.equal(file, join(wt, '.claude', 'settings.json'));
	const block = JSON.parse(readFileSync(file, 'utf8')) as {
		hooks: { PreToolUse: { matcher: { type: string }; command: string }[] };
	};
	assert.equal(block.hooks.PreToolUse.length, 1);
	assert.equal(block.hooks.PreToolUse[0]!.command,       '/abs/path/insrc-permission-hook.js');
	assert.equal(block.hooks.PreToolUse[0]!.matcher.type,  'all');
});

test('spawnClaudeCode: hookBinPath set -> .claude/settings.json written before spawn', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'noop.sh', 'cat - >/dev/null; exit 0\n');
	await spawnClaudeCode({
		worktreePath:  wt,
		spec:          '',
		sessionId:     'sess-1',
		specId:        'spec-1',
		mcpServerPath: FAKE_MCP_SERVER,
		claudeBinPath: bin,
		hookBinPath:   '/abs/path/insrc-permission-hook.js',
		issueToken:    tokenStub,
	});
	assert.equal(existsSync(join(wt, '.claude', 'settings.json')), true);
});

test('spawnClaudeCode: hookBinPath undefined -> NO .claude/settings.json written (Mode B opt-in)', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'noop.sh', 'cat - >/dev/null; exit 0\n');
	await spawnClaudeCode({
		worktreePath:  wt,
		spec:          '',
		sessionId:     'sess-1',
		specId:        'spec-1',
		mcpServerPath: FAKE_MCP_SERVER,
		claudeBinPath: bin,
		// hookBinPath: undefined
		issueToken:    tokenStub,
	});
	assert.equal(existsSync(join(wt, '.claude', 'settings.json')), false);
});

test('spawnClaudeCode: INSRC_SESSION_ID env var is always set, regardless of hookBinPath', async () => {
	const wt = makeWorktree();
	const bin = writeStub(wt, 'dump-env.sh',
		'echo "I:$INSRC_SESSION_ID"\necho "T:$INSRC_SESSION_TOKEN"\n');
	const result = await spawnClaudeCode({
		worktreePath:  wt,
		spec:          '',
		sessionId:     'sess-42',
		specId:        'spec-42',
		mcpServerPath: FAKE_MCP_SERVER,
		claudeBinPath: bin,
		issueToken:    () => 'tok-xyz',
	});
	assert.equal(result.exitCode, 0);
	const lines = result.stdout.split('\n');
	assert.equal(lines[0], 'I:sess-42');
	assert.equal(lines[1], 'T:tok-xyz');
});
