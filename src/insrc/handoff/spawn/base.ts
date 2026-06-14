/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared spawn primitives for handoff subprocess management.
 *
 * Each agent (Claude Code, Codex) gets its own spawn module that
 * composes:
 *
 *   1. `writeMcpConfig` -- drop a worktree-local `.mcp.json` so the
 *      agent auto-discovers the insrc MCP server with a handoff-scoped
 *      session token.
 *   2. `runAgentSubprocess` -- spawn the agent CLI with the spec on
 *      stdin, capture stdout / stderr / exitCode / duration.
 *
 * Design refs:
 *   - design/external-agent-integration.md §6.4 Phase 4 (handoff)
 *   - design/external-agent-integration.md §7.2 session tokens
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getLogger } from '../../shared/logger.js';

const log = getLogger('handoff:spawn');

export interface AgentSpawnResult {
	readonly stdout:    string;
	readonly stderr:    string;
	readonly exitCode:  number;
	readonly durationMs: number;
}

export interface SpawnAgentOpts {
	readonly command:  string;
	readonly args:     readonly string[];
	readonly cwd:      string;
	readonly env:      Record<string, string>;
	/** Markdown spec content piped into the agent's stdin. */
	readonly spec:     string;
	/** Hard timeout. If exceeded, kill the subprocess and resolve with exitCode = -9. */
	readonly timeoutMs?: number | undefined;
}

/**
 * Spawn an agent CLI subprocess, pipe `spec` to stdin, capture stdout
 * and stderr, return on close. Never throws -- errors land in
 * `exitCode` / `stderr` so the caller can route them through the audit
 * pipeline uniformly.
 */
export function runAgentSubprocess(opts: SpawnAgentOpts): Promise<AgentSpawnResult> {
	return new Promise((resolve) => {
		const start = Date.now();
		const child = spawn(opts.command, [...opts.args], {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let timeoutHandle: NodeJS.Timeout | undefined;

		if (opts.timeoutMs !== undefined) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				log.warn({ command: opts.command, timeoutMs: opts.timeoutMs }, 'agent subprocess timed out; killing');
				child.kill('SIGKILL');
			}, opts.timeoutMs);
		}

		child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

		child.on('error', err => {
			if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
			resolve({
				stdout,
				stderr: stderr + `\nspawn error: ${(err as Error).message}`,
				exitCode: -1,
				durationMs: Date.now() - start,
			});
		});

		child.on('close', (exitCode: number | null) => {
			if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
			resolve({
				stdout,
				stderr,
				exitCode: timedOut ? -9 : (exitCode ?? -1),
				durationMs: Date.now() - start,
			});
		});

		// Pipe the spec, then close stdin so the agent sees EOF and
		// proceeds with its `--print` (one-shot) mode.
		child.stdin.end(opts.spec);
	});
}

/**
 * Write a worktree-local `.mcp.json` so the spawned agent
 * auto-registers the insrc MCP server with the supplied session
 * token. Format mirrors `insrc mcp-setup claude-code` -- mcpServers
 * map, command=node, args=[<server-path>].
 *
 * Returns the path to the file actually written (useful for tests).
 */
export function writeMcpConfig(worktreePath: string, serverPath: string): string {
	const file = join(worktreePath, '.mcp.json');
	const block = {
		mcpServers: {
			insrc: {
				command: 'node',
				args:    [serverPath],
			},
		},
	};
	mkdirSync(worktreePath, { recursive: true });
	writeFileSync(file, JSON.stringify(block, null, 2));
	return file;
}

/**
 * Write the worktree-local Claude Code settings.json that registers
 * the `insrc-permission-hook` binary as a PreToolUse hook. The hook
 * fires before every tool call the agent makes and asks the daemon
 * for a verdict (Phase 3 Day 3 binary).
 *
 * Format per Claude Code's hook contract (design §9.2): a top-level
 * `hooks.PreToolUse` array, each entry with a matcher and a command.
 * The matcher `{type: 'all'}` fires on every tool; the hook script
 * itself short-circuits by tool name + spec policy.
 *
 * Returns the path to the file actually written.
 */
export function writeClaudeHooksConfig(worktreePath: string, hookBinPath: string): string {
	const dir  = join(worktreePath, '.claude');
	const file = join(dir, 'settings.json');
	const block = {
		hooks: {
			PreToolUse: [
				{
					matcher: { type: 'all' },
					command: hookBinPath,
				},
			],
		},
	};
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, JSON.stringify(block, null, 2));
	return file;
}

/**
 * Write the worktree-local Codex config.toml that registers the
 * insrc MCP server (`[mcp_servers.insrc]` block) so Codex
 * auto-discovers it on launch. Same shape `insrc mcp-setup codex`
 * writes globally, but scoped per-handoff so each spawn gets its
 * own session-scoped env-var forwarding.
 *
 * TOML is generated inline (no library dependency, per the Day-2.5
 * scoping-report decision). The block is small and stable; if
 * Codex's schema grows we can swap in `@iarna/toml` then.
 */
export function writeCodexMcpConfig(worktreePath: string, serverPath: string): string {
	const dir  = join(worktreePath, '.codex');
	const file = join(dir, 'config.toml');
	const escaped = serverPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	const body = [
		'[mcp_servers.insrc]',
		'command = "node"',
		`args = ["${escaped}"]`,
		'env_vars = ["INSRC_SESSION_TOKEN", "INSRC_SESSION_ID", "INSRC_DAEMON_SOCKET", "INSRC_SPEC_ID"]',
		'',
	].join('\n');
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, body);
	return file;
}

/**
 * Write the worktree-local Codex hooks.json registering the
 * insrc-permission-hook for both PreToolUse and PermissionRequest
 * events. Codex's hook system exposes the latter as a distinct
 * event from PreToolUse (design §9.2 last paragraph); we wire both
 * to the same binary so the verdict path is identical.
 *
 * Format: an array of `{event, matcher, command}` entries.
 */
export function writeCodexHooksConfig(worktreePath: string, hookBinPath: string): string {
	const dir  = join(worktreePath, '.codex');
	const file = join(dir, 'hooks.json');
	const block = [
		{ event: 'PreToolUse',        matcher: { tool: '*' }, command: hookBinPath },
		{ event: 'PermissionRequest', matcher: { tool: '*' }, command: hookBinPath },
	];
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, JSON.stringify(block, null, 2));
	return file;
}
