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
