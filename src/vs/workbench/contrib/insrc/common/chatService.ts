/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Chat service -- minimal interface stub after the cleanup.
 *
 * The original chat service was the conduit between the chat panel and
 * the agent backend; both ends went away in the cleanup. The interface
 * survives in skeletal form because several surviving panes (todos,
 * notepad, artifacts, sessionsView, agentRunService, status bar) ask
 * for an `activeSessionId` to scope their state. Phase 6 reintroduces
 * a real implementation against the new CliProvider; until then a
 * no-op stub is registered in electron-sandbox so the workbench builds
 * and runs cleanly.
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { Event } from '../../../../base/common/event.js';

export const IInsrcChatService = createDecorator<IInsrcChatService>('insrcChatService');

export interface IInsrcChatService {
	readonly _serviceBrand: undefined;

	/** Currently selected session id (used by widgets to scope their state). */
	readonly activeSessionId: string | undefined;

	/** True when the chat backend is streaming a response. Always false in the stub. */
	readonly isStreaming: boolean;

	/** Fires when the active session id changes. */
	readonly onDidChangeSession: Event<string | undefined>;

	/** Fires for generic IPC stream events (delta / progress / done). Stub emits nothing. */
	readonly onDidReceiveEvent: Event<{ type: string;[key: string]: unknown }>;

	/** Session lifecycle (no-op stubs until the new backend lands). */
	startSession(repo: string): Promise<string | undefined>;
	resumeSession(sessionId: string): Promise<void>;
	deleteSession(sessionId: string): Promise<{ deleted: boolean; reason?: string }>;
	deleteSessionsBulk(sessionIds: readonly string[]): Promise<{ deleted: number; failed: number }>;
	cancelBrainstormSession(reason: string, opts?: { discardCheckpoint?: boolean }): Promise<void>;

	/** Send a chat message (no-op until the new backend lands). */
	sendMessage(message: string): Promise<void>;

	/** Resume a session of a specific kind (no-op stubs until the new backend lands). */
	resumeCodeAnalysis(sessionId: string, repo: string): Promise<void>;
	resumeDataAnalysis(sessionId: string, repo: string): Promise<void>;
	resumeFromCheckpoint(sessionId: string, repo: string): Promise<void>;
}
