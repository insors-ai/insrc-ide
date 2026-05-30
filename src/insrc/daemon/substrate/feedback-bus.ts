/**
 * Feedback bus -- P5.1 of plans/skills/substrate-implementation-status.md.
 *
 * Implements substrate D8 (best-effort fire-and-forget feedback
 * dispatch) + D14 (assertion routing wires into the bus via
 * targetOwner). Per the locked design:
 *
 *   - In-process dispatch only. No persistence, no ack tracking, no
 *     retry, no dead-letter queue.
 *   - Per-target ordering: events to one owner arrive in emit order.
 *   - If a handler throws, the substrate logs + continues; other
 *     subscriptions still get their events.
 *   - Handlers don't need to be idempotent (we never replay).
 *   - Graceful shutdown calls `drain()` to flush pending dispatches;
 *     forced kills lose the queue.
 *
 * Deviation from the design: D8 ships parallel-cross-target fan-out.
 * P5 keeps a global serial dispatcher (one event at a time across
 * all targets) for two reasons:
 *
 *   1. CLAUDE.md's "no parallel LLM calls" rule applies anywhere a
 *      handler might reach an LLM. The bus can't tell which
 *      subscriptions are LLM-bound; serial-by-default avoids
 *      surprising the rule.
 *   2. Substrate is IDE-embedded; per-event latency is sub-second.
 *      Parallel fan-out is a micro-optimization that buys nothing
 *      until handler counts climb.
 *
 * Per-target ordering is trivially satisfied by global serial.
 * Parallel-cross-target is a future opt-in (similar to P3's
 * `parallelSafe` plan for context builders).
 */

import { getLogger } from '../../shared/logger.js';

import type {
	FeedbackEvent,
	FeedbackHandlerDeps,
	MemoryStore,
	OwnerId,
} from './types.js';

const log = getLogger('substrate:feedback-bus');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type FeedbackHandler = (event: FeedbackEvent, deps: FeedbackHandlerDeps) => Promise<void>;

export interface FeedbackSubscription {
	readonly owner: OwnerId;
	unsubscribe(): void;
}

export interface EmitReport {
	readonly event:     FeedbackEvent;
	readonly delivered: number;
	readonly failed:    number;
	readonly failures:  readonly { readonly owner: OwnerId; readonly error: string }[];
}

export interface FeedbackBus {
	/**
	 * Register a handler for an owner. An owner can hold multiple
	 * concurrent subscriptions (e.g. a skill that registers
	 * `applyFeedback` + an audit logger that taps the same owner).
	 */
	subscribe(owner: OwnerId, handler: FeedbackHandler): FeedbackSubscription;

	/**
	 * Dispatch an event to every subscription on the event's
	 * `targetOwner`. Resolves when every handler has either completed
	 * or thrown. Handlers run serially per the substrate's
	 * no-parallel-LLM contract.
	 */
	emit(event: FeedbackEvent): Promise<EmitReport>;

	/** Wait for the dispatch queue to drain. */
	drain(): Promise<void>;

	/** Introspection. */
	subscriberCount(owner: OwnerId): number;
}

export interface CreateFeedbackBusOpts {
	readonly memory: MemoryStore;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFeedbackBus(opts: CreateFeedbackBusOpts): FeedbackBus {
	// Map owner -> ordered list of handlers. Insertion order doubles as
	// per-owner dispatch order so the first subscriber sees the event
	// first; with global serial dispatch, the relative order of
	// subscribers on the same target is deterministic.
	const subscribers = new Map<OwnerId, FeedbackHandler[]>();

	// Global tail-promise serializer (same shape as the lifecycle-runner
	// trigger queue). One in-flight event globally; concurrent emits
	// queue and resolve in submission order.
	let tail: Promise<void> = Promise.resolve();
	function enqueue<T>(run: () => Promise<T>): Promise<T> {
		const next = tail.then(run, run);
		tail = next.then(() => undefined, () => undefined);
		return next;
	}

	return {
		subscribe(owner: OwnerId, handler: FeedbackHandler): FeedbackSubscription {
			let list = subscribers.get(owner);
			if (list === undefined) {
				list = [];
				subscribers.set(owner, list);
			}
			list.push(handler);
			log.debug({ owner, total: list.length }, 'feedback-bus:subscribe');
			return {
				owner,
				unsubscribe(): void {
					const cur = subscribers.get(owner);
					if (cur === undefined) { return; }
					const idx = cur.indexOf(handler);
					if (idx >= 0) { cur.splice(idx, 1); }
					if (cur.length === 0) { subscribers.delete(owner); }
				},
			};
		},

		subscriberCount(owner: OwnerId): number {
			return subscribers.get(owner)?.length ?? 0;
		},

		async emit(event: FeedbackEvent): Promise<EmitReport> {
			return enqueue(async () => {
				const list = subscribers.get(event.targetOwner);
				if (list === undefined || list.length === 0) {
					log.debug({ owner: event.targetOwner, kind: event.kind }, 'feedback-bus:emit no-subscriber');
					return { event, delivered: 0, failed: 0, failures: [] };
				}

				// Snapshot the handler list so a handler that
				// subscribes/unsubscribes mid-dispatch doesn't shift indices.
				const handlers = list.slice();
				const deps: FeedbackHandlerDeps = {
					memory: opts.memory,
					signal: new AbortController().signal,
				};

				let delivered = 0;
				let failed = 0;
				const failures: { owner: OwnerId; error: string }[] = [];

				for (const handler of handlers) {
					try {
						await handler(event, deps);
						delivered++;
					} catch (err) {
						failed++;
						const msg = (err as Error).message ?? String(err);
						failures.push({ owner: event.targetOwner, error: msg });
						log.warn(
							{ owner: event.targetOwner, kind: event.kind, err: msg },
							'feedback-bus:handler-failed',
						);
					}
				}

				return { event, delivered, failed, failures };
			});
		},

		async drain(): Promise<void> {
			await tail;
		},
	};
}
