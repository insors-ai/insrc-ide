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
	/**
	 * Live stdout chunk from the running agent subprocess (Phase 2c).
	 * Emitted once per raw `child.stdout.on('data')` chunk. Does not
	 * update the per-specId session state -- the terminal-mode
	 * subscriber consumes these directly via
	 * `IInsrcHandoffService.onChunk`.
	 */
	| {
		readonly kind: 'agent-stdout-chunk';
		readonly specId: string;
		readonly chunk: string;
	}
	/** Live stderr chunk; see `agent-stdout-chunk`. */
	| {
		readonly kind: 'agent-stderr-chunk';
		readonly specId: string;
		readonly chunk: string;
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
		/** Agent's deliverable text (the analysis / plan / report it
		 * produced). Surfaced verbatim in the Handoff Report Pane. */
		readonly deliverable: string;
	}
	| {
		readonly kind: 'handoff-error';
		readonly stage: HandoffErrorStage;
		readonly message: string;
	}
	/**
	 * Mode A pre-flight gate (Phase 3). Fires between `spec-ready`
	 * and `worktree-created` when the IDE-initiated handoff opts
	 * into the pre-flight check. The workbench renders an
	 * "approve this spec?" modal and replies via
	 * `resolveModeAPrompt`. On `deny` the daemon throws and the
	 * handoff stops before any worktree is created.
	 */
	| {
		readonly kind: 'mode-a-gate-request';
		readonly specId: string;
		readonly gateId: string;
		readonly templateId: HandoffTemplateId;
		readonly riskTag: HandoffRiskTag;
		/**
		 * Permission counts the modal renders as a one-line summary.
		 * Allowed / Prompt / Deny rules are passed through opaquely
		 * for the modal's "show details" view.
		 */
		readonly permissions: {
			readonly allow: readonly unknown[];
			readonly prompt: readonly unknown[];
			readonly deny: readonly unknown[];
		};
		readonly preview: string;
	}
	| {
		readonly kind: 'mode-a-gate-resolved';
		readonly specId: string;
		readonly gateId: string;
		readonly verdict: 'allow' | 'deny';
		readonly stopReason?: string | undefined;
	}
	/**
	 * Mode B in-flight permission prompt (Phase 3). The daemon's
	 * gate.request-permission hook hit a `prompt` verdict; the
	 * workbench renders a modal and replies via gate.resolve. The
	 * `gateId` correlates the request with the eventual
	 * `mode-b-gate-resolved` event.
	 */
	| {
		readonly kind: 'mode-b-gate-request';
		readonly specId: string;
		readonly gateId: string;
		readonly tool: string;
		readonly input: Record<string, unknown>;
		readonly sessionId: string;
	}
	/**
	 * Mode B prompt resolved by the user OR by the daemon's
	 * default-deny (timeout / cancellation). The workbench
	 * dismisses any open modal for this `gateId`.
	 */
	| {
		readonly kind: 'mode-b-gate-resolved';
		readonly specId: string;
		readonly gateId: string;
		readonly verdict: 'allow' | 'deny';
		readonly scope?: 'once' | 'session' | undefined;
		readonly stopReason?: string | undefined;
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
	/** Agent's deliverable text. Populated only on `handoff-final`. */
	readonly deliverable: string | undefined;
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

/**
 * Live stdout/stderr chunk payload (Phase 2c). Surfaced via the
 * service's `onChunk` event so a terminal-UX subscriber (the
 * Pseudoterminal) can pipe agent output into a VS Code terminal
 * panel as it arrives. Headless-UX consumers simply don't subscribe.
 */
export interface HandoffChunk {
	readonly specId: string;
	readonly stream: 'stdout' | 'stderr';
	readonly chunk: string;
}

/**
 * Pre-flight Mode A approval prompt (Phase 3). The orchestrator
 * paused after spec-ready awaiting the user's verdict; the
 * workbench renders an "approve this spec?" modal and replies via
 * {@link IInsrcHandoffService.resolveModeAPrompt}.
 */
export interface HandoffModeAPrompt {
	readonly specId: string;
	readonly gateId: string;
	readonly templateId: HandoffTemplateId;
	readonly riskTag: HandoffRiskTag;
	readonly permissions: {
		readonly allow: readonly unknown[];
		readonly prompt: readonly unknown[];
		readonly deny: readonly unknown[];
	};
	readonly preview: string;
}

export interface HandoffModeAResolution {
	readonly specId: string;
	readonly gateId: string;
	readonly verdict: 'allow' | 'deny';
	readonly stopReason?: string | undefined;
}

/**
 * In-flight permission prompt waiting on the user's modal response
 * (Phase 3 Mode B). The chat view subscribes to
 * `IInsrcHandoffService.onModeBPrompt` and renders a modal; the user's
 * verdict goes back via `IInsrcHandoffService.resolveModeBPrompt`.
 * Includes a `resolved: Event<HandoffModeBResolution>` so the modal
 * can dismiss itself if the daemon's default-deny timeout fires before
 * the user clicks.
 */
export interface HandoffModeBPrompt {
	readonly specId: string;
	readonly gateId: string;
	readonly tool: string;
	readonly input: Record<string, unknown>;
	readonly sessionId: string;
}

export interface HandoffModeBResolution {
	readonly specId: string;
	readonly gateId: string;
	readonly verdict: 'allow' | 'deny';
	readonly scope?: 'once' | 'session' | undefined;
	readonly stopReason?: string | undefined;
}

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
	 * Fires for every live stdout/stderr chunk the daemon forwards
	 * from a running agent subprocess. Phase 2c's terminal-UX mode
	 * subscribes to this; headless-UX leaves it alone.
	 */
	readonly onChunk: Event<HandoffChunk>;

	/**
	 * Fires when the orchestrator emits a Mode A pre-flight gate.
	 * Subscribers (the chat view) render a modal and reply via
	 * {@link resolveModeAPrompt}.
	 */
	readonly onModeAPrompt: Event<HandoffModeAPrompt>;

	/**
	 * Fires when an outstanding Mode A gate settles -- either by the
	 * IDE's reply or by the daemon's default-deny timeout. Modal
	 * subscribers dismiss any UI keyed to the same `gateId`.
	 */
	readonly onModeAResolution: Event<HandoffModeAResolution>;

	/**
	 * Fires whenever the daemon's PreToolUse hook hits a `prompt`
	 * verdict and is waiting on a user response (Phase 3 Mode B).
	 * Subscribers (the chat view) render a modal and reply via
	 * {@link resolveModeBPrompt}.
	 */
	readonly onModeBPrompt: Event<HandoffModeBPrompt>;

	/**
	 * Fires when an outstanding Mode B prompt is resolved -- either
	 * by the IDE's reply or by the daemon's default-deny timeout /
	 * cancellation. Modal subscribers dismiss any UI keyed to the
	 * same `gateId`.
	 */
	readonly onModeBResolution: Event<HandoffModeBResolution>;

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
	 * Reply to a Mode A pre-flight prompt. Forwards to the daemon's
	 * `handoff.mode-a.resolve` RPC. Idempotent on the daemon side
	 * if the gate is already settled (timeout / cancellation).
	 */
	resolveModeAPrompt(
		gateId: string,
		verdict: 'allow' | 'deny',
		opts?: { stopReason?: string },
	): Promise<void>;

	/**
	 * Cleanup a finalized handoff (Phase 5). Records the user's
	 * outcome verdict (`accept` / `reject` / `dismissed`) to disk
	 * and removes the worktree. Called from the handoff card's
	 * Accept / Reject / dismiss buttons.
	 */
	cleanupHandoff(
		sessionId: string,
		specId: string,
		outcome: 'accept' | 'reject' | 'dismissed',
		opts?: { stopReason?: string },
	): Promise<{ removed: boolean; outcomeRecorded: boolean }>;

	/**
	 * Reply to a Mode B prompt. The verdict is forwarded to the
	 * daemon's `gate.resolve` RPC; on `allow + scope === 'session'`
	 * the daemon will also remember the allow for the rest of the
	 * spec's run. Idempotent: a second call for the same `gateId`
	 * (e.g. timeout already fired) is a no-op on the daemon side.
	 */
	resolveModeBPrompt(
		gateId: string,
		verdict: 'allow' | 'deny',
		opts?: { scope?: 'once' | 'session'; stopReason?: string },
	): Promise<void>;

	/**
	 * Drop a session from the cache (e.g. user dismissed the card).
	 * Idempotent.
	 */
	clear(specId: string): void;

	/** Drop every session. Called on chat session change. */
	clearAll(): void;
}
