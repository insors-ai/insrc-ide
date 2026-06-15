/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cross-channel dispatcher for Mode B permission prompts.
 *
 * The hook-server (`gate.request-permission` stream IPC) and the
 * handoff orchestrator (`handoff.run` stream IPC) live on different
 * sockets:
 *
 *   - The hook script connects from inside the spawned agent's
 *     subprocess and calls `gate.request-permission`. The
 *     hook-server emits the gate event on THAT socket -- only the
 *     hook script (which is reading for a verdict) sees it.
 *
 *   - The IDE connects on a separate socket and subscribes to
 *     `handoff.run`. To show a Mode B modal, the IDE needs to see
 *     pending prompts -- but the hook-server has no way to write
 *     to the IDE's stream.
 *
 * This module is the bridge: hook-server publishes prompts here,
 * the handoff orchestrator subscribes per-specId and forwards into
 * its own emit channel as a `mode-b-gate-request` HandoffEvent. The
 * IDE picks up the event from the handoff stream it already
 * subscribes to.
 *
 * Same shape for prompt resolution -- when the user (or the
 * timeout / cancellation) settles a pending prompt, we fire a
 * `mode-b-gate-resolved` event so the IDE can dismiss the modal
 * without having to poll.
 *
 * Module-global state is intentional: every running handoff in
 * the daemon shares the same dispatcher; per-specId filtering
 * happens on the subscriber side. The state never escapes the
 * daemon process boundary.
 */

import type { ToolInput, PermissionVerdict } from './permission-policy.js';

export interface PromptDispatchPayload {
	readonly gateId:    string;
	readonly specId:    string;
	readonly sessionId: string;
	readonly tool:      string;
	readonly input:     ToolInput;
}

export interface PromptResolvedPayload {
	readonly gateId:    string;
	readonly specId:    string;
	/**
	 * Resolution that landed on the hook-server. Includes both
	 * `allow` and `deny` (deny covers user-deny, timeout, and
	 * cancellation). When `scope === 'session'`, the daemon also
	 * caches the allow for the rest of the spec's run.
	 */
	readonly verdict:    Extract<PermissionVerdict, 'allow' | 'deny'>;
	readonly scope?:     'once' | 'session' | undefined;
	readonly stopReason?: string | undefined;
}

export type PromptListener = (payload: PromptDispatchPayload) => void;
export type ResolvedListener = (payload: PromptResolvedPayload) => void;

const promptListeners   = new Set<PromptListener>();
const resolvedListeners = new Set<ResolvedListener>();

export interface PromptSubscription {
	readonly dispose: () => void;
}

export function subscribePrompts(listener: PromptListener): PromptSubscription {
	promptListeners.add(listener);
	return { dispose: () => promptListeners.delete(listener) };
}

export function subscribeResolutions(listener: ResolvedListener): PromptSubscription {
	resolvedListeners.add(listener);
	return { dispose: () => resolvedListeners.delete(listener) };
}

export function publishPrompt(payload: PromptDispatchPayload): void {
	// Snapshot to a local array so a listener that disposes itself
	// during dispatch doesn't trip the live Set iterator.
	for (const l of [...promptListeners]) {
		try { l(payload); } catch { /* listener errors are not the dispatcher's problem */ }
	}
}

export function publishResolution(payload: PromptResolvedPayload): void {
	for (const l of [...resolvedListeners]) {
		try { l(payload); } catch { /* swallow */ }
	}
}

/**
 * Test seam: nuke all subscribers. Production code never calls this.
 */
export function _resetForTest(): void {
	promptListeners.clear();
	resolvedListeners.clear();
}
