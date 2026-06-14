/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `gate.request-permission` stream IPC handler.
 *
 * Lifecycle (design §9.2):
 *
 *   1. External agent (Claude Code / Codex) inside the worktree
 *      attempts a tool call (e.g. Bash `git push origin main`).
 *   2. The agent's PreToolUse hook fires our small hook binary
 *      (`bin/insrc-permission-hook`, Phase 3 Day 3).
 *   3. The hook binary connects to the daemon socket and invokes
 *      `gate.request-permission` (this stream handler) with:
 *           { specId, tool, input, sessionId }
 *   4. The daemon looks up the spec's PermissionsBlock, evaluates
 *      via `evaluatePermission` (Day 1), and:
 *        - allow / deny: emits `stream: 'progress'` with verdict,
 *          then `stream: 'done'`. Hook reads the verdict and tells
 *          the agent.
 *        - prompt: emits `stream: 'gate'` carrying the pending
 *          request the IDE renders as a modal. Awaits the user's
 *          response (`gate.resolve` IPC, this same module) and
 *          then completes the stream with the final verdict.
 *
 * The stream design lets the IDE render a real-time modal without
 * the hook binary having to know about the IDE at all -- it just
 * holds open the socket until the daemon resolves.
 *
 * Test seam: the `evaluate` and `pendingPrompts` registry are
 * injectable so unit tests can drive the stream without standing up
 * an IDE. Tests inject a resolver that synthesises a verdict
 * directly, bypassing the IDE roundtrip.
 */

import type { StreamHandler } from '../daemon/server.js';
import type { IpcStreamMessage } from '../shared/types.js';
import type { PermissionsBlock } from '../handoff/types.js';
import { evaluatePermission, type ToolInput, type PermissionVerdict } from './permission-policy.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('gating:hook-server');

export interface RequestPermissionParams {
	readonly specId:    string;
	readonly tool:      string;
	readonly input:     ToolInput;
	readonly sessionId: string;
}

export interface PendingPrompt {
	readonly gateId:     string;
	readonly specId:     string;
	readonly tool:       string;
	readonly input:      ToolInput;
	readonly sessionId:  string;
	readonly createdAt:  number;
	readonly resolve:    (verdict: PendingResolution) => void;
}

export interface PendingResolution {
	readonly verdict:        'allow' | 'deny';
	/**
	 * When `'session'`, the daemon should remember this allow for the
	 * rest of the spec's run -- not just the single call. The Mode B
	 * gate handler doesn't enforce this caching itself; the spec
	 * lookup function (which the daemon owns) does, and this flag
	 * propagates the user's intent up to the caller.
	 */
	readonly scope?:         'once' | 'session' | undefined;
	readonly stopReason?:    string | undefined;
}

export interface SpecLookup {
	(specId: string, sessionId: string): PermissionsBlock | undefined;
}

export interface HookServerConfig {
	readonly lookupSpec:         SpecLookup;
	/**
	 * Test seam: override the evaluator. Production uses
	 * `evaluatePermission` from permission-policy.js.
	 */
	readonly evaluate?:          ((policy: PermissionsBlock, req: { tool: string; input: ToolInput }) => PermissionVerdict) | undefined;
	/**
	 * Test seam: registry the stream handler uses to track prompts
	 * pending the user's modal response. Tests can inspect / resolve
	 * directly. Production wires this to the daemon's IDE-modal
	 * pipeline.
	 */
	readonly pendingPrompts?:    Map<string, PendingPrompt> | undefined;
	/**
	 * Test seam: generate the gate id. Production uses a base64url
	 * randomBytes; tests inject a counter.
	 */
	readonly nextGateId?:        (() => string) | undefined;
	/**
	 * Default-deny timeout in ms. When the prompt isn't resolved within
	 * this window, the handler defaults to deny so the agent's tool call
	 * gets a clean rejection and can recover. Design §9.5.
	 */
	readonly promptTimeoutMs?:   number | undefined;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Build the `gate.request-permission` stream handler. Returns a
 * `StreamHandler` and the registry of pending prompts so the daemon
 * can resolve them when the user's modal response comes back via the
 * separate `gate.resolve` IPC.
 */
export function makeRequestPermissionHandler(cfg: HookServerConfig): {
	readonly handler:         StreamHandler;
	readonly pendingPrompts:  Map<string, PendingPrompt>;
} {
	const evaluate       = cfg.evaluate       ?? evaluatePermission;
	const pendingPrompts = cfg.pendingPrompts ?? new Map<string, PendingPrompt>();
	const nextGateId     = cfg.nextGateId     ?? defaultGateIdGen();
	const timeoutMs      = cfg.promptTimeoutMs ?? DEFAULT_TIMEOUT_MS;

	const handler: StreamHandler = async (rawParams, send, signal): Promise<void> => {
		const params = rawParams as RequestPermissionParams;
		const sendWrapped = (msg: Omit<IpcStreamMessage, 'id'>): void => {
			send({ id: 0, ...msg });
		};

		const policy = cfg.lookupSpec(params.specId, params.sessionId);
		if (policy === undefined) {
			log.warn({ specId: params.specId }, 'gate.request-permission: spec policy not found; defaulting to deny');
			sendWrapped({ stream: 'progress', data: { verdict: 'deny', reason: `unknown specId '${params.specId}'` } });
			sendWrapped({ stream: 'done', data: {} });
			return;
		}

		const verdict = evaluate(policy, { tool: params.tool, input: params.input });
		log.info({ specId: params.specId, tool: params.tool, verdict }, 'gate.request-permission verdict');

		if (verdict === 'allow' || verdict === 'deny') {
			sendWrapped({ stream: 'progress', data: { verdict } });
			sendWrapped({ stream: 'done', data: {} });
			return;
		}

		// verdict === 'prompt' -- pause for the user's response via the IDE modal.
		const gateId = nextGateId();
		await waitForUserResolution(
			{ params, gateId, signal, timeoutMs, pendingPrompts },
			sendWrapped,
		);
	};

	return { handler, pendingPrompts };
}

async function waitForUserResolution(
	args: {
		params:         RequestPermissionParams;
		gateId:         string;
		signal:         AbortSignal;
		timeoutMs:      number;
		pendingPrompts: Map<string, PendingPrompt>;
	},
	send: (msg: Omit<IpcStreamMessage, 'id'>) => void,
): Promise<void> {
	const { params, gateId, signal, timeoutMs, pendingPrompts } = args;

	let settled = false;
	let resolve: (r: PendingResolution) => void = () => {};
	const promise = new Promise<PendingResolution>(r => { resolve = r; });

	const pending: PendingPrompt = {
		gateId,
		specId:    params.specId,
		tool:      params.tool,
		input:     params.input,
		sessionId: params.sessionId,
		createdAt: Date.now(),
		resolve:   r => {
			if (settled) return;
			settled = true;
			resolve(r);
		},
	};
	pendingPrompts.set(gateId, pending);

	// Surface the gate to the IDE.
	send({ stream: 'gate', data: { gateId, tool: params.tool, input: params.input, specId: params.specId, sessionId: params.sessionId } });

	const timeoutHandle = setTimeout(() => {
		if (settled) return;
		log.warn({ gateId, tool: params.tool, timeoutMs }, 'gate.request-permission: prompt timeout; defaulting to deny');
		pending.resolve({ verdict: 'deny', stopReason: `prompt timeout after ${timeoutMs}ms` });
	}, timeoutMs);

	const onAbort = (): void => {
		if (settled) return;
		pending.resolve({ verdict: 'deny', stopReason: 'gate cancelled (socket closed)' });
	};
	signal.addEventListener('abort', onAbort, { once: true });

	try {
		const resolution = await promise;
		send({ stream: 'progress', data: { verdict: resolution.verdict, ...(resolution.scope ? { scope: resolution.scope } : {}), ...(resolution.stopReason ? { stopReason: resolution.stopReason } : {}) } });
		send({ stream: 'done', data: {} });
	} finally {
		clearTimeout(timeoutHandle);
		signal.removeEventListener('abort', onAbort);
		pendingPrompts.delete(gateId);
	}
}

/**
 * `gate.resolve` IPC handler. The IDE calls this when the user
 * clicks Allow / Deny in the modal. The handler looks up the gate id
 * in the pending registry and forwards the verdict to the waiting
 * `request-permission` stream.
 */
export function makeGateResolveHandler(pendingPrompts: Map<string, PendingPrompt>): (params: unknown) => Promise<{ readonly resolved: boolean }> {
	return async (rawParams): Promise<{ readonly resolved: boolean }> => {
		const p = rawParams as { gateId: string; verdict: 'allow' | 'deny'; scope?: 'once' | 'session'; stopReason?: string };
		const pending = pendingPrompts.get(p.gateId);
		if (pending === undefined) return { resolved: false };
		const resolution: PendingResolution = {
			verdict: p.verdict,
			...(p.scope      !== undefined ? { scope:      p.scope      } : {}),
			...(p.stopReason !== undefined ? { stopReason: p.stopReason } : {}),
		};
		pending.resolve(resolution);
		return { resolved: true };
	};
}

function defaultGateIdGen(): () => string {
	const seenCounter = { n: 0 };
	return () => {
		seenCounter.n++;
		// Base36 + a counter for uniqueness within a daemon run.
		// Not cryptographic; this is a transient correlation id, not
		// an auth token.
		const t = Date.now().toString(36);
		const n = seenCounter.n.toString(36);
		return `gate-${t}-${n}`;
	};
}
