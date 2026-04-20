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

export interface GateInfo {
	readonly gateId: string;
	readonly actions: string[];
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

	// History
	loadHistory(sessionId: string): Promise<ChatMessage[]>;

	// Annotations
	sendAnnotations(annotations: readonly CodeAnnotation[]): Promise<void>;
}
