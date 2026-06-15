/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Mode A (pre-flight) resolution registry.
 *
 * Mode A asks the user to approve a spec BEFORE the worktree is
 * created or the agent is spawned. The orchestrator (`runHandoff`)
 * registers a pending entry here after emitting
 * `mode-a-gate-request`, then awaits the user's verdict via the
 * returned promise. The IDE's `handoff.mode-a.resolve` RPC handler
 * calls {@link resolveModeAPrompt} to settle the entry.
 *
 * Default-deny timeout: if no resolution arrives within
 * `MODE_A_TIMEOUT_MS`, the entry auto-denies so a forgotten modal
 * doesn't leave the handoff hanging forever.
 *
 * Process-global state: every running handoff in the daemon shares
 * the same registry; per-handoff isolation happens via the
 * randomly-generated gateId. The state never escapes the daemon.
 */

import { getLogger } from '../shared/logger.js';

const log = getLogger('gating:mode-a-dispatch');

export type ModeAVerdict = 'allow' | 'deny';

export interface ModeAResolution {
	readonly verdict:    ModeAVerdict;
	readonly stopReason?: string | undefined;
}

interface PendingModeAEntry {
	readonly gateId:   string;
	readonly resolve:  (r: ModeAResolution) => void;
	readonly timeout:  ReturnType<typeof setTimeout>;
	settled:           boolean;
}

const MODE_A_TIMEOUT_MS = 5 * 60 * 1000;

const pending = new Map<string, PendingModeAEntry>();

/**
 * Register a Mode A pending entry and return a promise that resolves
 * when the IDE calls {@link resolveModeAPrompt}, or the timeout
 * fires, or {@link cancelAll} clears the registry. The promise
 * always resolves -- never rejects -- so callers can use a simple
 * if/else on the verdict.
 */
export function awaitModeAResolution(gateId: string, timeoutMsOverride?: number): Promise<ModeAResolution> {
	const timeoutMs = timeoutMsOverride ?? MODE_A_TIMEOUT_MS;
	return new Promise(resolve => {
		const entry: PendingModeAEntry = {
			gateId,
			resolve,
			settled: false,
			timeout: setTimeout(() => {
				if (entry.settled) return;
				entry.settled = true;
				pending.delete(gateId);
				log.warn({ gateId, timeoutMs }, 'Mode A: prompt timeout; defaulting to deny');
				resolve({ verdict: 'deny', stopReason: `Mode A timeout after ${timeoutMs}ms` });
			}, timeoutMs),
		};
		pending.set(gateId, entry);
	});
}

/**
 * Settle a pending Mode A entry. Returns `true` if the gateId was
 * found and settled; `false` if it wasn't pending (already resolved,
 * timed out, or never registered).
 */
export function resolveModeAPrompt(gateId: string, resolution: ModeAResolution): boolean {
	const entry = pending.get(gateId);
	if (entry === undefined || entry.settled) {
		return false;
	}
	entry.settled = true;
	clearTimeout(entry.timeout);
	pending.delete(gateId);
	entry.resolve(resolution);
	return true;
}

/**
 * Cancel every pending Mode A entry (daemon shutdown, session
 * teardown). Each pending entry resolves with a deny + stopReason.
 */
export function cancelAllModeAPrompts(stopReason: string): void {
	for (const entry of [...pending.values()]) {
		if (entry.settled) continue;
		entry.settled = true;
		clearTimeout(entry.timeout);
		pending.delete(entry.gateId);
		entry.resolve({ verdict: 'deny', stopReason });
	}
}

/** Test seam: number of pending entries (useful for leak checks). */
export function _pendingCountForTest(): number {
	return pending.size;
}

/** Test seam: nuke all entries WITHOUT resolving them. */
export function _resetForTest(): void {
	for (const entry of pending.values()) {
		clearTimeout(entry.timeout);
	}
	pending.clear();
}
