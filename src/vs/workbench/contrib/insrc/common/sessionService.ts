/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { Event } from '../../../../base/common/event.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionCheckpoint {
	sessionId: string;
	repoPath: string;
	createdAt: string;
	lastActivity: string;
	ideaCount: number;
	round: number;
}

export interface SessionChangeEvent {
	sessionId: string;
	type: 'created' | 'updated' | 'closed';
}

export interface SessionDeltaEvent {
	sessionId: string;
	content: string;
}

export interface SessionGateEvent {
	sessionId: string;
	gateId: string;
	actions: string[];
}

export interface SessionProgressEvent {
	sessionId: string;
	step: string;
	status: string;
}

// ---------------------------------------------------------------------------
// IInsrcSessionService
// ---------------------------------------------------------------------------

export const IInsrcSessionService = createDecorator<IInsrcSessionService>('insrcSessionService');

export interface IInsrcSessionService {
	readonly _serviceBrand: undefined;

	/** Lifecycle events */
	readonly onDidChangeSession: Event<SessionChangeEvent>;

	/** Streaming events - views bind to these, never touch DaemonService directly */
	readonly onDidReceiveDelta: Event<SessionDeltaEvent>;
	readonly onDidReceiveGate: Event<SessionGateEvent>;
	readonly onDidProgress: Event<SessionProgressEvent>;

	/** Create a new session and start streaming */
	createSession(repoPath: string, message: string): Promise<string>;

	/** Resume a previously checkpointed session */
	resumeSession(sessionId: string): Promise<void>;

	/** Close a session and dispose its stream */
	closeSession(sessionId: string): void;

	/** List saved checkpoints for a repo */
	listCheckpoints(repoPath: string): Promise<SessionCheckpoint[]>;

	/** Get current session state */
	getSessionState(sessionId: string): unknown | undefined;

	/** Save checkpoint for current session */
	saveCheckpoint(sessionId: string): Promise<void>;
}
