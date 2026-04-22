/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IInsrcDaemonService } from '../common/daemonService.js';
import { IInsrcChatService } from '../common/chatService.js';
import { IInsrcAgentRunService, type AgentRunInfo } from '../common/agentRunService.js';

// ---------------------------------------------------------------------------
// AgentRunServiceImpl
// ---------------------------------------------------------------------------

export class InsrcAgentRunServiceImpl extends Disposable implements IInsrcAgentRunService {
	declare readonly _serviceBrand: undefined;

	private _cachedRuns: AgentRunInfo[] = [];

	private readonly _onDidChangeRuns = this._register(new Emitter<void>());
	readonly onDidChangeRuns: Event<void> = this._onDidChangeRuns.event;

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@IInsrcChatService private readonly chatService: IInsrcChatService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		// Auto-refresh the Runs sidebar whenever the chat service's
		// active session changes -- creation (user starts a brainstorm),
		// resume (agent.resume RPC from Runs sidebar), and close all
		// route through onDidChangeSession. Without this listener a
		// newly-started run doesn't appear in the sidebar until the user
		// triggers another mutation (discard / resume), which made it
		// look like new sessions were silently dropped.
		this._register(this.chatService.onDidChangeSession(() => this._onDidChangeRuns.fire()));
	}

	async getRuns(repoPath?: string): Promise<readonly AgentRunInfo[]> {
		if (!this.daemonService.isConnected) {
			return [];
		}

		try {
			const runs = await this.daemonService.rpc<AgentRunInfo[]>('agent.list');
			this._cachedRuns = runs ?? [];
		} catch (err) {
			this.logService.warn('[insrc] Failed to list agent runs:', (err as Error).message);
		}

		if (repoPath) {
			return this._cachedRuns.filter(r => r.repo === repoPath);
		}
		return this._cachedRuns;
	}

	async resumeRun(runId: string): Promise<void> {
		if (!this.daemonService.isConnected) {
			throw new Error('Not connected to daemon');
		}

		// Phase 2 session resume (Item 7). Two-step handshake:
		//  1. agent.resume validates the checkpoint + schemaVersion. On
		//     schema drift the daemon returns ok:false; we throw so the
		//     Runs sidebar surfaces the error message (decision I2 -- the
		//     only valid action then is Discard).
		//  2. If ok, open the daemon's chat.resumeFromCheckpoint stream
		//     via the chat service so the brainstorm controller rehydrates
		//     and the last gate (or resume-confirm gate) re-emits into the
		//     chat panel + pane flow.
		type ResumeResult = {
			ok: boolean;
			reason?: string;
			message?: string;
			sessionId?: string;
			controllerId?: string;
		};
		const result = await this.daemonService.rpc<ResumeResult>('agent.resume', { id: runId });
		if (!result.ok || !result.sessionId) {
			const reason = result.reason ?? 'unknown';
			const message = result.message ?? 'Resume failed';
			this.logService.warn(`[insrc] agent.resume rejected reason=${reason} id=${runId}`);
			throw new Error(`${message} (${reason})`);
		}

		// Look up the repo for this run so the chat service's local state
		// reflects which repo the session belongs to (chat panel's repo
		// selector otherwise drifts after a cold-daemon resume).
		const run = this._cachedRuns.find(r => r.id === runId);
		const repo = run?.repo ?? '';
		await this.chatService.resumeFromCheckpoint(result.sessionId, repo);

		this._onDidChangeRuns.fire();
		this.logService.info(`[insrc] Resumed agent run id=${runId} controller=${result.controllerId ?? '(unknown)'}`);
	}

	async discardRun(runId: string): Promise<void> {
		if (!this.daemonService.isConnected) {
			throw new Error('Not connected to daemon');
		}

		// If the discarded run is the chat panel's currently-active
		// session, tear down the local state too -- otherwise the next
		// chat.send would hit the daemon with a sessionId that no
		// longer exists and fail with stream-error. Stream-error fires
		// cancelBrainstormSession correctly but the UX is confusing
		// (user just discarded, then sees "session not found" errors).
		// Run the teardown BEFORE the daemon RPC so the session-end
		// path doesn't race with our own discard.
		const wasActive = this.chatService.activeSessionId === runId;
		if (wasActive) {
			try {
				await this.chatService.cancelBrainstormSession('user-discard-active', { discardCheckpoint: false });
			} catch {
				// Best-effort: the discard RPC below still purges DB + checkpoint.
			}
		}

		await this.daemonService.rpc('agent.discard', { id: runId });

		// Remove from cache
		this._cachedRuns = this._cachedRuns.filter(r => r.id !== runId);
		this._onDidChangeRuns.fire();
		this.logService.info(`[insrc] Discarded agent run: ${runId} wasActive=${wasActive}`);
	}
}
