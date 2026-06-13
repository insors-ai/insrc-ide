/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MCP tool registry.
 *
 * Aggregates the per-family `ToolDefinition` arrays into one ordered
 * list and exposes a `registerAllTools(server)` helper that hands them
 * off to the MCP SDK's `McpServer.registerTool` call site.
 *
 * Adding a new tool family: create `mcp/tools/<family>.ts` exporting
 * `<FAMILY>_TOOLS: readonly ToolDefinition[]`, then add it to
 * `ALL_TOOLS` below. The registration loop picks it up automatically.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDefinition, ToolHandlerContext } from './types.js';
import { validateSessionToken } from './session-token.js';
import { daemonRpc } from './daemon-rpc.js';
import { ENTITY_TOOLS }   from './tools/entity.js';
import { ARTIFACT_TOOLS } from './tools/artifact.js';
import { MEMORY_TOOLS }   from './tools/memory.js';
import { REPO_TOOLS }     from './tools/repo.js';
import { SPEC_TOOLS }     from './tools/spec.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('mcp:tool-registry');

export const ALL_TOOLS: readonly ToolDefinition[] = [
	...ENTITY_TOOLS,
	...ARTIFACT_TOOLS,
	...MEMORY_TOOLS,
	...REPO_TOOLS,
	...SPEC_TOOLS,
];

/**
 * Compile-time invariant: tool names are unique and prefixed correctly.
 * Checked at registration time; throws if violated so the daemon won't
 * boot with a conflicting tool surface.
 */
function assertToolInvariants(tools: readonly ToolDefinition[]): void {
	const seen = new Set<string>();
	for (const t of tools) {
		if (!t.name.startsWith('insrc_')) {
			throw new Error(`MCP tool '${t.name}' is missing the required 'insrc_' prefix (design §4 naming convention).`);
		}
		if (seen.has(t.name)) {
			throw new Error(`MCP tool '${t.name}' is registered more than once.`);
		}
		seen.add(t.name);
	}
}

/**
 * Register every tool in `ALL_TOOLS` with the given MCP server.
 *
 * The handler closure wraps each tool's handler with:
 *   - Session-token validation for `scope: 'session'` tools.
 *   - Error mapping: handler exceptions are surfaced as MCP errors
 *     with `isError: true` and the message as content.
 */
export function registerAllTools(server: McpServer): void {
	assertToolInvariants(ALL_TOOLS);

	const sessionTokenFromEnv = process.env['INSRC_SESSION_TOKEN'];

	for (const tool of ALL_TOOLS) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: tool.inputSchema,
			},
			async (args: unknown) => {
				const ctx: ToolHandlerContext = {
					sessionToken: sessionTokenFromEnv,
					rpc:          daemonRpc,
				};
				if (tool.scope === 'session') {
					const sessionId = validateSessionToken(ctx.sessionToken);
					if (sessionId === undefined) {
						return {
							content: [{ type: 'text', text: `Tool '${tool.name}' requires a valid session token; INSRC_SESSION_TOKEN is missing or expired.` }],
							isError: true,
						};
					}
				}
				try {
					const result = await tool.handler(args as Record<string, never>, ctx);
					return result;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					log.warn({ tool: tool.name, err: msg }, 'tool handler threw');
					return {
						content: [{ type: 'text', text: msg }],
						isError: true,
					};
				}
			},
		);
	}

	log.info({ count: ALL_TOOLS.length }, 'registered MCP tools');
}
