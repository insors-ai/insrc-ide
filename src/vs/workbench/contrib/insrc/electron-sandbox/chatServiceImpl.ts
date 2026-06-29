/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Chat service implementation -- drives analyze.run.start over the
 * daemon's streaming RPC.
 *
 * sendMessage(text) starts a run by calling
 * daemonService.stream('analyze.run.start', { runId, userPrompt, scopeRef })
 * and re-fires every DaemonStreamMessage frame as a generic
 * `onDidReceiveEvent` event the chat panel + status bar listen to.
 *
 * Frame -> event mapping:
 *
 *   { type: 'progress', step, status, ...extras }
 *     re-emitted as onDidReceiveEvent({ type: 'progress', ... }) so the
 *     existing status bar's spinner logic (it watches for 'progress' +
 *     'streamEnd' on this service) keeps working unchanged.
 *
 *   { type: 'analyze-result', result }
 *     re-emitted as onDidReceiveEvent({ type: 'analyze-result', runId,
 *     result }). The chat view pane subscribes to this + opens the
 *     AnalyzeReportInput editor tab on ok:true / surfaces the failure
 *     code on ok:false.
 *
 *   stream's onDidEnd
 *     fires onDidReceiveEvent({ type: 'streamEnd', runId }) so the
 *     status bar's spinner stops.
 *
 *   stream's onDidError
 *     fires onDidReceiveEvent({ type: 'streamError', runId, message })
 *     followed by 'streamEnd' to ensure isStreaming flips back to false
 *     even on socket loss.
 *
 * scopeRef derivation: caller passes the active workspace folder path
 * via sendMessage's contract. The chat view pane reads
 * IWorkspaceContextService for that path and forwards it. If no
 * folder is open, sendMessage logs a warning + drops the call (no
 * point starting an analyze run with no scope).
 *
 * Session lifecycle: U1 doesn't bootstrap chat sessions; the analyze
 * pipeline uses its own runId universe. Session integration (per-repo
 * persisted message history) lands in U4.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IInsrcDaemonService, type DaemonStreamMessage, type IInsrcStreamHandle } from '../common/daemonService.js';
import type { IInsrcChatService } from '../common/chatService.js';

export class InsrcChatServiceImpl extends Disposable implements IInsrcChatService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeSession = this._register(new Emitter<string | undefined>());
	readonly onDidChangeSession: Event<string | undefined> = this._onDidChangeSession.event;

	private readonly _onDidReceiveEvent = this._register(new Emitter<{ type: string;[key: string]: unknown }>());
	readonly onDidReceiveEvent: Event<{ type: string;[key: string]: unknown }> = this._onDidReceiveEvent.event;

	private _activeSessionId: string | undefined = undefined;
	private _activeHandle: IInsrcStreamHandle | undefined = undefined;

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	get activeSessionId(): string | undefined { return this._activeSessionId; }

	get isStreaming(): boolean { return this._activeHandle !== undefined; }

	// -------------------------------------------------------------------------
	// Session lifecycle (no-op shells for U1 -- U4 wires chat sessions in)
	// -------------------------------------------------------------------------

	async startSession(_repo: string): Promise<string | undefined> { return undefined; }
	async resumeSession(_sessionId: string): Promise<void> { /* no-op */ }
	async deleteSession(_sessionId: string): Promise<{ deleted: boolean; reason?: string }> { return { deleted: false, reason: 'sessions not yet wired' }; }
	async deleteSessionsBulk(_sessionIds: readonly string[]): Promise<{ deleted: number; failed: number }> { return { deleted: 0, failed: 0 }; }
	async cancelBrainstormSession(_reason: string, _opts?: { discardCheckpoint?: boolean }): Promise<void> { /* no-op */ }
	async resumeCodeAnalysis(_sessionId: string, _repo: string): Promise<void> { /* no-op */ }
	async resumeDataAnalysis(_sessionId: string, _repo: string): Promise<void> { /* no-op */ }
	async resumeFromCheckpoint(_sessionId: string, _repo: string): Promise<void> { /* no-op */ }

	// -------------------------------------------------------------------------
	// sendMessage -- the load-bearing entry point
	// -------------------------------------------------------------------------

	async sendMessage(message: string): Promise<void> {
		const trimmed = message.trim();
		if (trimmed.length === 0) {
			this.logService.debug('[insrc-chat] sendMessage: empty prompt -- ignoring');
			return;
		}
		if (this._activeHandle !== undefined) {
			this.logService.warn('[insrc-chat] sendMessage: a run is already in flight -- ignoring new prompt');
			this._onDidReceiveEvent.fire({
				type: 'streamError',
				message: 'A previous analyze run is still in progress. Wait for it to finish or cancel before starting a new one.',
			});
			return;
		}

		const scopePath = this._activeScopePath();
		if (scopePath === undefined) {
			this.logService.warn('[insrc-chat] sendMessage: no workspace folder open');
			this._onDidReceiveEvent.fire({
				type: 'streamError',
				message: 'No workspace folder is open. Open a folder + try again.',
			});
			return;
		}

		const runId = this._mintRunId();

		// Echo the user's prompt back as a message event so the chat
		// pane can render it immediately. The `repo` field gives
		// agentRunService something to scope by when registering the
		// analyze run in the Runs sidebar.
		this._onDidReceiveEvent.fire({
			type: 'userMessage',
			runId,
			content: trimmed,
			repo: scopePath,
		});

		// Kick off the streaming RPC. Persistence (run.json + per-task
		// outputs) happens daemon-side inside runAnalyze; the IDE just
		// observes the wire frames.
		const handle = this.daemonService.stream('analyze.run.start', {
			runId,
			userPrompt: trimmed,
			scopeRef: { kind: 'workspace', value: scopePath },
		});
		this._activeHandle = handle;

		const dispose = (): void => {
			this._activeHandle = undefined;
			handle.dispose();
		};

		this._register(handle.onMessage(msg => this._handleFrame(msg, runId)));
		this._register(handle.onDidEnd(() => {
			this._onDidReceiveEvent.fire({ type: 'streamEnd', runId });
			dispose();
		}));
		this._register(handle.onDidError(err => {
			this.logService.error('[insrc-chat] stream error', err.message);
			this._onDidReceiveEvent.fire({
				type: 'streamError',
				runId,
				message: err.message,
			});
			this._onDidReceiveEvent.fire({ type: 'streamEnd', runId });
			dispose();
		}));
	}

	// -------------------------------------------------------------------------
	// Frame dispatcher
	// -------------------------------------------------------------------------

	private _handleFrame(msg: DaemonStreamMessage, runId: string): void {
		switch (msg.type) {
			case 'progress':
				this._onDidReceiveEvent.fire({
					type: 'progress',
					runId,
					step: msg.step,
					status: msg.status,
					...(msg.taskId !== undefined ? { taskId: msg.taskId } : {}),
					...(msg.template !== undefined ? { template: msg.template } : {}),
					...(msg.index !== undefined ? { index: msg.index } : {}),
					...(msg.total !== undefined ? { total: msg.total } : {}),
					...(msg.parentTaskPath !== undefined ? { parentTaskPath: msg.parentTaskPath } : {}),
				});
				return;
			case 'analyze-result':
				this._onDidReceiveEvent.fire({
					type: 'analyze-result',
					runId,
					result: msg.result,
				});
				return;
			default:
				// Other frame types (delta / liveStep / gate / todos / ...)
				// are intentionally ignored by U1's chat service -- the
				// analyze pipeline doesn't emit them. Future stages (S4 token
				// streaming, U4 todos bridge) will pick them up here.
				return;
		}
	}

	// -------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------

	private _activeScopePath(): string | undefined {
		const workspace = this.workspaceService.getWorkspace();
		const folder = workspace.folders[0];
		return folder?.uri.fsPath;
	}

	private _mintRunId(): string {
		// Format: analyze-<timestamp>-<rand>. Avoid Date.now() vs Math.random()
		// readability issues by zero-padding the random suffix.
		const ts = Date.now().toString(36);
		const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
		return `analyze-${ts}-${rand}`;
	}

	override dispose(): void {
		this._activeHandle?.dispose();
		this._activeHandle = undefined;
		super.dispose();
	}
}
