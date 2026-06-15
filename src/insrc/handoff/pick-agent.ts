/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider-aware agent routing for the external coding agent
 * pipeline (plans/external-agent-integration.md §4.4).
 *
 * Decides which spawn path (`claude-code` vs `codex`) a handoff
 * uses, given:
 *
 *   - the user's explicit `insrc.handoff.preferredAgent` setting,
 *     where `'auto'` defers to provider-correlation logic, and
 *   - the active cloud LLM provider on the session.
 *
 * Rationale: under `'auto'`, we pick the agent whose vendor
 * matches the user's active provider so the handoff inherits the
 * same model preference -- Anthropic users land on Claude Code,
 * everyone else lands on Codex. The mapping is intentionally
 * blunt; a future iteration could read agent capability metadata
 * to make a smarter call, but the simple rule covers ~all
 * production deployments today.
 */

import type { AgentChoice } from './index.js';

/** Subset of cloud providers `pickAgent` reasons about. */
export type ActiveCloudProvider = 'openai' | 'anthropic' | 'gemini' | 'mistral' | null;

export type PreferredAgentSetting = 'claude-code' | 'codex' | 'auto';

/**
 * Pure function: resolve the user's preferred-agent setting + the
 * session's active cloud provider into a concrete agent choice.
 *
 *   - explicit setting (`'claude-code'` / `'codex'`) wins
 *     unconditionally; the active provider doesn't matter.
 *   - `'auto'` with active provider `'anthropic'` -> `'claude-code'`.
 *   - `'auto'` with any other active provider OR no active
 *     provider -> `'codex'` (the default since OpenAI is the
 *     plurality cloud provider in current usage and Codex
 *     handles other providers' API shapes via its own routing).
 *
 * Never returns `'scripted-agent'` -- that path is exclusive to
 * test / CLI dry-run callers who pass `--agent scripted-agent`
 * directly.
 */
export function pickAgent(
	setting: PreferredAgentSetting,
	activeProvider: ActiveCloudProvider,
): Extract<AgentChoice, 'claude-code' | 'codex'> {
	if (setting === 'claude-code') return 'claude-code';
	if (setting === 'codex') return 'codex';
	// setting === 'auto'
	return activeProvider === 'anthropic' ? 'claude-code' : 'codex';
}
