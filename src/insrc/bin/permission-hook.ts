#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc-permission-hook` -- the PreToolUse hook the external coding
 * agent (Claude Code, Codex) spawns before each tool call.
 *
 * Lifecycle:
 *   1. Agent's PreToolUse fires our binary with the tool-use JSON on
 *      stdin (e.g. {tool_name: 'Bash', tool_input: {command:'git push'}}).
 *   2. We read env vars set by Phase 2a's spawn pipeline:
 *        INSRC_DAEMON_SOCKET, INSRC_SESSION_TOKEN, INSRC_SPEC_ID
 *      INSRC_SESSION_TOKEN is the same token Phase 1 Day 1's
 *      session-token.ts issues at handoff spawn; we extract its
 *      sessionId via a daemon RPC (not yet wired) OR rely on a
 *      sidecar env var INSRC_SESSION_ID. Day 3 uses the env var.
 *   3. Open the daemon socket, send a streaming `gate.request-permission`
 *      with {specId, tool, input, sessionId}.
 *   4. Read stream messages until 'done' or 'error', extract the
 *      verdict, and write the agent-expected JSON to stdout.
 *
 * Claude Code hook output format (design §9.2):
 *   allow:  {"continue": true}
 *   deny:   {"continue": false, "stopReason": "..."}
 *
 * The hook is deliberately tolerant on failure paths:
 *   - daemon unreachable -> deny with stopReason
 *   - missing env vars   -> deny with stopReason
 *   - parse failure      -> deny with stopReason
 *
 * The agent sees a clean deny and recovers; nothing the hook does
 * crashes the agent run.
 */

import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';

interface ClaudeHookInput {
	readonly tool_name?:  string;
	readonly tool_input?: unknown;
	/** Some agents include a session_id at the hook level too. */
	readonly session_id?: string;
}

interface HookExitDecision {
	readonly continue:    boolean;
	readonly stopReason?: string;
}

interface IpcStreamMessage {
	readonly id:     number;
	readonly stream: string;
	readonly data:   unknown;
}

const HOOK_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
	const decision = await runHook();
	process.stdout.write(JSON.stringify(decision));
	// Hook MUST exit so the agent can proceed. Use 0 for both allow
	// and deny; the JSON output drives the agent's behaviour, not the
	// exit code.
	process.exit(0);
}

async function runHook(): Promise<HookExitDecision> {
	const socketPath  = process.env['INSRC_DAEMON_SOCKET'];
	const specId      = process.env['INSRC_SPEC_ID'];
	const sessionId   = process.env['INSRC_SESSION_ID'];

	if (socketPath === undefined || socketPath.length === 0) {
		return denyWith('insrc-permission-hook: INSRC_DAEMON_SOCKET not set');
	}
	if (specId === undefined || specId.length === 0) {
		return denyWith('insrc-permission-hook: INSRC_SPEC_ID not set');
	}
	if (sessionId === undefined || sessionId.length === 0) {
		return denyWith('insrc-permission-hook: INSRC_SESSION_ID not set');
	}

	const stdinText = readStdinSync();
	let hookInput: ClaudeHookInput;
	try {
		hookInput = JSON.parse(stdinText) as ClaudeHookInput;
	} catch (err) {
		return denyWith(`insrc-permission-hook: stdin not JSON: ${(err as Error).message}`);
	}
	if (typeof hookInput.tool_name !== 'string' || hookInput.tool_name.length === 0) {
		return denyWith('insrc-permission-hook: missing tool_name');
	}

	try {
		const verdict = await askDaemon(socketPath, {
			specId,
			tool:      hookInput.tool_name,
			input:     hookInput.tool_input ?? {},
			sessionId,
		});
		if (verdict.verdict === 'allow') return { continue: true };
		return denyWith(verdict.stopReason ?? 'denied by insrc spec policy');
	} catch (err) {
		return denyWith(`insrc-permission-hook: daemon contact failed: ${(err as Error).message}`);
	}
}

function denyWith(reason: string): HookExitDecision {
	return { continue: false, stopReason: reason };
}

function readStdinSync(): string {
	try {
		return readFileSync(0, 'utf8');
	} catch {
		return '';
	}
}

interface AskDaemonResult {
	readonly verdict:    'allow' | 'deny';
	readonly stopReason?: string;
}

function askDaemon(
	socketPath: string,
	params: { specId: string; tool: string; input: unknown; sessionId: string },
): Promise<AskDaemonResult> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let   buffer = '';
		let   resolved = false;

		const timer = setTimeout(() => {
			if (resolved) return;
			resolved = true;
			socket.destroy();
			reject(new Error(`timed out after ${HOOK_TIMEOUT_MS}ms`));
		}, HOOK_TIMEOUT_MS);

		socket.on('connect', () => {
			const req = {
				id:     1,
				method: 'gate.request-permission',
				params,
				stream: true,
			};
			socket.write(JSON.stringify(req) + '\n');
		});

		socket.on('data', (chunk: Buffer) => {
			buffer += chunk.toString();
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (line.trim().length === 0) continue;
				let msg: IpcStreamMessage;
				try {
					msg = JSON.parse(line) as IpcStreamMessage;
				} catch {
					continue;
				}
				if (msg.stream === 'progress') {
					const data = msg.data as { verdict?: string; stopReason?: string };
					if (data.verdict === 'allow' || data.verdict === 'deny') {
						resolved = true;
						clearTimeout(timer);
						socket.end();
						resolve(data.stopReason !== undefined
							? { verdict: data.verdict, stopReason: data.stopReason }
							: { verdict: data.verdict });
						return;
					}
				} else if (msg.stream === 'error') {
					resolved = true;
					clearTimeout(timer);
					socket.end();
					const data = msg.data as { error?: string };
					reject(new Error(data.error ?? 'daemon returned error'));
					return;
				} else if (msg.stream === 'done') {
					// The verdict should have been emitted before 'done'; if not, that's
					// a protocol violation -- treat as deny.
					if (!resolved) {
						resolved = true;
						clearTimeout(timer);
						socket.end();
						reject(new Error("daemon emitted 'done' without a verdict"));
					}
					return;
				}
				// 'gate' messages are surfaced to the IDE; the hook just waits.
			}
		});

		socket.on('error', (err: NodeJS.ErrnoException) => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timer);
			reject(new Error(`socket error: ${err.message}`));
		});

		socket.on('close', () => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timer);
			reject(new Error('socket closed before verdict'));
		});
	});
}

main().catch(err => {
	process.stdout.write(JSON.stringify({
		continue: false,
		stopReason: `insrc-permission-hook: ${(err as Error).message}`,
	}));
	process.exit(0);
});
