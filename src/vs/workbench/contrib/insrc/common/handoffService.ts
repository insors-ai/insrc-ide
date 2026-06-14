/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { Event } from '../../../../base/common/event.js';

/**
 * Browser-side interface + types for the external-agent handoff
 * pipeline (plans/external-agent-integration.md Phase 2b).
 *
 * Shape mirrors the daemon's `HandoffEvent` discriminated union in
 * `src/insrc/handoff/types.ts`. Types are intentionally duplicated --
 * not imported across the project boundary -- because the workbench
 * contrib and the daemon are compiled with separate tsconfigs; the
 * wire format is the contract.
 *
 * The service aggregates events keyed by `specId` so the chat widget
 * (Day 3) can render one card per in-flight handoff. Events arrive
 * over two channels:
 *
 *   1. The active chat session's stream (when section-flow drives
 *      the handoff in-process inside the daemon -- the typical UX
 *      path). `chatServiceImpl` forwards `{ type: 'handoff' }`
 *      messages here via `dispatch()`.
 *
 *   2. Direct `handoff.run` IPC invocation (CLI, future debug
 *      commands). Not used by the chat flow today; reserved for
 *      Phase 2c+.
 *
 * The service is **read-only from the UI side** -- it never starts
 * a handoff itself. Section-flow owns lifecycle; the daemon emits
 * events as the pipeline progresses.
 */

// ---------------------------------------------------------------------------
// Template ids + risk tag (mirror src/insrc/handoff/types.ts)
// ---------------------------------------------------------------------------

export type HandoffTemplateId =
	| 'DEBUG-SESSION'
	| 'SPEC'
	| 'DESIGN'
	| 'REQUIREMENTS'
	| 'TEST-PLAN'
	| 'REVIEW'
	| 'MIGRATION'
	| 'AUDIT';

export type HandoffRiskTag = 'low' | 'medium' | 'high';

export type HandoffAgentChoice = 'claude-code' | 'codex' | 'scripted-agent';

export type HandoffVerdict = 'accept' | 'revise-edits' | 'revise-major';

export type HandoffErrorStage =
	| 'spec-assemble' | 'worktree' | 'spawn' | 'audit' | 'diff';

// ---------------------------------------------------------------------------
// HandoffEvent discriminated union -- mirrors daemon's 9 variants exactly
// ---------------------------------------------------------------------------

export type HandoffEvent =
	| {
		readonly kind: 'spec-assembling';
		readonly intent: string;
		readonly templateId: HandoffTemplateId;
	}
	| {
		readonly kind: 'spec-ready';
		readonly specId: string;
		readonly templateId: HandoffTemplateId;
		/** First ~200 chars of the spec markdown for a preview rendering. */
		readonly preview: string;
	}
	| {
		readonly kind: 'worktree-created';
		readonly specId: string;
		readonly worktreePath: string;
		readonly ref: string;
	}
	| {
		readonly kind: 'spawned';
		readonly specId: string;
		readonly agent: HandoffAgentChoice;
	}
	| {
		readonly kind: 'agent-completed';
		readonly specId: string;
		readonly exitCode: number;
		readonly durationMs: number;
		readonly stdoutLen: number;
	}
	| {
		readonly kind: 'auditing';
		readonly specId: string;
	}
	| {
		readonly kind: 'audit-ready';
		readonly specId: string;
		readonly verdict: HandoffVerdict;
		readonly reason: string;
		readonly editHintCount: number;
		readonly machineCheckCount: number;
		/** Diff size in bytes; the diff body lands on `handoff-final`. */
		readonly diffBytes: number;
	}
	| {
		readonly kind: 'handoff-final';
		readonly specId: string;
		readonly verdict: HandoffVerdict;
		readonly diff: string;
		readonly worktreePath: string;
	}
	| {
		readonly kind: 'handoff-error';
		readonly stage: HandoffErrorStage;
		readonly message: string;
	};

// ---------------------------------------------------------------------------
// Per-handoff aggregated state
// ---------------------------------------------------------------------------

/**
 * Pipeline stage the handoff is currently in. Derived from the most
 * recent event the service has seen. The widget (Day 3) reads this
 * to pick a label / icon / progress treatment.
 *
 * Stage transitions are monotone forward except `error` and `final`
 * which are terminal -- once a handoff reaches either, no further
 * events update its state.
 */
export type HandoffStage =
	| 'spec-assembling'
	| 'spec-ready'
	| 'worktree-created'
	| 'spawned'
	| 'agent-completed'
	| 'auditing'
	| 'audit-ready'
	| 'final'
	| 'error';

/**
 * Snapshot of one in-flight or recently-finished handoff. The chat
 * widget reads these fields directly; new fields land here as the
 * pipeline progresses. Mutating fields are typed loosely to keep
 * the snapshot shape stable -- the widget rebuilds on `onDidChange`.
 */
export interface HandoffSessionState {
	/**
	 * Stable handoff identifier. Allocated by the daemon at
	 * `spec-assembling`-time via a placeholder, then replaced with the
	 * canonical specId once `spec-ready` arrives. Before specId is
	 * known the service uses a synthetic id (`pending:<intent-hash>`)
	 * so callers can still address the state object.
	 */
	readonly specId: string;
	readonly intent: string | undefined;
	readonly templateId: HandoffTemplateId | undefined;
	readonly stage: HandoffStage;
	/** First ~200 chars of the spec markdown. Populated on `spec-ready`. */
	readonly preview: string | undefined;
	readonly worktreePath: string | undefined;
	readonly agent: HandoffAgentChoice | undefined;
	readonly exitCode: number | undefined;
	readonly durationMs: number | undefined;
	readonly verdict: HandoffVerdict | undefined;
	readonly auditReason: string | undefined;
	readonly editHintCount: number | undefined;
	readonly machineCheckCount: number | undefined;
	readonly diffBytes: number | undefined;
	/** Full diff body. Populated only on `handoff-final`. */
	readonly diff: string | undefined;
	readonly errorStage: HandoffErrorStage | undefined;
	readonly errorMessage: string | undefined;
	/** When this state was first created (ISO-8601). */
	readonly startedAt: string;
	/** When the most recent event landed (ISO-8601). */
	readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const IInsrcHandoffService =
	createDecorator<IInsrcHandoffService>('insrcHandoffService');

export interface IInsrcHandoffService {
	readonly _serviceBrand: undefined;

	/**
	 * All known handoff sessions keyed by specId. Order is insertion
	 * order -- the chat widget renders them top-to-bottom in arrival
	 * order. Terminal sessions (`final` / `error`) remain in the map
	 * so the user can still review the last handoff's diff/verdict;
	 * `clear(specId)` drops them.
	 */
	readonly sessions: ReadonlyMap<string, HandoffSessionState>;

	/** Fires whenever any session is created, updated, or removed. */
	readonly onDidChange: Event<void>;

	/**
	 * Granular per-session event. Fires only for the session that
	 * changed -- widgets keyed to a specId can subscribe here instead
	 * of re-reading the full `sessions` map on every change.
	 */
	readonly onDidChangeSession: Event<HandoffSessionState>;

	/**
	 * Fires once a handoff reaches `final` (verdict known + diff body
	 * available). Day 4 wires the diff-view + accept/reject flow off
	 * this event.
	 */
	readonly onDidFinalize: Event<HandoffSessionState>;

	/**
	 * Fires when a session is dropped (via `clear` or session reset).
	 * Subscribers should release any keyed cache they hold.
	 */
	readonly onDidRemoveSession: Event<string>;

	/**
	 * Dispatch a single daemon-emitted HandoffEvent. Called by
	 * `chatServiceImpl._handleStreamMessage` when it sees a
	 * `{ type: 'handoff' }` message on the active chat stream.
	 *
	 * Returns true if the event was applied (specId resolvable);
	 * false if the event was rejected as malformed.
	 */
	dispatch(event: HandoffEvent): boolean;

	/**
	 * Drop a session from the cache (e.g. user dismissed the card).
	 * Idempotent.
	 */
	clear(specId: string): void;

	/** Drop every session. Called on chat session change. */
	clearAll(): void;
}
