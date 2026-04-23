/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IInsrcDaemonService, type DaemonStreamMessage, type IInsrcStreamHandle } from '../../common/daemonService.js';
import { IInsrcChatService } from '../../common/chatService.js';
import {
	IInsrcTodosService,
	type TodoList,
	type TodoStreamEventKind,
} from '../../common/todosService.js';

/**
 * Browser-side impl of {@link IInsrcTodosService}. Holds one subscription
 * to the daemon's `todos.subscribe` stream for the lifetime of the IDE
 * and refreshes the session-scoped cache on every chat session change.
 *
 * Reconnects the daemon stream automatically on disconnect + error; if
 * the stream goes silent we lose ordering of missed events but the
 * follow-up session-scope refresh papers over it.
 *
 * Ownership enforcement lives in the daemon; this layer never tries
 * to mutate anything -- the interface exposes no write methods.
 */
export class InsrcTodosServiceImpl extends Disposable implements IInsrcTodosService {
	declare readonly _serviceBrand: undefined;

	// Cache keyed to the currently-active chat session. Changes to a
	// different session reset the cache completely.
	private _sessionId: string | undefined;
	private _listsById = new Map<string, TodoList>();

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _onDidChangeList = this._register(new Emitter<TodoList>());
	readonly onDidChangeList: Event<TodoList> = this._onDidChangeList.event;

	private readonly _onDidRemoveList = this._register(new Emitter<string>());
	readonly onDidRemoveList: Event<string> = this._onDidRemoveList.event;

	private _streamHandle: IInsrcStreamHandle | undefined;
	private _streamListeners: IDisposable[] = [];
	private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@IInsrcChatService chatService: IInsrcChatService,
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._sessionId = chatService.activeSessionId;
		this.logService.info(`[insrc-todos] init sessionId=${this._sessionId ?? '(none)'}`);

		this._register(chatService.onDidChangeSession(id => this._onSessionChange(id)));

		// Rebuild the subscription whenever the daemon connection flips.
		// An initial connected snapshot seeds the stream immediately if
		// the daemon was already up when this service was constructed.
		this._register(daemonService.onDidChangeState(state => {
			if (state === 'connected') {
				this._openStream();
				void this._refreshForActiveSession();
			} else {
				this._closeStream();
			}
		}));
		if (daemonService.isConnected) {
			this._openStream();
			void this._refreshForActiveSession();
		}
	}

	get lists(): readonly TodoList[] {
		// Preserve insertion order (roots first by createdAt is the
		// daemon's ordering; we preserve whatever arrived).
		return Array.from(this._listsById.values());
	}

	async listsForSession(
		sessionId: string,
		opts: { includeArchived?: boolean } = {},
	): Promise<readonly TodoList[]> {
		try {
			const params: Record<string, unknown> = { sessionId };
			if (opts.includeArchived !== undefined) {
				params['includeArchived'] = opts.includeArchived;
			}
			const result = await this.daemonService.rpc<readonly TodoList[]>(
				'todos.listForSession', params,
			);
			return Array.isArray(result) ? result : [];
		} catch (err) {
			this.logService.warn(`[insrc-todos] listsForSession(${sessionId}) failed: ${(err as Error).message}`);
			return [];
		}
	}

	override dispose(): void {
		this._closeStream();
		super.dispose();
	}

	// -- Internal ------------------------------------------------------------

	private _onSessionChange(id: string | undefined): void {
		if (this._sessionId === id) {
			return;
		}
		this.logService.info(`[insrc-todos] session change ${this._sessionId ?? '(none)'} -> ${id ?? '(none)'}`);
		this._sessionId = id;
		this._listsById.clear();
		this._onDidChange.fire();
		void this._refreshForActiveSession();
	}

	private async _refreshForActiveSession(): Promise<void> {
		const sessionId = this._sessionId;
		if (sessionId === undefined) {
			return;
		}
		try {
			const lists = await this.daemonService.rpc<readonly TodoList[]>(
				'todos.listForSession', { sessionId, includeArchived: true },
			);
			if (this._sessionId !== sessionId) {
				return;  // session flipped again mid-await
			}
			this._listsById.clear();
			if (Array.isArray(lists)) {
				for (const list of lists) {
					this._listsById.set(list.id, list);
				}
			}
			this._onDidChange.fire();
		} catch (err) {
			this.logService.warn(`[insrc-todos] refresh failed for ${sessionId}: ${(err as Error).message}`);
		}
	}

	private _openStream(): void {
		if (this._streamHandle !== undefined) {
			return;
		}
		try {
			const handle = this.daemonService.stream('todos.subscribe', {});
			this._streamHandle = handle;
			this._streamListeners.push(
				handle.onMessage(msg => this._handleStreamMessage(msg)),
				handle.onDidEnd(() => this._onStreamEnded(undefined)),
				handle.onDidError(err => this._onStreamEnded(err)),
			);
			this.logService.info('[insrc-todos] subscribed to todos.subscribe');
		} catch (err) {
			this.logService.warn(`[insrc-todos] subscribe failed: ${(err as Error).message}`);
			this._scheduleReconnect();
		}
	}

	private _closeStream(): void {
		if (this._streamHandle !== undefined) {
			try { this._streamHandle.dispose(); } catch { /* already disposed */ }
			this._streamHandle = undefined;
		}
		for (const d of this._streamListeners) {
			try { d.dispose(); } catch { /* ignore */ }
		}
		this._streamListeners = [];
		if (this._reconnectTimer !== undefined) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = undefined;
		}
	}

	private _onStreamEnded(err: Error | undefined): void {
		this.logService.info(
			`[insrc-todos] stream ended${err ? `: ${err.message}` : ''}; scheduling reconnect`,
		);
		// Drop listeners but keep cache -- refresh on reconnect.
		for (const d of this._streamListeners) {
			try { d.dispose(); } catch { /* ignore */ }
		}
		this._streamListeners = [];
		this._streamHandle = undefined;
		if (this.daemonService.isConnected) {
			this._scheduleReconnect();
		}
	}

	private _scheduleReconnect(): void {
		if (this._reconnectTimer !== undefined) {
			return;
		}
		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = undefined;
			if (this.daemonService.isConnected) {
				this._openStream();
			}
		}, 2000);
	}

	private _handleStreamMessage(msg: DaemonStreamMessage): void {
		if (msg.type !== 'todos') {
			return;
		}
		const list = this._coerceList(msg.list);
		if (list === undefined) {
			return;
		}

		// Scope events to the active session. Other sessions' mutations
		// shouldn't pollute this cache; the sidebar / cross-session
		// views use `listsForSession` on-demand instead.
		if (list.sessionId !== this._sessionId) {
			return;
		}

		this._applyEvent(msg.kind, list);
	}

	private _applyEvent(kind: TodoStreamEventKind, list: TodoList): void {
		switch (kind) {
			case 'listCreated':
			case 'listUpdated':
			case 'listArchived':
			case 'itemCreated':
			case 'itemUpdated':
			case 'itemRemoved':
			case 'commentAdded':
			case 'commentUpdated':
			case 'commentRemoved':
				this._listsById.set(list.id, list);
				this._onDidChangeList.fire(list);
				this._onDidChange.fire();
				return;

			case 'listDeleted':
				if (this._listsById.delete(list.id)) {
					this._onDidRemoveList.fire(list.id);
					this._onDidChange.fire();
				}
				return;
		}
	}

	/**
	 * Defensive coerce -- the stream wire format types `list` as
	 * `unknown`, so we validate the minimal shape (id + sessionId)
	 * before accepting it into the cache.
	 */
	private _coerceList(raw: unknown): TodoList | undefined {
		if (raw === null || typeof raw !== 'object') {
			return undefined;
		}
		const r = raw as Record<string, unknown>;
		if (typeof r['id'] !== 'string' || typeof r['sessionId'] !== 'string') {
			return undefined;
		}
		return raw as TodoList;
	}
}
