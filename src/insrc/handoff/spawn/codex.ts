/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codex agent spawn.
 *
 * Mirrors `spawn/claude-code.ts`'s shape so the CLI dispatch routes
 * agents by name without branching their composition logic. Same
 * test seams (codexBinPath, issueToken), same env quartet, same
 * AgentSpawnResult contract.
 *
 * Verified against the real Codex CLI (version installed via
 * @openai/codex) on 2026-06-14. Invocation:
 *
 *   codex exec \
 *     --cd <worktree> \
 *     --add-dir <worktree> \
 *     --sandbox workspace-write \
 *     --dangerously-bypass-approvals-and-sandbox \
 *     --skip-git-repo-check \
 *     < spec.md
 *
 * Notes vs the original design §6.4 step 16 (which used Claude-shaped
 * flag names; Codex CLI evolved differently):
 *   - subcommand is `exec` (or `e`), not `run` as the design specced.
 *   - working dir flag is `-C` / `--cd <DIR>`, not `--workdir`.
 *   - writable dirs flag is `--add-dir <DIR>`, not `--writable-roots`.
 *   - sandbox flag is `-s` / `--sandbox <MODE>`, not `--sandbox-mode`.
 *     Values: `read-only` | `workspace-write` | `danger-full-access`.
 *   - approval-policy flag doesn't exist on Codex; the equivalent of
 *     Claude's `--dangerously-skip-permissions` is Codex's
 *     `--dangerously-bypass-approvals-and-sandbox` (single combined
 *     flag). Default skip true for the same reasons documented in
 *     spawn/claude-code.ts.
 *   - `--skip-git-repo-check` lets Codex run inside a worktree that
 *     may be detached from origin (git worktree create doesn't add
 *     a remote ref). Always set.
 *   - `--dangerously-bypass-hook-trust` is needed to run Mode B
 *     hooks without persisted trust state per-handoff; only set when
 *     hookBinPath is provided.
 *
 * Pre-spawn writes per-handoff configs into the worktree:
 *   - .codex/config.toml    [mcp_servers.insrc] block (Day 1)
 *   - .codex/hooks.json     PreToolUse + PermissionRequest hooks
 *                           pointing at the insrc-permission-hook
 *                           binary (Day 1; Mode B opt-in).
 */

import { issueSessionToken } from '../../mcp/session-token.js';
import { PATHS } from '../../shared/paths.js';
import {
	runAgentSubprocess,
	writeCodexHooksConfig,
	writeCodexMcpConfig,
	type AgentSpawnResult,
} from './base.js';

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface SpawnCodexOpts {
	readonly worktreePath:    string;
	/** Spec markdown (output of `assembleSpec`) piped to Codex's stdin. */
	readonly spec:            string;
	readonly sessionId:       string;
	readonly specId:          string;
	/**
	 * Absolute path to the compiled MCP server entry. Phase 4 writes
	 * `.codex/config.toml`'s [mcp_servers.insrc] block per-handoff so
	 * the session token can be scoped at spawn time (same rationale
	 * as Claude Code's per-worktree `.mcp.json`).
	 */
	readonly mcpServerPath:   string;
	readonly sandboxMode?:    CodexSandboxMode | undefined;
	readonly timeoutMs?:      number           | undefined;
	/** Test seam: override the codex binary path. */
	readonly codexBinPath?:   string           | undefined;
	/** Test seam: override the session-token issuer. */
	readonly issueToken?:     ((sessionId: string) => string) | undefined;
	/**
	 * Absolute path to the compiled insrc-permission-hook binary
	 * (out/insrc/bin/permission-hook.js). When set, the spawn writes
	 * a `.codex/hooks.json` registering the hook for PreToolUse +
	 * PermissionRequest and adds `--dangerously-bypass-hook-trust`
	 * so the per-handoff hook runs without persisted trust state.
	 */
	readonly hookBinPath?:    string           | undefined;
	/**
	 * When true (the default), the spawn passes
	 * `--dangerously-bypass-approvals-and-sandbox` -- Codex's
	 * equivalent of `claude --dangerously-skip-permissions`.
	 *
	 * Rationale (same stack as Claude):
	 *   - Worktree sandbox isolates edits to
	 *     <handoffsRoot>/<sid>/worktree/.
	 *   - sandbox flag still constrains the surface (workspace-write
	 *     by default).
	 *   - Mode B PreToolUse hook (Phase 3) replaces Codex's own
	 *     prompts with insrc's spec policy when hookBinPath is set.
	 *   - Mode C audit reviews the diff post-run.
	 *
	 * Codex's own approval prompts have nowhere to land in
	 * `exec` (one-shot, non-interactive) mode. Set this to false only
	 * when you want them to land somewhere (e.g. attended dev runs).
	 */
	readonly skipApprovalsAndSandbox?: boolean | undefined;
}

const DEFAULT_SANDBOX_MODE: CodexSandboxMode = 'workspace-write';

export async function spawnCodex(opts: SpawnCodexOpts): Promise<AgentSpawnResult> {
	// 1. Write the worktree-local Codex MCP config so Codex auto-
	//    discovers the insrc MCP server in the spawn cwd.
	writeCodexMcpConfig(opts.worktreePath, opts.mcpServerPath);

	// 1b. Optional Mode B hook registration.
	if (opts.hookBinPath !== undefined) {
		writeCodexHooksConfig(opts.worktreePath, opts.hookBinPath);
	}

	// 2. Issue a session-scoped token for this handoff.
	const issue = opts.issueToken ?? issueSessionToken;
	const sessionToken = issue(opts.sessionId);

	// 3. Build the CLI invocation.
	const sandboxMode = opts.sandboxMode ?? DEFAULT_SANDBOX_MODE;
	const skipApprovals = opts.skipApprovalsAndSandbox ?? true;

	const command = opts.codexBinPath ?? 'codex';
	const args: string[] = [
		'exec',
		'--cd',      opts.worktreePath,
		'--add-dir', opts.worktreePath,
		'--sandbox', sandboxMode,
		'--skip-git-repo-check',
	];
	if (skipApprovals) {
		args.push('--dangerously-bypass-approvals-and-sandbox');
	}
	if (opts.hookBinPath !== undefined) {
		args.push('--dangerously-bypass-hook-trust');
	}

	// 4. Compose env -- inherit, then layer the handoff-scoped quartet.
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
