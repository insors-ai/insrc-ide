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

	// Session lifecycle
	startSession(repoPath: string): Promise<string>;
	resumeSession(sessionId: string): Promise<void>;
	closeSession(): Promise<void>;

	// Messaging
	sendMessage(message: string, provider?: string | undefined): Promise<void>;
	replyToGate(gateId: string, action: string, feedback?: string | undefined): Promise<void>;
	cancelStream(): Promise<void>;

	// History
	loadHistory(sessionId: string): Promise<ChatMessage[]>;

	// Annotations
	sendAnnotations(annotations: readonly CodeAnnotation[]): Promise<void>;
}
