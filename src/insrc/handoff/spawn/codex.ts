/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codex agent spawn -- Phase 4 Day 1.
 *
 * Mirrors `spawn/claude-code.ts`'s shape so the CLI dispatch routes
 * agents by name without branching their composition logic. Same
 * test seams (codexBinPath, issueToken), same env quartet, same
 * AgentSpawnResult contract.
 *
 * Per design §6.4 step 16 (Codex branch):
 *
 *   codex run --workdir <worktree>
 *     --sandbox-mode workspace-write
 *     --writable-roots <worktree>
 *     --approval-policy on-request
 *     < spec.md
 *
 * Pre-spawn writes per-handoff configs into the worktree:
 *   - .codex/config.toml    [mcp_servers.insrc] block (Phase 4 Day 1)
 *   - .codex/hooks.json     PreToolUse + PermissionRequest hooks
 *                           pointing at the insrc-permission-hook
 *                           binary (Phase 4 Day 1; Mode B opt-in).
 */

import { issueSessionToken } from '../../mcp/session-token.js';
import { PATHS } from '../../shared/paths.js';
import {
	runAgentSubprocess,
	writeCodexHooksConfig,
	writeCodexMcpConfig,
	type AgentSpawnResult,
} from './base.js';

export type CodexSandboxMode    = 'workspace-write' | 'workspace-read' | 'restricted';
export type CodexApprovalPolicy = 'never' | 'on-request' | 'always';

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
	readonly sandboxMode?:    CodexSandboxMode    | undefined;
	readonly approvalPolicy?: CodexApprovalPolicy | undefined;
	readonly timeoutMs?:      number              | undefined;
	/** Test seam: override the codex binary path. */
	readonly codexBinPath?:   string              | undefined;
	/** Test seam: override the session-token issuer. */
	readonly issueToken?:     ((sessionId: string) => string) | undefined;
	/**
	 * Absolute path to the compiled insrc-permission-hook binary
	 * (out/insrc/bin/permission-hook.js). When set, the spawn writes
	 * a `.codex/hooks.json` registering the hook for PreToolUse +
	 * PermissionRequest. When undefined, Mode B is disabled for this
	 * handoff and the spawn relies on sandbox-mode + approval-policy
	 * + audit-time Mode C only.
	 */
	readonly hookBinPath?:    string              | undefined;
}

const DEFAULT_SANDBOX_MODE:    CodexSandboxMode    = 'workspace-write';
const DEFAULT_APPROVAL_POLICY: CodexApprovalPolicy = 'on-request';

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
	const sandboxMode    = opts.sandboxMode    ?? DEFAULT_SANDBOX_MODE;
	const approvalPolicy = opts.approvalPolicy ?? DEFAULT_APPROVAL_POLICY;

	const command = opts.codexBinPath ?? 'codex';
	const args    = [
		'run',
		'--workdir',         opts.worktreePath,
		'--sandbox-mode',    sandboxMode,
		'--writable-roots',  opts.worktreePath,
		'--approval-policy', approvalPolicy,
	];

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
