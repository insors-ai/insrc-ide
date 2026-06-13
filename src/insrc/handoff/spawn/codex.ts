/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codex agent spawn -- Phase 4 deliverable.
 *
 * Stubbed in Phase 2a so the registry / CLI / tests can compile
 * against a known shape, but the actual Codex CLI invocation
 * (`codex run --sandbox-mode workspace-write --writable-roots
 * --approval-policy on-request < spec.md`) plus the per-handoff
 * `.codex/config.toml` writer land alongside Phase 3 gating.
 *
 * The shape of `SpawnCodexOpts` deliberately mirrors `SpawnClaudeCodeOpts`
 * so the CLI handoff command can dispatch by `preferredAgent` without
 * special-casing each branch.
 */

import type { AgentSpawnResult } from './base.js';

export interface SpawnCodexOpts {
	readonly worktreePath:    string;
	readonly spec:            string;
	readonly sessionId:       string;
	readonly specId:          string;
	readonly mcpServerPath:   string;
	readonly timeoutMs?:      number | undefined;
	readonly codexBinPath?:   string | undefined;
}

export class CodexNotImplementedError extends Error {
	constructor() {
		super('Codex spawn lands in Phase 4 (plans/external-agent-integration.md §4). Phase 2a uses Claude Code only.');
		this.name = 'CodexNotImplementedError';
	}
}

export async function spawnCodex(_opts: SpawnCodexOpts): Promise<AgentSpawnResult> {
	throw new CodexNotImplementedError();
}
