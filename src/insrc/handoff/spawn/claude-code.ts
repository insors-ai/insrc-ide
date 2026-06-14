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
import { runAgentSubprocess, writeClaudeHooksConfig, writeMcpConfig, type AgentSpawnResult } from './base.js';

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
	/**
	 * When true (the default), the spawn passes
	 * `--dangerously-skip-permissions` to Claude Code so MCP tool calls
	 * + bash + edit operations don't prompt mid-run.
	 *
	 * Why bypass Claude's permission system by default in a handoff:
	 *   - Worktree sandbox: edits are isolated to <handoffsRoot>/<sid>/
	 *     /worktree, the real tree is untouched until Mode C audit
	 *     accepts the diff.
	 *   - Mode A allowedTools / disallowedTools constrain the tool
	 *     surface BEFORE spawn (passed below).
	 *   - Mode B hook (Phase 3) -- when enabled via hookBinPath --
	 *     replaces Claude's prompt with insrc's own permission policy.
	 *   - Mode C audit reviews the diff after the run.
	 * Claude's own prompts are redundant inside this stack and have no
	 * place to land in `--print` (one-shot, non-interactive) mode --
	 * Claude bails after a few retries.
	 *
	 * Set to `false` only when you want Claude's prompts to land
	 * somewhere (e.g. interactive REPL mode, never in the handoff CLI).
	 */
	readonly skipClaudePermissions?: boolean | undefined;
	/**
	 * Absolute path to the compiled insrc-permission-hook binary
	 * (out/insrc/bin/permission-hook.js). When set, the spawn writes
	 * a `.claude/settings.json` with PreToolUse hook entries pointing
	 * at this path, enabling Mode B gating (Phase 3 Day 3 hook script
	 * +daemon gate IPC) for this handoff. When undefined, the agent
	 * runs without Mode B; allowed-tools and the audit-time Mode C
	 * sandbox review still apply.
	 */
	readonly hookBinPath?:    string | undefined;
}

const DEFAULT_ALLOWED:    ClaudeAllowedTool[]    = ['Read', 'Grep', 'Bash', 'Edit', 'Write'];
const DEFAULT_DISALLOWED: ClaudeDisallowedTool[] = ['WebFetch', 'WebSearch'];

export async function spawnClaudeCode(opts: SpawnClaudeCodeOpts): Promise<AgentSpawnResult> {
	// 1. Write the worktree-local `.mcp.json` so Claude auto-discovers
	//    insrc's MCP server in the spawn cwd.
	writeMcpConfig(opts.worktreePath, opts.mcpServerPath);

	// 1b. If a permission-hook binary is configured, register it as a
	//     PreToolUse hook in `.claude/settings.json`. Mode B gating
	//     activates only when this is set; otherwise the agent runs
	//     with allowed-tools enforcement + Mode C audit only.
	if (opts.hookBinPath !== undefined) {
		writeClaudeHooksConfig(opts.worktreePath, opts.hookBinPath);
	}

	// 2. Issue a session-scoped token for this handoff. Will flow into
	//    the child subprocess via env so the MCP server can validate
	//    session-scoped tools.
	const issue = opts.issueToken ?? issueSessionToken;
	const sessionToken = issue(opts.sessionId);

	// 3. Build the CLI invocation.
	const allowed    = (opts.allowedTools    ?? DEFAULT_ALLOWED).join(',');
	const disallowed = (opts.disallowedTools ?? DEFAULT_DISALLOWED).join(',');

	const command = opts.claudeBinPath ?? 'claude';
	const skipPermissions = opts.skipClaudePermissions ?? true;
	const args = skipPermissions
		? [
			'--print',
			'--dangerously-skip-permissions',
			'--allowedTools',    allowed,
			'--disallowedTools', disallowed,
		]
		: [
			'--print',
			'--allowedTools',    allowed,
			'--disallowedTools', disallowed,
		];

	// 4. Compose env -- inherit, then layer the handoff-scoped quartet.
	//    INSRC_SESSION_ID is consumed by the permission-hook (Phase 3
	//    Day 3) so it knows which session's spec to look up. Always
	//    injected so the hook works whether or not opts.hookBinPath is
	//    set (forward-compatible).
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		INSRC_SESSION_TOKEN: sessionToken,
		INSRC_SESSION_ID:    opts.sessionId,
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
