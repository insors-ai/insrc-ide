/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { Event } from '../../../../base/common/event.js';

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

export const IInsrcSessionService = createDecorator<IInsrcSessionService>('insrcSessionService');

export interface IInsrcSessionService {
	readonly _serviceBrand: undefined;

	/** Active session events */
	readonly onDidChangeSession: Event<SessionChangeEvent>;

	/** Create a new brainstorm session */
	createSession(repoPath: string, message: string): Promise<string>;

	/** Resume a previously checkpointed session */
	resumeSession(sessionId: string): Promise<void>;

	/** List saved checkpoints for a repo */
	listCheckpoints(repoPath: string): Promise<SessionCheckpoint[]>;

	/** Get current session state */
	getSessionState(sessionId: string): unknown | undefined;

	/** Save checkpoint for current session */
	saveCheckpoint(sessionId: string): Promise<void>;
}
