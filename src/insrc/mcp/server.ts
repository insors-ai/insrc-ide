#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * insrc MCP server -- stdio entry point.
 *
 * Spawned as a child subprocess by the external coding agent (Claude
 * Code / Codex) when it loads the `insrc` MCP server from its config
 * (see plan §1.4 `insrc setup claude-code` / `insrc setup codex`).
 *
 * Process model: one instance per agent session. The server reads
 * JSON-RPC over stdin, writes JSON-RPC over stdout, and uses stderr
 * for diagnostics (pino logs are emitted as JSON to stderr; the agent
 * does NOT consume them).
 *
 * Phase 1 (this commit): tool registry only; all 12 tools stubbed with
 * NotImplementedError. The agent can complete the MCP handshake, call
 * `tools/list`, and see the 12 tool names. Calling any tool returns
 * a structured error until Day 2-3 wires the real handlers.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startStdioTransport } from './transport/stdio.js';
import { registerAllTools } from './tool-registry.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('mcp:server');

const SERVER_INFO = {
	name:    'insrc',
	version: '0.1.0',
};

async function main(): Promise<void> {
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
