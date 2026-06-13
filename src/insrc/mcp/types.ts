/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MCP tool definition shape.
 *
 * Each tool exposed to external coding agents (Claude Code, Codex) is
 * described by one of these. The registry assembles them into the
 * `tools/list` response and dispatches `tools/call` to the handler.
 *
 * Day 1 (Phase 1 scaffold): handlers throw `NotImplementedError` so
 * tools/list is round-trippable. Real handlers land Day 2-3 of Phase 1.
 *
 * Design refs:
 *   - design/external-agent-integration.md §4 "Tool Surface"
 *   - plans/external-agent-integration.md §1 "MCP server foundation"
 */

import type { z, ZodRawShape } from 'zod';
import type { RpcFn } from './daemon-rpc.js';

/**
 * Whether the tool requires a valid `INSRC_SESSION_TOKEN` to invoke.
 *
 *   - `'global'`     -- callable without a session token (knowledge
 *                       graph, cross-repo discovery; safe to expose to
 *                       any agent on the same host).
 *   - `'session'`    -- requires a valid token issued for the active
 *                       handoff (artifact reads, spec lookups).
 *
 * Phase 1 ships token issue/validate as stubs (mcp/session-token.ts);
 * Phase 2a wires real issuance into the handoff spawn pipeline.
 */
export type ToolScope = 'global' | 'session';

/**
 * Per-tool descriptor. Snake-case name with `insrc_` prefix is mandated
 * by design §4 "Naming convention" (Codex doesn't auto-namespace MCP
 * tools, so the prefix is what disambiguates them in the reasoning loop).
 */
export interface ToolDefinition<Schema extends ZodRawShape = ZodRawShape> {
	/** `insrc_<family>_<verb>` snake_case. */
	readonly name:        string;
	/** One-line tool description shown to the LLM. */
	readonly description: string;
	/** Token scope required to invoke. */
	readonly scope:       ToolScope;
	/** Zod raw shape (record of zod schemas) validated by the SDK. */
	readonly inputSchema: Schema;
	/**
	 * Handler. Receives parsed args after Zod validation.
	 *
	 * Returns a CallToolResult-shaped object: typically
	 * `{ content: [{ type: 'text', text: JSON.stringify(...) }] }` for
	 * structured payloads, or a plain content array for free-form
	 * outputs. Throw for tool-level failures; the SDK surfaces them
	 * as MCP errors to the calling agent.
	 *
	 * Day 1 stubs throw NotImplementedError -- the real wiring lands
	 * in Phase 1 days 2-3 as the per-family tool files (entity.ts,
	 * artifact.ts, memory.ts, repo.ts, spec.ts) are filled in.
	 */
	readonly handler: (
		args: { [K in keyof Schema]: z.infer<Schema[K]> },
		ctx:  ToolHandlerContext,
	) => Promise<ToolCallResult>;
}

export interface ToolHandlerContext {
	/**
	 * The session token presented by the calling agent, if any.
	 * `undefined` for `scope: 'global'` invocations from an
	 * unauthenticated process.
	 */
	readonly sessionToken: string | undefined;
	/**
	 * The session id the token resolved to. Populated by the registry
	 * after `scope: 'session'` validation passes; always undefined for
	 * `scope: 'global'` tools (they don't need it).
	 *
	 * Session-scoped tools (`insrc_artifact_*`, `insrc_spec_*`) read
	 * this directly rather than re-validating the token themselves --
	 * the registry already gated.
	 */
	readonly sessionId: string | undefined;
	/**
	 * Daemon JSON-RPC client. Tool handlers call this to reach the
	 * underlying entity / graph / memory functions, which live in the
	 * daemon process (the MCP server is a separate subprocess and
	 * never opens LMDB / Lance directly).
	 *
	 * Injected from the registry; tests can pass a stub via
	 * `{ ...ctx, rpc: stubRpc }` to verify call shapes without
	 * standing up a real daemon.
	 */
	readonly rpc: RpcFn;
}

/**
 * Subset of the MCP SDK's CallToolResult shape we emit. The SDK accepts
 * the full type but we only use the text-content branch. Note: the
 * SDK requires a mutable content array, hence no `readonly` modifier
 * here -- this is the one place we accept the SDK's invariance.
 */
export interface ToolCallResult {
	content: { type: 'text'; text: string }[];
	isError?: boolean;
	[key: string]: unknown;
}

/**
 * Convenience: build a JSON text-content result.
 */
export function jsonResult(payload: unknown): ToolCallResult {
	return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/**
 * Day 1 stub. Real handlers replace this in Phase 1 days 2-3.
 */
export class NotImplementedError extends Error {
	constructor(toolName: string) {
		super(`MCP tool '${toolName}' is registered but not yet wired (Phase 1 scaffold).`);
		this.name = 'NotImplementedError';
	}
}
