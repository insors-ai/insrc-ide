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

export type ChatEvent =
	| { type: 'message'; message: ChatMessage }
	| { type: 'gate'; gate: GateInfo }
	| { type: 'progress'; progress: ProgressInfo }
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
	closeSession(): Promise<void>;

	// Messaging
	sendMessage(message: string, provider?: string | undefined): Promise<void>;
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

	// History
	loadHistory(sessionId: string): Promise<ChatMessage[]>;

	// Annotations
	sendAnnotations(annotations: readonly CodeAnnotation[]): Promise<void>;
}
