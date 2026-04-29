/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IInsrcDaemonService, type IInsrcStreamHandle, type DaemonStreamMessage } from '../common/daemonService.js';
import { IInsrcChatService, type ChatMessage, type ChatEvent, type CodeAnnotation, type GateInfo, type ProgressInfo } from '../common/chatService.js';

const STORAGE_KEY_REPO = 'insrc.chat.activeRepo';
const STORAGE_KEY_SESSION = 'insrc.chat.activeSessionId';

// ---------------------------------------------------------------------------
// ChatService implementation
// ---------------------------------------------------------------------------

export class InsrcChatServiceImpl extends Disposable implements IInsrcChatService {
	declare readonly _serviceBrand: undefined;

	private _activeSessionId: string | undefined;
	private _activeRepo: string | undefined;
	private _isStreaming = false;
	private _messages: ChatMessage[] = [];
	private _streamHandle: IInsrcStreamHandle | undefined;

	// Accumulates streamed content for the current assistant message
	private _pendingContent = '';

	private readonly _onDidChangeSession = this._register(new Emitter<string | undefined>());
	readonly onDidChangeSession: Event<string | undefined> = this._onDidChangeSession.event;

	private readonly _onDidReceiveEvent = this._register(new Emitter<ChatEvent>());
	readonly onDidReceiveEvent: Event<ChatEvent> = this._onDidReceiveEvent.event;

	private readonly _onRequestCloseBrainstormPanes = this._register(new Emitter<void>());
	readonly onRequestCloseBrainstormPanes: Event<void> = this._onRequestCloseBrainstormPanes.event;

	private readonly _onDidRequireConfig = this._register(new Emitter<{ missing: 'local' | 'provider' | 'both' }>());
	readonly onDidRequireConfig: Event<{ missing: 'local' | 'provider' | 'both' }> = this._onDidRequireConfig.event;

	get activeSessionId(): string | undefined { return this._activeSessionId; }
	get activeRepo(): string | undefined { return this._activeRepo; }
	get isStreaming(): boolean { return this._isStreaming; }
	get messages(): readonly ChatMessage[] { return this._messages; }

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		// Restore persisted state
		this._activeRepo = this.storageService.get(STORAGE_KEY_REPO, StorageScope.WORKSPACE);
		this._activeSessionId = this.storageService.get(STORAGE_KEY_SESSION, StorageScope.WORKSPACE);
		if (this._activeRepo) {
			this.logService.info('[insrc-chat] Restored repo:', this._activeRepo, 'session:', this._activeSessionId);
		}

		// Re-establish session when daemon connects
		this._register(this.daemonService.onDidChangeState(state => {
			if (state === 'connected' && this._activeRepo) {
				this._reestablishSession();
			}
		}));
	}

	// ---------------------------------------------------------------------------
	// Session lifecycle
	// ---------------------------------------------------------------------------

	async startSession(repoPath: string): Promise<string> {
		if (!this.daemonService.isConnected) {
			throw new Error('Not connected to daemon');
		}

		type StartResult =
			| { sessionId: string; repo: string }
			| { code: 'NOT_CONFIGURED'; missing: 'local' | 'provider' | 'both'; message: string };
		const result = await this.daemonService.rpc<StartResult>('chat.start', { repo: repoPath });

		if ('code' in result) {
			// Fire an event so the workbench contribution can auto-open the
			// Model Providers pane, then throw so the caller sees a normal
			// rejected promise with the human-readable message.
			this._onDidRequireConfig.fire({ missing: result.missing });
			const err = new Error(result.message) as Error & {
				code: 'NOT_CONFIGURED';
				missing: 'local' | 'provider' | 'both';
			};
			err.code = 'NOT_CONFIGURED';
			err.missing = result.missing;
			throw err;
		}

		this._activeSessionId = result.sessionId;
		this._activeRepo = result.repo;
		this._messages = [];
		this._persistState();
		this._onDidChangeSession.fire(this._activeSessionId);
		this.logService.info('[insrc-chat] Started session:', result.sessionId);
		return result.sessionId;
	}

	async resumeSession(sessionId: string): Promise<void> {
		if (!this.daemonService.isConnected) {
			throw new Error('Not connected to daemon');
		}

		// Close current active session if any
		if (this._activeSessionId && this._activeSessionId !== sessionId) {
			try {
				await this.daemonService.rpc('chat.close', { sessionId: this._activeSessionId });
			} catch { /* ok */ }
		}

		// Restore session in daemon (re-activates persisted session with full context)
		type RestoreResult =
			| { error?: string; sessionId?: string; repo?: string }
			| { code: 'NOT_CONFIGURED'; missing: 'local' | 'provider' | 'both'; message: string };
		const result = await this.daemonService.rpc<RestoreResult>('chat.restore', { sessionId });

		if ('code' in result) {
			this._onDidRequireConfig.fire({ missing: result.missing });
			const err = new Error(result.message) as Error & {
				code: 'NOT_CONFIGURED';
				missing: 'local' | 'provider' | 'both';
			};
			err.code = 'NOT_CONFIGURED';
			err.missing = result.missing;
			throw err;
		}

		if (result.error || !result.sessionId) {
			// Restore failed -- fall back to fresh session
			this.logService.warn('[insrc-chat] chat.restore failed:', result.error);
			this._messages = await this.loadHistory(sessionId);

			let repo: string | undefined = this._activeRepo;
			if (!repo) {
				try {
					const sessions = await this.daemonService.rpc<Array<{ id: string; repo: string }>>('session.list', {});
					const match = sessions.find(s => s.id === sessionId);
					repo = match?.repo;
				} catch { /* ignore */ }
			}
			if (repo) {
				await this.startSession(repo);
			} else {
				this._activeSessionId = undefined;
				this._onDidChangeSession.fire(undefined);
			}
			return;
		}

		// Restore succeeded -- session is now active in daemon with same ID
		this._activeSessionId = result.sessionId;
		this._activeRepo = result.repo;
		this._messages = await this.loadHistory(sessionId);
		this._persistState();
		this._onDidChangeSession.fire(this._activeSessionId);
		this.logService.info('[insrc-chat] Restored session:', result.sessionId, 'repo:', result.repo);
	}

	async closeSession(): Promise<void> {
		if (this._activeSessionId) {
			try {
				await this.daemonService.rpc('chat.close', { sessionId: this._activeSessionId });
			} catch {
				// Session may already be closed
			}
		}

		this._disposeStream();
		this._activeSessionId = undefined;
		this._activeRepo = undefined;
		this._messages = [];
		this._isStreaming = false;
		this._persistState();
		// Item 22: synthesize streamEnd so in-flight UI chrome (progress
		// bar, inline progress messages) clears when the session ends.
		this._onDidReceiveEvent.fire({ type: 'streamEnd' });
		this._onDidChangeSession.fire(undefined);
	}

	private async _reestablishSession(): Promise<void> {
		if (!this._activeSessionId && !this._activeRepo) {
			return;
		}

		// Try to restore persisted session first
		if (this._activeSessionId) {
			type RestoreResult =
				| { error?: string; sessionId?: string; repo?: string }
				| { code: 'NOT_CONFIGURED'; missing: 'local' | 'provider' | 'both'; message: string };
			const result = await this.daemonService.rpc<RestoreResult>('chat.restore', { sessionId: this._activeSessionId });
			if ('code' in result) {
				this._onDidRequireConfig.fire({ missing: result.missing });
				this.logService.warn('[insrc-chat] Cannot restore session: NOT_CONFIGURED');
				return;
			}
			if (!result.error && result.sessionId) {
				this._activeRepo = result.repo;
				// Load persisted turns before firing the event so the view
				// renders the conversation in its initial pass. Previously
				// we only fired onDidChangeSession, leaving the view blank
				// until the user typed a new message.
				this._messages = await this.loadHistory(result.sessionId);
				this.logService.info(
					'[insrc-chat] Re-established session via restore:',
					result.sessionId,
					`(${this._messages.length} messages)`,
				);
				this._onDidChangeSession.fire(this._activeSessionId);
				return;
			}
			this.logService.info('[insrc-chat] Persisted session could not be restored:', result.error);
		}

		// Fall back to fresh session
		if (this._activeRepo) {
			try {
				await this.startSession(this._activeRepo);
				this.logService.info('[insrc-chat] Started fresh session:', this._activeSessionId);
			} catch (err) {
				this.logService.warn('[insrc-chat] Failed to start session:', (err as Error).message);
			}
		}
	}

	private _persistState(): void {
		if (this._activeRepo) {
			this.storageService.store(STORAGE_KEY_REPO, this._activeRepo, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(STORAGE_KEY_REPO, StorageScope.WORKSPACE);
		}
		if (this._activeSessionId) {
			this.storageService.store(STORAGE_KEY_SESSION, this._activeSessionId, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(STORAGE_KEY_SESSION, StorageScope.WORKSPACE);
		}
	}

	// ---------------------------------------------------------------------------
	// Messaging
	// ---------------------------------------------------------------------------

	async resumeFromCheckpoint(sessionId: string, repoPath: string): Promise<void> {
		if (!this.daemonService.isConnected) {
			throw new Error('Not connected to daemon');
		}
		if (this._isStreaming) {
			throw new Error('Already streaming');
		}

		// plans/session-lifecycle.md Phase 3: the daemon's
		// chatResumeFromCheckpoint reads the session row from the DB for
		// all metadata, so the browser doesn't need to pass a repoPath
		// hint or fall back to _activeRepo. Keep repoPath in our local
		// state just so the chat panel's repo indicator stays correct
		// during the resumed stream.
		this._activeSessionId = sessionId;
		this._activeRepo = repoPath || this._activeRepo;
		this._messages = await this.loadHistory(sessionId);
		this._persistState();
		this._onDidChangeSession.fire(sessionId);

		this._isStreaming = true;
		this._pendingContent = '';

		this._streamHandle = this.daemonService.stream('chat.resumeFromCheckpoint', { sessionId });
		this._wireStreamHandle(this._streamHandle);
	}

	async resumeCodeAnalysis(sessionId: string, repoPath: string): Promise<void> {
		// Code-analyzer-specific resume. Identical scaffolding to
		// `resumeFromCheckpoint` except the IPC method name; the
		// daemon's chat.resumeCodeAnalysis hydrates the
		// CodeAnalyzerOrchestratorController instead of the
		// brainstorm subclass.
		if (!this.daemonService.isConnected) {
			throw new Error('Not connected to daemon');
		}
		if (this._isStreaming) {
			throw new Error('Already streaming');
		}
		this._activeSessionId = sessionId;
		this._activeRepo = repoPath || this._activeRepo;
		this._messages = await this.loadHistory(sessionId);
		this._persistState();
		this._onDidChangeSession.fire(sessionId);

		this._isStreaming = true;
		this._pendingContent = '';

		this._streamHandle = this.daemonService.stream('chat.resumeCodeAnalysis', { sessionId });
		this._wireStreamHandle(this._streamHandle);
	}

	async sendMessage(message: string, provider?: string, parentListId?: string, rerunFromListId?: string): Promise<void> {
		if (!this._activeSessionId) {
			// Auto-start a session with the first available repo
			if (!this._activeRepo) {
				throw new Error('No active session and no repo selected');
			}
			await this.startSession(this._activeRepo);
		}
		if (this._isStreaming) {
			throw new Error('Already streaming');
		}

		// Parse @mention provider override
		let actualMessage = message;
		let actualProvider = provider;
		const mentionMatch = message.match(/^@(local|openai|anthropic|gemini|mistral|sticky|clear)\s+/);
		if (mentionMatch) {
			actualProvider = mentionMatch[1];
			actualMessage = message.substring(mentionMatch[0].length);
		}

		// Add user message
		const userMsg: ChatMessage = {
			role: 'user',
			content: actualMessage,
			timestamp: new Date().toISOString(),
			provider: actualProvider,
		};
		this._messages.push(userMsg);
		this._onDidReceiveEvent.fire({ type: 'message', message: userMsg });

		// Start streaming
		this._isStreaming = true;
		this._pendingContent = '';

		const params: Record<string, unknown> = {
			sessionId: this._activeSessionId,
			message: actualMessage,
		};
		if (actualProvider) {
			params['provider'] = actualProvider;
		}
		// Code Analyzer drill-down (Phase 5.D): the daemon's chat.send
		// reads `parentListId` and threads it through to the
		// CodeAnalyzerOrchestrator so the new TodoList records its
		// parent. Only set when the caller is the drillDown command;
		// regular chat sends leave it absent.
		if (parentListId) {
			params['parentListId'] = parentListId;
		}
		// Code Analyzer re-run (Phase 4.1): when set, the daemon
		// skips the plan LLM call and reconstructs the task list
		// from the prior list's items. Set only by the
		// `insrc.codeAnalyzer.rerun` command path.
		if (rerunFromListId) {
			params['rerunFromListId'] = rerunFromListId;
		}

		this._streamHandle = this.daemonService.stream('chat.send', params);
		this._wireStreamHandle(this._streamHandle);
	}

	async replyToGate(gateId: string, action: string, feedback?: string): Promise<void> {
		if (!this._activeSessionId) {
			throw new Error('No active session');
		}

		await this.daemonService.rpc('chat.reply', {
			sessionId: this._activeSessionId,
			gateId,
			action,
			feedback,
		});

		// After gate reply, the daemon may resume streaming
		// The stream handle should still be active if the agent continues
		this.logService.info('[insrc-chat] Gate reply:', gateId, action);
	}

	async cancelStream(): Promise<void> {
		if (!this._activeSessionId) {
			return;
		}

		try {
			await this.daemonService.rpc('chat.cancel', { sessionId: this._activeSessionId });
		} catch {
			// ignore
		}

		this._finishStream();
		// Item 22: emit a synthetic streamEnd so listeners (chat panel,
		// progress indicator) clear their in-flight state. The daemon
		// won't emit streamEnd after an abort, so without this the
		// chat panel's progress bar gets stuck on the last step.
		this._onDidReceiveEvent.fire({ type: 'streamEnd' });
	}

	async cancelBrainstormSession(
		reason: string,
		opts?: { discardCheckpoint?: boolean },
	): Promise<void> {
		// Unified teardown (Item 25). Called from three UI entry points:
		//   1. The brainstorm pane's close handler (after its own confirm).
		//   2. The chat panel's Stop button (after a dialog-service confirm).
		//   3. Stream-error paths (inactivity timeout, connection lost).
		// The first two pass `discardCheckpoint: true` (decision F1 --
		// user explicitly ended the session, checkpoint should go).
		// Stream errors default to `false` so the user can still recover
		// the session via the Runs sidebar.
		this.logService.info(`[insrc-chat] cancelBrainstormSession reason=${reason} discardCheckpoint=${opts?.discardCheckpoint === true}`);

		const sessionId = this._activeSessionId;
		if (sessionId) {
			try {
				await this.daemonService.rpc('chat.cancel', { sessionId });
			} catch {
				// Session may already be cancelled -- harmless race.
			}
			try {
				await this.daemonService.rpc('chat.close', { sessionId });
			} catch {
				// Session may already be closed -- harmless race.
			}
			if (opts?.discardCheckpoint === true) {
				try {
					await this.daemonService.rpc('agent.discard', { id: sessionId });
				} catch {
					// No checkpoint for this session is fine -- not every
					// brainstorm progresses far enough to checkpoint.
				}
			}
		}

		this._disposeStream();
		this._activeSessionId = undefined;
		// Keep _activeRepo across stream-errors so the user can start a
		// fresh session in the same repo without re-picking it. Only
		// clear it when the user explicitly ends the session (pane close
		// / cancel button), which passes discardCheckpoint=true.
		if (opts?.discardCheckpoint === true) {
			this._activeRepo = undefined;
		}
		this._messages = [];
		this._isStreaming = false;
		this._persistState();

		// Progress bar reset + session-ended signal.
		this._onDidReceiveEvent.fire({ type: 'streamEnd' });
		// Fire session-change FIRST so listeners (notably the brainstorm
		// session service) flip `isSessionActive` off before the flow
		// contribution closes the panes -- otherwise the pane's
		// closeHandler.showConfirm() still sees an active session and
		// pops its "Close brainstorm and end the session?" dialog on a
		// teardown that's already in progress.
		this._onDidChangeSession.fire(undefined);
		// Ask the flow contribution to close every open brainstorm editor.
		this._onRequestCloseBrainstormPanes.fire();
	}

	closeBrainstormPanes(): void {
		this._onRequestCloseBrainstormPanes.fire();
	}

	async redirect(intent: string, refinedMessage?: string): Promise<void> {
		if (!this._activeSessionId) {
			throw new Error('No active session to redirect');
		}
		const sessionId = this._activeSessionId;

		const result = await this.daemonService.rpc<{
			ok?: boolean;
			error?: string;
			suggestedMessage?: string;
		}>('chat.redirect', {
			sessionId,
			intent,
			...(refinedMessage ? { refinedMessage } : {}),
		});

		if (!result || result.ok === false || result.error) {
			throw new Error(result?.error ?? 'redirect rejected by daemon');
		}

		// Daemon aborted the prior stream; wait for the current stream handle
		// to finish so the new sendMessage doesn't race.
		this._finishStream();

		const suggested = result.suggestedMessage ?? `/${intent}${refinedMessage ? ' ' + refinedMessage : ''}`;
		this.logService.info(`[insrc-chat] redirect -> resending with "${suggested.slice(0, 80)}"`);
		await this.sendMessage(suggested);
	}

	// ---------------------------------------------------------------------------
	// History
	// ---------------------------------------------------------------------------

	async loadHistory(sessionId: string): Promise<ChatMessage[]> {
		if (!this.daemonService.isConnected) {
			return [];
		}

		try {
			const turns = await this.daemonService.rpc<Array<{ user: string; assistant: string; createdAt?: string }>>('session.history', { sessionId, limit: 50 });
			const messages: ChatMessage[] = [];
			for (const turn of turns ?? []) {
				if (turn.user) {
					messages.push({ role: 'user', content: turn.user, timestamp: turn.createdAt ?? '' });
				}
				if (turn.assistant) {
					messages.push({ role: 'assistant', content: turn.assistant, timestamp: turn.createdAt ?? '' });
				}
			}
			return messages;
		} catch (err) {
			this.logService.warn('[insrc-chat] Failed to load history:', (err as Error).message);
			return [];
		}
	}

	// ---------------------------------------------------------------------------
	// Annotations
	// ---------------------------------------------------------------------------

	async sendAnnotations(annotations: readonly CodeAnnotation[]): Promise<void> {
		if (annotations.length === 0) {
			return;
		}

		// Group by file
		const byFile = new Map<string, CodeAnnotation[]>();
		for (const a of annotations) {
			if (!byFile.has(a.file)) {
				byFile.set(a.file, []);
			}
			byFile.get(a.file)!.push(a);
		}

		// Build message with file references (daemon reads file content)
		const lines: string[] = [];
		lines.push(`I have ${annotations.length} annotation(s) across ${byFile.size} file(s):\n`);
		for (const [file, items] of byFile) {
			// Include file as a quoted path for daemon file-ref resolution
			lines.push(`"${file}"`);
			for (const item of items) {
				lines.push(`- Line ${item.line}: ${item.note}`);
			}
			lines.push('');
		}

		await this.sendMessage(lines.join('\n'));
	}

	// ---------------------------------------------------------------------------
	// Stream handling
	// ---------------------------------------------------------------------------

	private _wireStreamHandle(handle: IInsrcStreamHandle): void {
		handle.onMessage((msg: DaemonStreamMessage) => {
			this._handleStreamMessage(msg);
		});

		handle.onDidEnd(() => {
			this._flushPendingContent();
			this._finishStream();
			this._onDidReceiveEvent.fire({ type: 'streamEnd' });
		});

		handle.onDidError((err: Error) => {
			this._flushPendingContent();
			// A stream error (inactivity timeout / connection lost / daemon-side
			// error) means the session is effectively dead. Run the same full
			// teardown as the cancel button + pane-close (cancelBrainstormSession
			// does chat.cancel + chat.close + clears session state), but skip the
			// confirm dialog -- there's nothing for the user to confirm, the
			// session is already gone. Fire the error event first so the error
			// message renders inline in the transcript before streamEnd clears
			// the progress bar.
			this._onDidReceiveEvent.fire({ type: 'error', error: err.message });
			void this.cancelBrainstormSession(`stream-error:${err.message}`);
		});
	}

	private _handleStreamMessage(msg: DaemonStreamMessage): void {
		switch (msg.type) {
			case 'delta': {
				this._pendingContent += msg.content;
				// Fire partial message event for live rendering
				this._onDidReceiveEvent.fire({
					type: 'message',
					message: { role: 'assistant', content: this._pendingContent, timestamp: new Date().toISOString() },
				});
				break;
			}
			case 'gate': {
				// Flush any pending content before showing gate
				this._flushPendingContent();
				const gate: GateInfo = {
					gateId: msg.gateId,
					actions: msg.actions,
					...(msg.actionDetails ? { actionDetails: msg.actionDetails } : {}),
					title: msg.title,
					content: msg.content,
					context: msg.structured,
				};
				this._onDidReceiveEvent.fire({ type: 'gate', gate });
				break;
			}
			case 'progress': {
				const progress: ProgressInfo = { step: msg.step, status: msg.status };
				this._onDidReceiveEvent.fire({ type: 'progress', progress });
				break;
			}
			case 'liveStep': {
				// Item 32b: forward the token chunk to any listener (chat
				// panel renders a transient bubble keyed by agent+step).
				this._onDidReceiveEvent.fire({
					type: 'liveStep',
					liveStep: {
						agent: msg.agent,
						step: msg.step,
						text: msg.text,
						...(msg.done === true ? { done: true } : {}),
					},
				});
				break;
			}
			case 'context.set':
			case 'context.clear':
			case 'checkpoint':
				// Internal events, not shown in chat
				break;
		}
	}

	private _flushPendingContent(): void {
		if (this._pendingContent) {
			const assistantMsg: ChatMessage = {
				role: 'assistant',
				content: this._pendingContent,
				timestamp: new Date().toISOString(),
			};
			this._messages.push(assistantMsg);
			this._pendingContent = '';
		}
	}

	private _finishStream(): void {
		this._isStreaming = false;
		this._disposeStream();
	}

	private _disposeStream(): void {
		if (this._streamHandle) {
			this._streamHandle.dispose();
			this._streamHandle = undefined;
		}
	}

	// ---------------------------------------------------------------------------
	// Dispose
	// ---------------------------------------------------------------------------

	override dispose(): void {
		this._disposeStream();
		super.dispose();
	}
}
