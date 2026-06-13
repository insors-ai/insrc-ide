/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Claude Code agent spawn.
 *
 * Per design §6.4 step 16:
 *
 *   claude --print --allowedTools "Read,Grep,Bash,Edit,Write"
 *     --disallowedTools "WebFetch,WebSearch" < spec.md
 *
 * --print: one-shot; consume the prompt from stdin, run, emit the
 *          final response to stdout, exit. No interactive REPL.
 * --allowedTools / --disallowedTools: spawn-time allow-list; Phase 3
 *          adds PreToolUse hook gating on top (Mode B).
 *
 * The spec is the assembled DEBUG-SESSION (or whichever template) and
 * lands on the agent's stdin. The agent's stdout is the deliverable
 * markdown that the Phase 4 audit pipeline parses.
 */

import { issueSessionToken } from '../../mcp/session-token.js';
import { PATHS } from '../../shared/paths.js';
import { runAgentSubprocess, writeMcpConfig, type AgentSpawnResult } from './base.js';

export type ClaudeAllowedTool    = 'Read' | 'Grep' | 'Bash' | 'Edit' | 'Write';
export type ClaudeDisallowedTool = 'WebFetch' | 'WebSearch';

export interface SpawnClaudeCodeOpts {
	readonly worktreePath:    string;
	/**
	 * Spec markdown (output of `assembleSpec`) piped to Claude's stdin.
	 */
	readonly spec:            string;
	readonly sessionId:       string;
	readonly specId:          string;
	/**
	 * Absolute path to the compiled MCP server entry (same path
	 * mcp-setup writes into the user's global `~/.claude/settings.json`).
	 * Phase 2a writes it into `<worktreePath>/.mcp.json` per-handoff so
	 * the session token can be scoped at spawn time.
	 */
	readonly mcpServerPath:   string;
	readonly allowedTools?:   readonly ClaudeAllowedTool[] | undefined;
	readonly disallowedTools?: readonly ClaudeDisallowedTool[] | undefined;
	readonly timeoutMs?:      number | undefined;
	/**
	 * Test seam: override the `claude` binary path. Production paths
	 * leave undefined; we look up `claude` on PATH.
	 */
	readonly claudeBinPath?:  string | undefined;
	/**
	 * Test seam: override the session-token issuer (so unit tests can
	 * inject a deterministic token without touching the real store).
	 */
	readonly issueToken?:     ((sessionId: string) => string) | undefined;
}

const DEFAULT_ALLOWED:    ClaudeAllowedTool[]    = ['Read', 'Grep', 'Bash', 'Edit', 'Write'];
const DEFAULT_DISALLOWED: ClaudeDisallowedTool[] = ['WebFetch', 'WebSearch'];

export async function spawnClaudeCode(opts: SpawnClaudeCodeOpts): Promise<AgentSpawnResult> {
	// 1. Write the worktree-local `.mcp.json` so Claude auto-discovers
	//    insrc's MCP server in the spawn cwd.
	writeMcpConfig(opts.worktreePath, opts.mcpServerPath);

	// 2. Issue a session-scoped token for this handoff. Will flow into
	//    the child subprocess via env so the MCP server can validate
	//    session-scoped tools.
	const issue = opts.issueToken ?? issueSessionToken;
	const sessionToken = issue(opts.sessionId);

	// 3. Build the CLI invocation.
	const allowed    = (opts.allowedTools    ?? DEFAULT_ALLOWED).join(',');
	const disallowed = (opts.disallowedTools ?? DEFAULT_DISALLOWED).join(',');

	const command = opts.claudeBinPath ?? 'claude';
	const args    = [
		'--print',
		'--allowedTools',    allowed,
		'--disallowedTools', disallowed,
	];

	// 4. Compose env -- inherit, then layer the handoff-scoped trio.
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		INSRC_SESSION_TOKEN: sessionToken,
		INSRC_DAEMON_SOCKET: PATHS.sockFile,
		INSRC_SPEC_ID:       opts.specId,
	};

	const subprocessOpts: Parameters<typeof runAgentSubprocess>[0] = {
		command,
		args,
		cwd:  opts.worktreePath,
		env,
		spec: opts.spec,
	};
	if (opts.timeoutMs !== undefined) {
		(subprocessOpts as { timeoutMs?: number }).timeoutMs = opts.timeoutMs;
	}
	return runAgentSubprocess(subprocessOpts);
}
