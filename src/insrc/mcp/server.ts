#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * insrc MCP server entry point.
 *
 * Two transports:
 *
 *   - **stdio (default)**: spawned as a child subprocess by the
 *     external coding agent (Claude Code / Codex) when it loads
 *     the `insrc` MCP server from its config (`insrc setup
 *     claude-code` / `insrc setup codex`). One instance per agent
 *     session; the agent owns the subprocess lifetime.
 *
 *   - **http** (Phase 6 fallback): a localhost-only HTTP server
 *     that exposes the same tool surface for environments where
 *     the agent can't spawn a subprocess but can issue HTTP
 *     requests. Selected via `--transport http`; auth via the
 *     `Authorization: Bearer <token>` header carrying an
 *     `INSRC_SESSION_TOKEN`-equivalent value.
 *
 * Selection: argv `--transport stdio|http` (default `stdio`) +
 * `--port <n>` for http (default 0 -> OS-assigned). stderr stays
 * the diagnostics channel in both transports.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startStdioTransport } from './transport/stdio.js';
import { HttpMcpGateway } from './transport/http.js';
import { registerAllTools } from './tool-registry.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('mcp:server');

const SERVER_INFO = {
	name:    'insrc',
	version: '0.1.0',
};

type TransportKind = 'stdio' | 'http';

interface ParsedArgs {
	readonly transport: TransportKind;
	readonly port:      number;
	readonly host:      string;
}

/**
 * Tiny argv parser -- avoids pulling commander into the MCP server
 * just for two flags. Validates strictly: an unknown flag or an
 * invalid transport value aborts with a non-zero exit.
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
	let transport: TransportKind = 'stdio';
	let port = 0;
	let host = '127.0.0.1';
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === '--transport') {
			const v = argv[++i];
			if (v !== 'stdio' && v !== 'http') {
				throw new Error(`--transport must be 'stdio' or 'http', got '${v ?? '(missing)'}'`);
			}
			transport = v;
		} else if (a === '--port') {
			const v = argv[++i];
			const n = v !== undefined ? Number.parseInt(v, 10) : NaN;
			if (!Number.isFinite(n) || n < 0 || n > 65535) {
				throw new Error(`--port must be an integer in [0, 65535], got '${v ?? '(missing)'}'`);
			}
			port = n;
		} else if (a === '--host') {
			const v = argv[++i];
			if (v === undefined || v.length === 0) {
				throw new Error('--host must be a non-empty string');
			}
			host = v;
		} else if (a.startsWith('-')) {
			throw new Error(`unknown flag '${a}'`);
		}
	}
	return { transport, port, host };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	if (args.transport === 'http') {
		// HTTP gateway: each unique bearer-token-derived session id
		// gets its own MCP server + transport pair, constructed
		// lazily by the gateway on first request.
		const gateway = new HttpMcpGateway({ port: args.port, host: args.host });
		await gateway.listen();
		log.info({ host: gateway.host, port: gateway.port }, 'insrc MCP HTTP gateway ready');
		// Print the URL on stdout so callers (the spawn config
		// writer, manual tooling) can capture it.
		process.stdout.write(`http://${gateway.host}:${gateway.port}/mcp\n`);

		const shutdown = async (sig: NodeJS.Signals): Promise<void> => {
			log.info({ sig }, 'MCP server shutting down');
			await gateway.close();
			process.exit(0);
		};
		process.on('SIGINT',  () => { void shutdown('SIGINT'); });
		process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
		return;
	}

	// stdio path (default + Phase 1 production transport).
	const server = new McpServer(SERVER_INFO, {
		instructions:
			'insrc exposes its knowledge graph, session memory, and cross-repo ' +
			'closure via a small set of `insrc_*` tools. Use these to discover ' +
			"code and context at execution time; insrc deliberately doesn't pre-" +
			'fetch entity content into the spec.',
	});

	registerAllTools(server);
	await startStdioTransport(server);

	// Keep the process alive until the transport disconnects (stdin EOF).
	process.stdin.on('close', () => {
		log.info('stdin closed; exiting');
		process.exit(0);
	});
}

main().catch((err) => {
	log.error({ err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
		'MCP server fatal error');
	process.exit(1);
});
