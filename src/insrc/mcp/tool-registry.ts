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
import type { RpcFn } from './daemon-rpc.js';
import type { ToolCallResult, ToolDefinition, ToolHandlerContext } from './types.js';
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

export interface InvokeToolOpts {
	/** Token presented by the caller (env var on MCP, --session-token on CLI). */
	readonly sessionToken?: string | undefined;
	/** RPC client; tests inject stubs. Defaults to the production daemon-rpc. */
	readonly rpc?:          RpcFn | undefined;
}

/**
 * Invoke one tool by definition. Handles session-token gating, ctx
 * construction, and structured error mapping.
 *
 * Shared between the MCP server adapter (registerAllTools below) and
 * the CLI `insrc query --tool` path so the two surfaces stay
 * behaviour-identical.
 */
export async function invokeTool(
	tool: ToolDefinition,
	args: unknown,
	opts: InvokeToolOpts = {},
): Promise<ToolCallResult> {
	const sessionToken = opts.sessionToken;
	const rpc          = opts.rpc ?? daemonRpc;

	let resolvedSessionId: string | undefined;
	if (tool.scope === 'session') {
		resolvedSessionId = validateSessionToken(sessionToken);
		if (resolvedSessionId === undefined) {
			return {
				content: [{ type: 'text', text: `Tool '${tool.name}' requires a valid session token; INSRC_SESSION_TOKEN is missing or expired.` }],
				isError: true,
			};
		}
	}

	const ctx: ToolHandlerContext = {
		sessionToken,
		sessionId: resolvedSessionId,
		rpc,
	};

	const start = Date.now();
	try {
		const result = await tool.handler(args as Record<string, never>, ctx);
		const durationMs = Date.now() - start;
		log.info(
			{ tool: tool.name, scope: tool.scope, durationMs, isError: result.isError === true },
			'tool invoked',
		);
		return result;
	} catch (err) {
		const durationMs = Date.now() - start;
		const msg = err instanceof Error ? err.message : String(err);
		log.warn({ tool: tool.name, scope: tool.scope, durationMs, err: msg }, 'tool handler threw');
		return {
			content: [{ type: 'text', text: msg }],
			isError: true,
		};
	}
}

/**
 * Look up a tool by name. Returns undefined if no match (caller decides
 * how to surface the miss).
 */
export function findToolByName(name: string): ToolDefinition | undefined {
	return ALL_TOOLS.find(t => t.name === name);
}

/**
 * Register every tool in `ALL_TOOLS` with the given MCP server.
 *
 * The handler closure delegates to `invokeTool` so MCP and CLI share
 * one source of truth for gating + error mapping.
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
			async (args: unknown) => invokeTool(tool, args, { sessionToken: sessionTokenFromEnv }),
		);
	}

	log.info({ count: ALL_TOOLS.length }, 'registered MCP tools');
}
