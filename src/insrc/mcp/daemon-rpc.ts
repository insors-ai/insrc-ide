/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Daemon RPC client used by the MCP server's tool handlers.
 *
 * The MCP server runs as a subprocess of the external coding agent
 * (Claude Code / Codex), separate from the insrc daemon. Per CLAUDE.md
 * key architectural rule #1 (`daemon owns all DB access`), the server
 * never opens LMDB / Lance directly -- every entity / graph / memory
 * query routes through the daemon's JSON-RPC-over-Unix-socket IPC.
 *
 * This module wraps the cli-side `rpc` client with MCP-specific
 * concerns:
 *   - Honors INSRC_DAEMON_SOCKET if set (handoff spawns inject it).
 *   - Surfaces a clean error class for daemon-not-running so tool
 *     handlers can map it to a structured CallToolResult instead of
 *     unmodelled crashes.
 */

import { rpc as cliRpc } from '../cli/client.js';

/**
 * Signature every tool handler uses to reach the daemon.
 *
 * Decoupling the impl as a function type lets unit tests inject a
 * stub instead of standing up a real daemon. Production uses
 * `daemonRpc` below.
 */
export type RpcFn = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export class DaemonUnreachableError extends Error {
	constructor(method: string, cause?: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause ?? 'unknown');
		super(`MCP tool called daemon method '${method}' but the daemon is not reachable: ${detail}`);
		this.name = 'DaemonUnreachableError';
	}
}

/**
 * Production daemon RPC. Routes through `cli/client.ts:rpc` which uses
 * `PATHS.sockFile` (or INSRC_DAEMON_SOCKET if env overrides it).
 *
 * Throws DaemonUnreachableError if the daemon is down; the tool
 * registry catches and surfaces as a structured tool error so the
 * external agent sees a useful message instead of a process crash.
 */
export const daemonRpc: RpcFn = async <T = unknown>(method: string, params: unknown = {}): Promise<T> => {
	try {
		return await cliRpc<T>(method, params);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// `cli/client.ts:rpc` does not type the connection-refused case;
		// match on the most common signatures.
		if (/ECONNREFUSED|ENOENT|connect EACCES|daemon is not running/i.test(msg)) {
			throw new DaemonUnreachableError(method, err);
		}
		throw err;
	}
};
