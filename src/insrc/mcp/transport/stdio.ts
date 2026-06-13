/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Stdio transport wrapper.
 *
 * Thin module so future transports (HTTP gateway in Phase 6) can sit
 * alongside this one with a parallel `mcp/transport/http.ts`. The MCP
 * SDK supplies the actual stdio implementation; this file is just the
 * insrc-side entry point.
 *
 * Stdio transport is the primary path for both Claude Code and Codex
 * (design §3.1): no bearer-token machinery, no localhost binding, no
 * port management.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('mcp:stdio');

/**
 * Connect the given McpServer to a fresh stdio transport. Returns the
 * transport in case the caller needs to install close handlers.
 */
export async function startStdioTransport(server: McpServer): Promise<StdioServerTransport> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	log.info('MCP server listening on stdio');
	return transport;
}
