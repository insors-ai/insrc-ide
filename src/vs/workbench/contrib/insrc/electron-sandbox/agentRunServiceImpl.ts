/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IInsrcDaemonService } from '../common/daemonService.js';
import { IInsrcChatService } from '../common/chatService.js';
import { IInsrcAgentRunService, type AgentRunInfo, type AgentRunStatus } from '../common/agentRunService.js';

// ---------------------------------------------------------------------------
// AgentRunServiceImpl
// ---------------------------------------------------------------------------

export class InsrcAgentRunServiceImpl extends Disposable implements IInsrcAgentRunService {
	declare readonly _serviceBrand: undefined;

	private _cachedRuns: AgentRunInfo[] = [];

	/**
	 * In-memory analyze runs (U3). The daemon's agent.list RPC returns
	 * persisted brainstorm / code-analyzer / data-analyzer sessions
	 * from the conversation DB; analyze runs bypass that DB (state on
	 * disk under ~/.insrc/analyze/<runId>/run.json) so we track them
	 * here. getRuns() merges these with the daemon's list.
	 *
	 * Trade-off: analyze runs disappear from the Runs sidebar on IDE
	 * restart (on-disk state persists; the sidebar entry doesn't). A
	 * future commit can backfill by querying the daemon for active
	 * analyze records on startup, but for U3 in-memory only is enough
	 * to surface live runs as they happen.
	 */
	private readonly _analyzeRuns = new Map<string, AgentRunInfo>();

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

		// U3: subscribe to chat events so analyze runs surface in the
		// Runs sidebar without requiring a daemon-side runs.* stream.
		this._register(this.chatService.onDidReceiveEvent(e => this._handleChatEvent(e)));
	}

	async getRuns(repoPath?: string): Promise<readonly AgentRunInfo[]> {
		if (this.daemonService.isConnected) {
			try {
				const runs = await this.daemonService.rpc<AgentRunInfo[]>('agent.list');
				this._cachedRuns = runs ?? [];
			} catch (err) {
				this.logService.warn('[insrc] Failed to list agent runs:', (err as Error).message);
			}
		} else {
			this._cachedRuns = [];
		}

		// Merge daemon-sourced + in-memory analyze runs. Analyze runs are
		// listed AFTER the daemon ones in the merged result so the existing
		// brainstorm / code-analyzer entries stay at the top of the sidebar
		// (the view's date grouping will resort regardless).
		const merged: AgentRunInfo[] = [...this._cachedRuns, ...this._analyzeRuns.values()];
		if (repoPath) {
			return merged.filter(r => r.repo === repoPath);
		}
		return merged;
	}

	async resumeRun(runId: string): Promise<void> {
		// Analyze runs (in-memory) can't be resumed -- the chat panel's
		// re-send-prompt flow is how the user retries. The orchestrator's
		// resume short-circuit (status='ok'/stage='done') means re-sending
		// the same prompt cheaply replays the cached result; failed runs
		// re-run from scratch. Either way, the Runs sidebar's Resume
		// button is a no-op for analyze runs.
		if (this._analyzeRuns.has(runId)) {
			this.logService.info(`[insrc] resumeRun for analyze run is a no-op (use the chat panel to re-send): ${runId}`);
			return;
		}

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

		// Branch on controllerId. Each agent family has its own
		// resume RPC -- the daemon constructs different controller
		// classes + uses different state-restore logic. Today:
		//   - 'code-analyzer'    -> chat.resumeCodeAnalysis
		//   - 'data-analyzer'    -> chat.resumeDataAnalysis
		//   - everything else    -> chat.resumeFromCheckpoint
		//     (brainstorm subclasses validated daemon-side via
		//     row.agent === 'brainstorm').
		if (result.controllerId === 'code-analyzer') {
			await this.chatService.resumeCodeAnalysis(result.sessionId, repo);
		} else if (result.controllerId === 'data-analyzer') {
			await this.chatService.resumeDataAnalysis(result.sessionId, repo);
		} else {
			await this.chatService.resumeFromCheckpoint(result.sessionId, repo);
		}

		this._onDidChangeRuns.fire();
		this.logService.info(`[insrc] Resumed agent run id=${runId} controller=${result.controllerId ?? '(unknown)'}`);
	}

	async discardRun(runId: string): Promise<void> {
		// Analyze run: drop the in-memory entry. The on-disk
		// ~/.insrc/analyze/<runId>/ tree persists -- production cleanup
		// is the daemon's analyze.run.purge IPC, which the chat panel
		// can wire as a follow-up. For now, removing the sidebar entry
		// + leaving disk artifacts matches the conservative cleanup
		// pattern.
		if (this._analyzeRuns.has(runId)) {
			this._analyzeRuns.delete(runId);
			this._onDidChangeRuns.fire();
			this.logService.info(`[insrc] Discarded analyze run from sidebar: ${runId} (on-disk state preserved)`);
			return;
		}

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

	// -------------------------------------------------------------------------
	// U3: analyze-run lifecycle driven by chatService events
	// -------------------------------------------------------------------------

	private _handleChatEvent(e: { type: string;[key: string]: unknown }): void {
		const runId = typeof e['runId'] === 'string' ? e['runId'] as string : undefined;
		if (runId === undefined) { return; }

		switch (e.type) {
			case 'userMessage':
				this._registerAnalyzeRun(runId, e);
				return;
			case 'progress':
				this._updateAnalyzeRunStep(runId, e);
				return;
			case 'analyze-result':
				this._terminateAnalyzeRun(runId, e);
				return;
			case 'streamError':
				this._failAnalyzeRun(runId, e);
				return;
			case 'streamEnd':
				// Defense-in-depth: if no terminal frame fired but the
				// stream closed, flip a still-active analyze run to
				// 'completed' so the sidebar doesn't show a stuck
				// spinner. The daemon's contract is that analyze-result
				// always precedes done, but a transport drop could break
				// that.
				this._reconcileAnalyzeRunOnStreamEnd(runId);
				return;
			default:
				return;
		}
	}

	private _registerAnalyzeRun(runId: string, e: { [key: string]: unknown }): void {
		const repo = typeof e['repo'] === 'string' ? e['repo'] as string : undefined;
		const content = String(e['content'] ?? '');
		const summary = content.length > 60 ? `${content.slice(0, 57)}…` : content;
		const run: AgentRunInfo = {
			id: runId,
			agent: 'analyze',
			status: 'active',
			step: 'classify: started',
			...(repo !== undefined ? { repo } : {}),
			createdAt: new Date().toISOString(),
			summary,
		};
		this._analyzeRuns.set(runId, run);
		this._onDidChangeRuns.fire();
	}

	private _updateAnalyzeRunStep(runId: string, e: { [key: string]: unknown }): void {
		const current = this._analyzeRuns.get(runId);
		if (current === undefined) { return; }
		const step = this._formatStepLabel(e);
		this._analyzeRuns.set(runId, { ...current, step });
		this._onDidChangeRuns.fire();
	}

	private _terminateAnalyzeRun(runId: string, e: { [key: string]: unknown }): void {
		const current = this._analyzeRuns.get(runId);
		if (current === undefined) { return; }
		const result = e['result'] as { ok?: boolean; error?: { code?: string } } | undefined;
		const ok = result?.ok === true;
		const next: AgentRunInfo = {
			...current,
			status: ok ? 'completed' : 'crashed',
			step: ok ? undefined : (result?.error?.code ?? 'failed'),
		};
		this._analyzeRuns.set(runId, next);
		this._onDidChangeRuns.fire();
	}

	private _failAnalyzeRun(runId: string, e: { [key: string]: unknown }): void {
		const current = this._analyzeRuns.get(runId);
		if (current === undefined) { return; }
		const message = String(e['message'] ?? 'stream error');
		this._analyzeRuns.set(runId, { ...current, status: 'crashed', step: message });
		this._onDidChangeRuns.fire();
	}

	private _reconcileAnalyzeRunOnStreamEnd(runId: string): void {
		const current = this._analyzeRuns.get(runId);
		if (current === undefined) { return; }
		// Only flip if the run never reached a terminal state. The
		// analyze-result + streamError handlers above already set
		// 'completed' / 'crashed' explicitly; we don't want to overwrite
		// them on the trailing streamEnd that always follows.
		if (current.status === 'active') {
			const completed: AgentRunStatus = 'completed';
			this._analyzeRuns.set(runId, { ...current, status: completed, step: undefined });
			this._onDidChangeRuns.fire();
		}
	}

	/**
	 * Format a step label from a chat-progress event. The daemon's
	 * analyze.run.start emits two shapes:
	 *   - stage-level:  step='classify' / 'plan' / 'execute', status varies
	 *   - task-level:   step='task-N/M' or 'task-<id>', plus taskId +
	 *                   template + index/total + optional parentTaskPath
	 *
	 * Sidebar real-estate is limited (one line per run), so we pack the
	 * most useful fields into a short label rather than echoing all of
	 * the wire-level detail. The LiveStepsWidget in the chat pane
	 * shows the structured form.
	 */
	private _formatStepLabel(e: { [key: string]: unknown }): string {
		const step = String(e['step'] ?? '');
		const status = String(e['status'] ?? '');
		const taskId = typeof e['taskId'] === 'string' ? e['taskId'] as string : undefined;
		const template = typeof e['template'] === 'string' ? e['template'] as string : undefined;
		const index = typeof e['index'] === 'number' ? e['index'] as number : undefined;
		const total = typeof e['total'] === 'number' ? e['total'] as number : undefined;

		if (taskId !== undefined && template !== undefined && index !== undefined && total !== undefined) {
			return `task ${index}/${total}: ${template}`;
		}
		if (taskId !== undefined) {
			return `${taskId}: ${status}`;
		}
		return `${step}: ${status}`;
	}
}
