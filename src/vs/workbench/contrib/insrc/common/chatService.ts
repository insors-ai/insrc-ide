/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { Event } from '../../../../base/common/event.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
	readonly role: 'user' | 'assistant' | 'system';
	readonly content: string;
	readonly timestamp: string;
	readonly provider?: string | undefined;
}

export interface GateActionDetail {
	readonly name: string;
	readonly label?: string | undefined;
	readonly hint?: string | undefined;
	readonly needsInput?: boolean | undefined;
}

export interface GateInfo {
	readonly gateId: string;
	readonly actions: string[];
	/**
	 * Rich action metadata (label, hint, needsInput) when the daemon
	 * provided it. Chat-panel gate renderer uses this to show proper
	 * button labels and optional text-input fields for `needsInput`
	 * actions. Falls back to `actions` when absent.
	 */
	readonly actionDetails?: readonly GateActionDetail[] | undefined;
	readonly title?: string | undefined;
	readonly content?: string | undefined;
	readonly prompt?: string | undefined;
	readonly context?: unknown | undefined;
}

export interface ProgressInfo {
	readonly step: string;
	readonly status: string;
}

export interface ToolCallInfo {
	readonly tool: string;
	readonly input: unknown;
	readonly output?: unknown | undefined;
}

export interface EscalationInfo {
	readonly from: string;
	readonly to: string;
	readonly reason: string;
}

/**
 * Item 32b: transient token chunk from an agent step's LLM call.
 * Rendered in a dimmed "live step" bubble that's replaced with the
 * final output (or removed) when `done: true` arrives.
 */
export interface LiveStepInfo {
	readonly agent: string;
	readonly step: string;
	readonly text: string;
	readonly done?: boolean | undefined;
}

export type ChatEvent =
	| { type: 'message'; message: ChatMessage }
	| { type: 'gate'; gate: GateInfo }
	| { type: 'progress'; progress: ProgressInfo }
	| { type: 'liveStep'; liveStep: LiveStepInfo }
	| { type: 'tool'; tool: ToolCallInfo }
	| { type: 'escalation'; escalation: EscalationInfo }
	| { type: 'streamEnd' }
	| { type: 'error'; error: string };

export interface CodeAnnotation {
	readonly file: string;
	readonly line: number;
	readonly text: string;
	readonly note: string;
}

// ---------------------------------------------------------------------------
// IInsrcChatService
// ---------------------------------------------------------------------------

export const IInsrcChatService = createDecorator<IInsrcChatService>('insrcChatService');

export interface IInsrcChatService {
	readonly _serviceBrand: undefined;

	// State
	readonly activeSessionId: string | undefined;
	readonly activeRepo: string | undefined;
	readonly isStreaming: boolean;
	readonly messages: readonly ChatMessage[];

	// Events
	readonly onDidChangeSession: Event<string | undefined>;
	readonly onDidReceiveEvent: Event<ChatEvent>;
	/** Fires when chat.start returns NOT_CONFIGURED, so the IDE can
	 *  auto-open the Model Providers pane. */
	readonly onDidRequireConfig: Event<{ missing: 'local' | 'provider' | 'both' }>;

	// Session lifecycle
	startSession(repoPath: string): Promise<string>;
	resumeSession(sessionId: string): Promise<void>;
	/**
	 * Phase 2 session resume (Item 7). Opens the daemon's
	 * `chat.resumeFromCheckpoint` stream for the given session so the
	 * saved brainstorm rehydrates: checkpoint loaded, schemaVersion
	 * validated, controller rebuilt, last gate (or resume-confirm gate
	 * for in-flight steps) re-emitted. Caller should have already
	 * verified the run via `agentRunService.resumeRun` / `agent.resume`.
	 */
	resumeFromCheckpoint(sessionId: string, repoPath: string): Promise<void>;
	/**
	 * Code-analyzer-specific resume from checkpoint. Mirrors
	 * `resumeFromCheckpoint` shape but opens the daemon's
	 * `chat.resumeCodeAnalysis` stream instead of
	 * `chat.resumeFromCheckpoint` -- the daemon's resume handler
	 * is per-agent (brainstorm vs code-analyzer differ in
	 * controller construction). Caller resolves the right method
	 * by inspecting `controllerId` from `agent.resume`.
	 */
	resumeCodeAnalysis(sessionId: string, repoPath: string): Promise<void>;
	/**
	 * Data-analyzer-specific resume. Mirror of `resumeCodeAnalysis`
	 * for the data-analyzer family. Opens
	 * `chat.resumeDataAnalysis` on the daemon side, which
	 * reconstructs the DataAnalyzerOrchestratorController from the
	 * persisted checkpoint and re-enters via the controller's
	 * buildResumeTask + restoreState pattern (slice 1.9).
	 */
	resumeDataAnalysis(sessionId: string, repoPath: string): Promise<void>;
	closeSession(): Promise<void>;

	// Messaging
	/**
	 * Send a chat message. `provider` overrides the per-turn provider
	 * (same effect as an `@<provider>` prefix). `parentListId` is the
	 * Code Analyzer drill-down hook (Phase 5.D): when set, the daemon
	 * stamps it on the new TodoList so the Report Pane / todos pane
	 * can render parent-child threads. `rerunFromListId` is the
	 * Code Analyzer re-run hook (Phase 4.1): when set, the daemon
	 * skips the plan LLM call and reconstructs the analyzer task
	 * list from the prior run's items. Both are passed only by the
	 * dedicated workbench commands; regular chat sends omit them.
	 */
	sendMessage(
		message: string,
		provider?: string | undefined,
		parentListId?: string | undefined,
		rerunFromListId?: string | undefined,
	): Promise<void>;
	replyToGate(gateId: string, action: string, feedback?: string | undefined): Promise<void>;
	cancelStream(): Promise<void>;
	/**
	 * Mid-turn intent correction (Item 6). Cancels the current stream and
	 * immediately re-sends the refined user message prefixed with the chosen
	 * intent override (`/design`, `/implement`, ...). Rejects if no session
	 * is active or the daemon rejects the redirect. Resolves when the new
	 * turn has been submitted.
	 */
	redirect(intent: string, refinedMessage?: string): Promise<void>;
	/**
	 * Unified brainstorm cancel (Item 25). Does the full teardown every
	 * brainstorm-exit path needs: cancel the in-flight stream, close the
	 * daemon session, synthesize `streamEnd` so listeners drop their
	 * progress chrome, and fire `onRequestCloseBrainstormPanes` so the
	 * flow contribution can close any open brainstorm editor panes.
	 * Does NOT show a confirmation dialog -- callers are expected to
	 * have confirmed with the user already.
	 *
	 * `opts.discardCheckpoint` controls the Phase 2 session-resume
	 * cleanup (decision F1). User-initiated end-session flows (cancel
	 * button + pane close) pass `true` so the daemon's checkpoint file
	 * is deleted and the session no longer appears in the Runs sidebar.
	 * Involuntary teardowns (stream-timeout, connection-lost) pass
	 * `false` / undefined so the checkpoint survives and the user can
	 * recover via the Runs sidebar.
	 */
	cancelBrainstormSession(
		reason: string,
		opts?: { discardCheckpoint?: boolean },
	): Promise<void>;
	/**
	 * Fires when `cancelBrainstormSession` wants brainstorm panes to
	 * close. The flow contribution listens and calls `editorService.closeEditors`
	 * on every brainstorm input it knows about.
	 */
	readonly onRequestCloseBrainstormPanes: Event<void>;

	/**
	 * Item 53: close every open brainstorm pane without tearing down the
	 * chat session. Used after the post-save handoff-proposal gate is
	 * resolved -- the brainstorm pane should go away so the user can see
	 * the chat panel, but the session stays connected for the downstream
	 * agent handoff or follow-up chat.
	 */
	closeBrainstormPanes(): void;

	// History
	loadHistory(sessionId: string): Promise<ChatMessage[]>;

	// Annotations
	sendAnnotations(annotations: readonly CodeAnnotation[]): Promise<void>;
}
