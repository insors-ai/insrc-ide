/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc mcp-setup` unit tests.
 *
 * Each test points HOME at a fresh tmp dir so the writer never touches
 * the developer's real ~/.claude or ~/.codex.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMcpSetup, resolveMcpServerPath } from '../mcp-setup.js';

function withTmpHome(): { dir: string; restore: () => void } {
	const dir       = mkdtempSync(join(tmpdir(), 'insrc-mcp-setup-test-'));
	const origHome  = process.env['HOME'];
	process.env['HOME'] = dir;
	return {
		dir,
		restore: () => {
			if (origHome === undefined) delete process.env['HOME'];
			else                        process.env['HOME'] = origHome;
		},
	};
}

const FAKE_SERVER = '/abs/path/to/insrc/mcp/server.js';

// ---------------------------------------------------------------------------
// resolveMcpServerPath
// ---------------------------------------------------------------------------

test('resolveMcpServerPath: --server-path override wins', () => {
	const out = resolveMcpServerPath('/some/abs/path.js');
	assert.equal(out, '/some/abs/path.js');
});

test('resolveMcpServerPath: INSRC_MCP_SERVER_PATH env var is honored', () => {
	const orig = process.env['INSRC_MCP_SERVER_PATH'];
	process.env['INSRC_MCP_SERVER_PATH'] = '/env/path.js';
	try {
		assert.equal(resolveMcpServerPath(), '/env/path.js');
	} finally {
		if (orig === undefined) delete process.env['INSRC_MCP_SERVER_PATH'];
		else                    process.env['INSRC_MCP_SERVER_PATH'] = orig;
	}
});

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

test('mcp-setup claude-code --dry-run: prints config block, writes nothing', () => {
	const { dir, restore } = withTmpHome();
	try {
		const result = runMcpSetup('claude-code', { dryRun: true, serverPath: FAKE_SERVER });
		assert.equal(result.action, 'dry-run');
		assert.equal(result.agent,  'claude-code');
		assert.equal(result.configPath, join(dir, '.claude', 'settings.json'));
		const block = JSON.parse(result.configBlock) as { mcpServers: { insrc: { command: string; args: string[] } } };
		assert.equal(block.mcpServers.insrc.command, 'node');
		assert.deepEqual(block.mcpServers.insrc.args, [FAKE_SERVER]);
		assert.equal(existsSync(result.configPath), false);
	} finally { restore(); }
});

test('mcp-setup claude-code: fresh write -> action=created, file persisted', () => {
	const { restore } = withTmpHome();
	try {
		const result = runMcpSetup('claude-code', { serverPath: FAKE_SERVER });
		assert.equal(result.action, 'created');
		const written = JSON.parse(readFileSync(result.configPath, 'utf8')) as { mcpServers: Record<string, { args: string[] }> };
		assert.deepEqual(written.mcpServers['insrc']?.args, [FAKE_SERVER]);
	} finally { restore(); }
});

test('mcp-setup claude-code: merge into existing settings preserves unrelated keys', () => {
	const { dir, restore } = withTmpHome();
	try {
		mkdirSync(join(dir, '.claude'), { recursive: true });
		writeFileSync(join(dir, '.claude', 'settings.json'),
			JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other-cmd', args: [] } } }, null, 2));
		const result = runMcpSetup('claude-code', { serverPath: FAKE_SERVER });
		assert.equal(result.action, 'merged');
		const written = JSON.parse(readFileSync(result.configPath, 'utf8')) as { theme: string; mcpServers: Record<string, { command: string }> };
		assert.equal(written.theme, 'dark');
		assert.equal(written.mcpServers['other']?.command, 'other-cmd');
		assert.equal(written.mcpServers['insrc']?.command, 'node');
	} finally { restore(); }
});

test('mcp-setup claude-code: re-run with no changes returns action=unchanged', () => {
	const { restore } = withTmpHome();
	try {
		runMcpSetup('claude-code', { serverPath: FAKE_SERVER });
		const second = runMcpSetup('claude-code', { serverPath: FAKE_SERVER });
		assert.equal(second.action, 'unchanged');
	} finally { restore(); }
});

test('mcp-setup claude-code: re-run with a different server path returns action=updated', () => {
	const { restore } = withTmpHome();
	try {
		runMcpSetup('claude-code', { serverPath: FAKE_SERVER });
		const second = runMcpSetup('claude-code', { serverPath: '/different/path.js' });
		assert.equal(second.action, 'updated');
	} finally { restore(); }
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

test('mcp-setup codex --dry-run: prints TOML block, writes nothing', () => {
	const { dir, restore } = withTmpHome();
	try {
		const result = runMcpSetup('codex', { dryRun: true, serverPath: FAKE_SERVER });
		assert.equal(result.action, 'dry-run');
		assert.equal(result.configPath, join(dir, '.codex', 'config.toml'));
		assert.match(result.configBlock, /\[mcp_servers\.insrc\]/);
		assert.match(result.configBlock, /command = "node"/);
		assert.match(result.configBlock, new RegExp(`args = \\["${FAKE_SERVER}"\\]`));
		assert.match(result.configBlock, /env_vars = \["INSRC_SESSION_TOKEN", "INSRC_DAEMON_SOCKET", "INSRC_SPEC_ID"\]/);
		assert.equal(existsSync(result.configPath), false);
	} finally { restore(); }
});

test('mcp-setup codex: fresh write -> action=created, persisted TOML', () => {
	const { restore } = withTmpHome();
	try {
		const result = runMcpSetup('codex', { serverPath: FAKE_SERVER });
		assert.equal(result.action, 'created');
		const written = readFileSync(result.configPath, 'utf8');
		assert.match(written, /\[mcp_servers\.insrc\]/);
	} finally { restore(); }
});

test('mcp-setup codex: appends to existing config that lacks an insrc block', () => {
	const { dir, restore } = withTmpHome();
	try {
		mkdirSync(join(dir, '.codex'), { recursive: true });
		writeFileSync(join(dir, '.codex', 'config.toml'), '[other]\nfoo = "bar"\n');
		const result = runMcpSetup('codex', { serverPath: FAKE_SERVER });
		assert.equal(result.action, 'merged');
		const written = readFileSync(result.configPath, 'utf8');
		assert.match(written, /\[other\]/);
		assert.match(written, /foo = "bar"/);
		assert.match(written, /\[mcp_servers\.insrc\]/);
	} finally { restore(); }
});

test('mcp-setup codex: replaces an existing [mcp_servers.insrc] block when server path differs', () => {
	const { dir, restore } = withTmpHome();
	try {
		mkdirSync(join(dir, '.codex'), { recursive: true });
		writeFileSync(join(dir, '.codex', 'config.toml'),
			`[other]\nfoo = "bar"\n\n[mcp_servers.insrc]\ncommand = "node"\nargs = ["/old/path.js"]\n`);
		const result = runMcpSetup('codex', { serverPath: '/new/path.js' });
		assert.equal(result.action, 'updated');
		const written = readFileSync(result.configPath, 'utf8');
		assert.match(written, /args = \["\/new\/path.js"\]/);
		assert.equal(written.includes('/old/path.js'), false);
		assert.match(written, /\[other\]/);
	} finally { restore(); }
});

test('mcp-setup codex: backslashes and quotes in server path are TOML-escaped', () => {
	const { restore } = withTmpHome();
	try {
		const tricky = '/path with spaces/and"quote/server.js';
		const result = runMcpSetup('codex', { dryRun: true, serverPath: tricky });
		// JSON-style escape of `"` to `\"` plus path passthrough.
		assert.match(result.configBlock, /and\\"quote/);
	} finally { restore(); }
});
