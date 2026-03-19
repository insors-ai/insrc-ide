/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IInsrcDaemonService, type IInsrcStreamHandle, type DaemonStreamMessage } from '../common/daemonService.js';
import { IInsrcChatService, type ChatMessage, type ChatEvent, type CodeAnnotation, type GateInfo, type ProgressInfo, type ToolCallInfo, type EscalationInfo } from '../common/chatService.js';

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

	get activeSessionId(): string | undefined { return this._activeSessionId; }
	get activeRepo(): string | undefined { return this._activeRepo; }
	get isStreaming(): boolean { return this._isStreaming; }
	get messages(): readonly ChatMessage[] { return this._messages; }

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	// ---------------------------------------------------------------------------
	// Session lifecycle
	// ---------------------------------------------------------------------------

	async startSession(repoPath: string): Promise<string> {
		if (!this.daemonService.isConnected) {
			throw new Error('Not connected to daemon');
		}

		const result = await this.daemonService.rpc<{ sessionId: string; repo: string }>('chat.start', { repo: repoPath });
		this._activeSessionId = result.sessionId;
		this._activeRepo = result.repo;
		this._messages = [];
		this._onDidChangeSession.fire(this._activeSessionId);
		this.logService.info('[insrc-chat] Started session:', result.sessionId);
		return result.sessionId;
	}

	async resumeSession(sessionId: string): Promise<void> {
		if (!this.daemonService.isConnected) {
			throw new Error('Not connected to daemon');
		}

		// Load history first
		this._messages = await this.loadHistory(sessionId);
		this._activeSessionId = sessionId;

		// Get session info for repo
		const status = await this.daemonService.rpc<{ repo?: string }>('chat.status', { sessionId });
		this._activeRepo = status.repo;

		this._onDidChangeSession.fire(this._activeSessionId);
		this.logService.info('[insrc-chat] Resumed session:', sessionId);
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
		this._onDidChangeSession.fire(undefined);
	}

	// ---------------------------------------------------------------------------
	// Messaging
	// ---------------------------------------------------------------------------

	async sendMessage(message: string, provider?: string): Promise<void> {
		if (!this._activeSessionId) {
			throw new Error('No active session');
		}
		if (this._isStreaming) {
			throw new Error('Already streaming');
		}

		// Parse @mention provider override
		let actualMessage = message;
		let actualProvider = provider;
		const mentionMatch = message.match(/^@(local|haiku|sonnet|opus|sticky|clear)\s+/);
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

		// Build formatted message
		const lines: string[] = [];
		lines.push(`I have ${annotations.length} annotation(s) across ${byFile.size} file(s):\n`);
		for (const [file, items] of byFile) {
			lines.push(`**${file}:**`);
			for (const item of items) {
				lines.push(`- Line ${item.line}: "${item.note}"`);
				if (item.text) {
					lines.push('  ```');
					lines.push('  ' + item.text.substring(0, 200));
					lines.push('  ```');
				}
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
			this._finishStream();
			this._onDidReceiveEvent.fire({ type: 'error', error: err.message });
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
					title: msg.title,
					content: msg.content,
				};
				this._onDidReceiveEvent.fire({ type: 'gate', gate });
				break;
			}
			case 'progress': {
				const progress: ProgressInfo = { step: msg.step, status: msg.status };
				this._onDidReceiveEvent.fire({ type: 'progress', progress });
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
