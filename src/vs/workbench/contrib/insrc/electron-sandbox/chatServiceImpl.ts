/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * No-op chat service stub.
 *
 * The original implementation drove the chat panel + agent flows; both
 * went away in the cleanup. Phase 6 rebuilds against the new
 * CliProvider. This stub satisfies the surviving consumers' need for
 * an `activeSessionId` + `onDidChangeSession` without holding any state.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import type { IInsrcChatService } from '../common/chatService.js';

export class InsrcChatServiceImpl extends Disposable implements IInsrcChatService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeSession = this._register(new Emitter<string | undefined>());
	readonly onDidChangeSession: Event<string | undefined> = this._onDidChangeSession.event;

	private readonly _onDidReceiveEvent = this._register(new Emitter<{ type: string;[key: string]: unknown }>());
	readonly onDidReceiveEvent: Event<{ type: string;[key: string]: unknown }> = this._onDidReceiveEvent.event;

	private _activeSessionId: string | undefined = undefined;

	get activeSessionId(): string | undefined {
		return this._activeSessionId;
	}

	get isStreaming(): boolean {
		return false;
	}

	async startSession(_repo: string): Promise<string | undefined> { return undefined; }
	async resumeSession(_sessionId: string): Promise<void> { /* no-op */ }
	async deleteSession(_sessionId: string): Promise<{ deleted: boolean; reason?: string }> { return { deleted: false, reason: 'backend offline' }; }
	async deleteSessionsBulk(_sessionIds: readonly string[]): Promise<{ deleted: number; failed: number }> { return { deleted: 0, failed: 0 }; }
	async cancelBrainstormSession(_reason: string, _opts?: { discardCheckpoint?: boolean }): Promise<void> { /* no-op */ }
	async sendMessage(_message: string): Promise<void> { /* no-op */ }
	async resumeCodeAnalysis(_sessionId: string, _repo: string): Promise<void> { /* no-op */ }
	async resumeDataAnalysis(_sessionId: string, _repo: string): Promise<void> { /* no-op */ }
	async resumeFromCheckpoint(_sessionId: string, _repo: string): Promise<void> { /* no-op */ }
}
