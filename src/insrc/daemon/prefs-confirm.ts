/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Layer 3 confirm staging + resolve (memory-context M1.6.a).
 *
 * When the Layer 2 LLM classifier accepts an assertion with confidence
 * below the auto-accept threshold, the classifier calls the Layer 3
 * `userConfirm` hook before persisting. The UX can't answer in-line
 * (the user is reading the assistant's response, not waiting on a
 * modal), so this module turns Layer 3 into an asynchronous staging
 * pattern:
 *
 *   1. Hook stages the payload to substrate (`agent:chat`,
 *      `user-assertions-pending`, kind: 'hint'). The staging entry IS
 *      the durable "no silent loss" guarantee from G2 -- even if the
 *      user never looks at the toast, the candidate survives across
 *      sessions and can be revisited.
 *   2. Hook fires a `PendingConfirmEvent` to anyone subscribed. The
 *      chat-handler subscribes and forwards the event as a streaming
 *      IPC frame so the IDE-side toast can render.
 *   3. Hook returns `kind: 'defer'` so the classifier doesn't persist
 *      the payload to the confirmed `user-assertions` namespace yet.
 *
 *   4. Later, when the user clicks Save / Customize-Save / Discard,
 *      the IDE calls `prefs.confirm.resolve`, which routes through
 *      `resolvePendingConfirm` here:
 *      - Save     -> promote hint to constraint in `user-assertions`;
 *                    delete the pending row; fire FeedbackBus event so
 *                    ContextManager invalidates its L1 cache.
 *      - Discard  -> rewrite the pending row with
 *                    `userDiscarded: true` so future passes skip it
 *                    (audit trail preserved); no constraint write.
 *
 * The `user-assertions-pending` namespace is checked by `prefs.list`
 * via an `includePending` option so the user can see waiting items in
 * the same view.
 */

import { EventEmitter } from 'node:events';

import { getLogger } from '../shared/logger.js';
import type { IpcStreamMessage } from '../shared/types.js';
import { AGENT_CHAT_OWNER, getSubstrateRuntime, hasSubstrateRuntime } from './substrate/singleton.js';
import type { FeedbackEvent } from './substrate/types.js';
import type {
	UserAssertionPayload,
	UserConfirmHook,
} from './substrate/classifier/user-assertion.js';

const log = getLogger('daemon:prefs-confirm');

export const PENDING_NS  = 'user-assertions-pending';
export const CONFIRMED_NS = 'user-assertions';


// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Fired when a payload is staged into the pending namespace. The
 * chat-handler subscribes to this and forwards via streaming IPC so
 * the IDE can render the Layer 3 toast.
 */
export interface PendingConfirmEvent {
	readonly key:           string;          // <turnId>::<subject>
	readonly turnId:        string;
	readonly subject:       string;
	readonly canonicalText: string;
	readonly rawSpan:       string;
	readonly confidence:    number;
	readonly polarity:      string;
	readonly scope:         string;
	readonly repoPaths?:    readonly string[];
	readonly categories?:   readonly string[];
}

export interface PendingConfirmListEntry extends PendingConfirmEvent {
	readonly userDiscarded: boolean;
	readonly stagedAt:      number;
}

export type ResolveVerdict = 'accept' | 'discard';

export interface ResolvePendingConfirmParams {
	readonly key:            string;
	readonly verdict:        ResolveVerdict;
	/** When `verdict === 'accept'`, an optional override for canonical text. */
	readonly canonicalText?: string;
	/** When accepting, optionally bump confidence above the auto-accept threshold. */
	readonly confidence?:    number;
}

export interface ResolvePendingConfirmResult {
	readonly ok:       true;
	readonly key:      string;
	readonly verdict:  ResolveVerdict;
	readonly promoted: boolean;
}


// ---------------------------------------------------------------------------
// Event bus (process-local; no persistence)
// ---------------------------------------------------------------------------

const emitter = new EventEmitter();
const EVENT_NAME = 'pending-confirm';

export function onPendingConfirm(listener: (evt: PendingConfirmEvent) => void): () => void {
	emitter.on(EVENT_NAME, listener);
	return () => { emitter.off(EVENT_NAME, listener); };
}

/**
 * memory-context M5.5. Emit a `PendingConfirmEvent` from outside the
 * Layer 3 hook -- used by the implicit-capture pass to notify the
 * chat-handler-bridge subscribers that an implicitly-staged candidate
 * is now sitting in the pending namespace. The staging write happens
 * elsewhere; this only emits the event so the IDE toast can render.
 */
export function emitPendingConfirm(evt: PendingConfirmEvent): void {
	emitter.emit(EVENT_NAME, evt);
}

/** Test-only: clear all listeners so suites don't leak handlers across runs. */
export function _resetPendingConfirmEmitterForTests(): void {
	emitter.removeAllListeners(EVENT_NAME);
}


// ---------------------------------------------------------------------------
// Layer 3 staging hook
// ---------------------------------------------------------------------------

/**
 * Build the UserConfirmHook the classifier should invoke on Layer 2
 * low-confidence accepts. Stages the payload into the pending
 * namespace, fires a `PendingConfirmEvent`, and defers.
 *
 * The hook is intentionally side-effecting (a write + a bus emit) but
 * idempotent on key collisions: re-staging the same `(turnId, subject)`
 * overwrites the prior entry and resets `userDiscarded` to false.
 */
export function createPendingConfirmHook(): UserConfirmHook {
	return async (span, hints) => {
		if (!hasSubstrateRuntime()) {
			log.warn({ turnId: hints.turnId }, 'pending-confirm hook called before substrate init; deferring');
			return { kind: 'defer' };
		}
		// The classifier doesn't hand us the payload yet -- only the span +
		// turnId -- so we stage a minimal record. The Layer 2 hook *did*
		// produce a payload; we need it. The current classifier hands the
		// Layer 3 hook just `span + { turnId }`. We can't recover the
		// closed-enum subject without re-running Layer 2. Until the
		// classifier API evolves (TODO M1.6 follow-up), we use the raw
		// span as both canonicalText and a heuristic subject derived from
		// the leading verb. This keeps the toast functional today; the
		// classifier upgrade lands separately.
		const subject = guessSubjectFromSpan(span);
		const key     = `${hints.turnId}::${subject}`;
		const runtime = getSubstrateRuntime();
		const ns      = runtime.memory.scope(AGENT_CHAT_OWNER, PENDING_NS);

		const payload = {
			text:              span,
			subject,
			preferenceSubject: subject,
			canonicalText:     span,
			polarity:          'preference',
			scope:             'workspace',
			targetOwners:      [],
			confidence:        0.6,
			userDiscarded:     false,
		};

		try {
			await ns.put(key, payload, {
				kind:       'hint',
				source:     { kind: 'user-asserted', turnId: hints.turnId },
				confidence: 0.6,
			});
		} catch (err) {
			log.warn({ key, err: (err as Error).message }, 'pending-confirm staging failed');
			return { kind: 'defer' };
		}

		emitter.emit(EVENT_NAME, {
			key,
			turnId:        hints.turnId,
			subject,
			canonicalText: span,
			rawSpan:       span,
			confidence:    0.6,
			polarity:      'preference',
			scope:         'workspace',
		} satisfies PendingConfirmEvent);

		return { kind: 'defer' };
	};
}


// ---------------------------------------------------------------------------
// Listing pending entries
// ---------------------------------------------------------------------------

export async function listPendingConfirms(): Promise<readonly PendingConfirmListEntry[]> {
	if (!hasSubstrateRuntime()) { return []; }
	const runtime = getSubstrateRuntime();
	const ns = runtime.memory.scope(AGENT_CHAT_OWNER, PENDING_NS);
	const out: PendingConfirmListEntry[] = [];
	for await (const entry of ns.scan<Record<string, unknown>>('')) {
		if (entry.kind !== 'hint') { continue; }
		const v = entry.value as Record<string, unknown>;
		const turnId = (typeof entry.source === 'object' && entry.source !== null && 'turnId' in entry.source)
			? String((entry.source as { turnId: unknown }).turnId)
			: '';
		out.push({
			key:           entry.key,
			turnId,
			subject:       strField(v, 'subject') ?? strField(v, 'preferenceSubject') ?? '',
			canonicalText: strField(v, 'canonicalText') ?? strField(v, 'text') ?? '',
			rawSpan:       strField(v, 'text') ?? strField(v, 'canonicalText') ?? '',
			confidence:    entry.confidence,
			polarity:      strField(v, 'polarity') ?? 'preference',
			scope:         strField(v, 'scope')    ?? 'workspace',
			userDiscarded: v['userDiscarded'] === true,
			stagedAt:      entry.writtenAt,
			...(Array.isArray(v['repoPaths'])  ? { repoPaths:  v['repoPaths']  as string[] } : {}),
			...(Array.isArray(v['categories']) ? { categories: v['categories'] as string[] } : {}),
		});
	}
	out.sort((a, b) => b.stagedAt - a.stagedAt);
	return out;
}


// ---------------------------------------------------------------------------
// Resolve verdict -> promote or discard
// ---------------------------------------------------------------------------

export async function resolvePendingConfirm(params: ResolvePendingConfirmParams): Promise<ResolvePendingConfirmResult> {
	if (!hasSubstrateRuntime()) {
		throw new Error('substrate runtime not initialised');
	}
	validate(params);
	const runtime    = getSubstrateRuntime();
	const pendingNs  = runtime.memory.scope(AGENT_CHAT_OWNER, PENDING_NS);
	const confirmedNs = runtime.memory.scope(AGENT_CHAT_OWNER, CONFIRMED_NS);

	const existing = await pendingNs.get<Record<string, unknown>>(params.key);
	if (existing === undefined) {
		throw new Error(`prefs.confirm.resolve: no pending entry for key '${params.key}'`);
	}

	if (params.verdict === 'discard') {
		// Delete-then-put: the substrate's D4 merge policy keeps the prior
		// entry on a same-kind / same-confidence write, so an in-place
		// update to set `userDiscarded:true` would silently no-op. Delete
		// first to let the new value land authoritatively.
		const discardedValue = { ...(existing.value as Record<string, unknown>), userDiscarded: true };
		await pendingNs.delete(params.key);
		await pendingNs.put(params.key, discardedValue, {
			kind:       'hint',
			source:     existing.source,
			confidence: existing.confidence,
		});
		await emitFeedback(runtime, params.key, 'discard');
		return { ok: true, key: params.key, verdict: 'discard', promoted: false };
	}

	// verdict === 'accept' -> promote to constraint in user-assertions
	const v = existing.value as Record<string, unknown>;
	const canonicalText = params.canonicalText ?? strField(v, 'canonicalText') ?? strField(v, 'text') ?? '';
	const confidence    = params.confidence    ?? Math.max(0.8, existing.confidence);
	const constraintPayload: Record<string, unknown> = {
		...v,
		canonicalText,
		text:        canonicalText,
		confidence,
	};
	delete constraintPayload['userDiscarded'];

	const ref = await confirmedNs.put(params.key, constraintPayload, {
		kind:       'constraint',
		source:     existing.source,
		confidence,
	});
	await pendingNs.delete(params.key);
	await emitFeedback(runtime, params.key, 'accept', ref);
	return { ok: true, key: params.key, verdict: 'accept', promoted: true };
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function emitFeedback(
	runtime: ReturnType<typeof getSubstrateRuntime>,
	key:     string,
	verdict: ResolveVerdict,
	ref?:    string,
): Promise<void> {
	try {
		const event: FeedbackEvent = {
			id:          `prefs-confirm-${verdict}-${key}-${Date.now()}`,
			kind:        'user-correction',
			targetOwner: AGENT_CHAT_OWNER,
			memoryRefs:  ref !== undefined ? [ref] : [],
			payload:     { source: 'prefs.confirm.resolve', key, verdict },
			source:      'rpc:prefs.confirm.resolve',
			at:          Date.now(),
		};
		await runtime.feedbackBus.emit(event);
	} catch (err) {
		log.warn({ key, verdict, err: (err as Error).message }, 'prefs.confirm.resolve: feedback dispatch failed');
	}
}

function validate(p: unknown): asserts p is ResolvePendingConfirmParams {
	if (typeof p !== 'object' || p === null) {
		throw new Error('prefs.confirm.resolve: params required');
	}
	const o = p as Record<string, unknown>;
	if (typeof o['key'] !== 'string' || o['key'].length === 0) {
		throw new Error('prefs.confirm.resolve: `key` (string) is required');
	}
	if (o['verdict'] !== 'accept' && o['verdict'] !== 'discard') {
		throw new Error('prefs.confirm.resolve: `verdict` must be `accept` or `discard`');
	}
	if (o['canonicalText'] !== undefined && (typeof o['canonicalText'] !== 'string' || o['canonicalText'].length === 0)) {
		throw new Error('prefs.confirm.resolve: `canonicalText` must be a non-empty string');
	}
	if (o['confidence'] !== undefined) {
		const c = o['confidence'];
		if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) {
			throw new Error('prefs.confirm.resolve: `confidence` must be in [0, 1]');
		}
	}
}

function strField(o: Record<string, unknown>, k: string): string | undefined {
	const v = o[k];
	return typeof v === 'string' ? v : undefined;
}

/**
 * Heuristic subject extraction so the pending entry has a stable subject
 * to key on before the user customizes. Pattern set is small on purpose --
 * the user can always override via the Customize editor.
 */
function guessSubjectFromSpan(span: string): string {
	const m1 = span.match(/use\s+([a-z0-9_-]+)\s+for\s+([a-z0-9_-]+)/i);
	if (m1 !== null) { return `${m1[1]!.toLowerCase()}-for-${m1[2]!.toLowerCase()}`; }
	const m2 = span.match(/^(?:always|never|avoid|do not|don't|prefer|require)\s+([a-z0-9_-]+)/i);
	if (m2 !== null) { return m2[1]!.toLowerCase(); }
	const m3 = span.match(/\b(test|deploy|review|release|naming|format|style|security|performance)\b/i);
	if (m3 !== null) { return m3[1]!.toLowerCase(); }
	return 'unspecified';
}

// ---------------------------------------------------------------------------
// Chat-handler bridge (M1.6.b)
// ---------------------------------------------------------------------------

/**
 * Stream-shape sent on the `assertion-confirm` IPC channel. Mirrors
 * `PendingConfirmEvent` plus the IPC framing the IDE needs to render
 * the Layer 3 toast.
 */
export interface AssertionConfirmStreamFrame {
	readonly kind:    'pending';
	readonly payload: PendingConfirmEvent;
}

/**
 * Subscribe to pending-confirm events for the duration of one chat
 * turn and forward each as an `IpcStreamMessage` so the IDE toast can
 * render. Returns the unsubscribe function -- caller must call it once
 * the turn's classify pass completes (or aborts) to avoid listener
 * leaks across turns.
 *
 * The bridge is a thin forwarder; per-frame filtering belongs in the
 * IDE-side handler. Aborted signals stop emission immediately (the
 * guardedSend caller already discards messages after abort, but we
 * short-circuit here so we don't bother fanning out frames the IDE
 * will throw away).
 */
export function bridgePendingConfirmToStream(
	requestId: number,
	send:      (msg: IpcStreamMessage) => void,
	signal?:   AbortSignal,
): () => void {
	return onPendingConfirm((event) => {
		if (signal?.aborted === true) { return; }
		const frame: AssertionConfirmStreamFrame = { kind: 'pending', payload: event };
		send({ id: requestId, stream: 'assertion-confirm', data: frame });
	});
}

// Re-export the UserAssertionPayload type so callers don't need a second import path.
export type { UserAssertionPayload };
