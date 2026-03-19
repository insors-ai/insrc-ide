/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IInsrcDaemonService, type IInsrcStreamHandle } from '../common/daemonService.js';
import {
	IInsrcSessionService,
	type SessionChangeEvent,
	type SessionCheckpoint,
	type SessionDeltaEvent,
	type SessionGateEvent,
	type SessionProgressEvent,
} from '../common/sessionService.js';

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const STORAGE_KEY_PREFIX = 'insrc.session.';
const STORAGE_INDEX_KEY = 'insrc.sessions.index';

// ---------------------------------------------------------------------------
// Per-session bookkeeping
// ---------------------------------------------------------------------------

interface ActiveSession {
	repoPath: string;
	state: unknown;
	streamHandle: IInsrcStreamHandle | undefined;
	streamDisposables: DisposableStore;
}

// ---------------------------------------------------------------------------
// SessionService implementation
// ---------------------------------------------------------------------------

export class InsrcSessionServiceImpl extends Disposable implements IInsrcSessionService {
	declare readonly _serviceBrand: undefined;

	private readonly _sessions = new Map<string, ActiveSession>();

	private readonly _onDidChangeSession = this._register(new Emitter<SessionChangeEvent>());
	readonly onDidChangeSession: Event<SessionChangeEvent> = this._onDidChangeSession.event;

	private readonly _onDidReceiveDelta = this._register(new Emitter<SessionDeltaEvent>());
	readonly onDidReceiveDelta: Event<SessionDeltaEvent> = this._onDidReceiveDelta.event;

	private readonly _onDidReceiveGate = this._register(new Emitter<SessionGateEvent>());
	readonly onDidReceiveGate: Event<SessionGateEvent> = this._onDidReceiveGate.event;

	private readonly _onDidProgress = this._register(new Emitter<SessionProgressEvent>());
	readonly onDidProgress: Event<SessionProgressEvent> = this._onDidProgress.event;

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
	}

	// ---------------------------------------------------------------------------
	// Session lifecycle
	// ---------------------------------------------------------------------------

	async createSession(repoPath: string, message: string): Promise<string> {
		const result = await this.daemonService.rpc<{ sessionId: string }>('chat.start', { repo: repoPath });
		const sessionId = result.sessionId;

		const session = this._createActiveSession(sessionId, repoPath);
		this._attachStream(sessionId, session, { message });

		this._onDidChangeSession.fire({ sessionId, type: 'created' });
		this.logService.info(`[insrc] Session created: ${sessionId} for ${repoPath}`);

		this._addToIndex(sessionId, repoPath);
		return sessionId;
	}

	async resumeSession(sessionId: string): Promise<void> {
		const raw = this.storageService.get(
			STORAGE_KEY_PREFIX + sessionId,
			StorageScope.WORKSPACE,
		);

		if (!raw) {
			throw new Error(`No checkpoint found for session ${sessionId}`);
		}

		let checkpoint: SessionCheckpoint;
		try {
			checkpoint = JSON.parse(raw) as SessionCheckpoint;
		} catch {
			throw new Error(`Invalid checkpoint data for session ${sessionId}`);
		}

		const session = this._createActiveSession(sessionId, checkpoint.repoPath);
		session.state = checkpoint;

		this._attachStream(sessionId, session, { resume: true });

		this._onDidChangeSession.fire({ sessionId, type: 'updated' });
		this.logService.info(`[insrc] Session resumed: ${sessionId}`);
	}

	closeSession(sessionId: string): void {
		const session = this._sessions.get(sessionId);
		if (!session) {
			return;
		}

		session.streamDisposables.dispose();
		this._sessions.delete(sessionId);

		this._onDidChangeSession.fire({ sessionId, type: 'closed' });
		this.logService.info(`[insrc] Session closed: ${sessionId}`);
	}

	// ---------------------------------------------------------------------------
	// State access
	// ---------------------------------------------------------------------------

	getSessionState(sessionId: string): unknown | undefined {
		return this._sessions.get(sessionId)?.state;
	}

	// ---------------------------------------------------------------------------
	// Persistence
	// ---------------------------------------------------------------------------

	async saveCheckpoint(sessionId: string): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (!session) {
			return;
		}

		try {
			const status = await this.daemonService.rpc<Record<string, unknown>>('chat.status', { sessionId });
			session.state = status;

			const checkpoint: SessionCheckpoint = {
				sessionId,
				repoPath: session.repoPath,
				createdAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				ideaCount: 0,
				round: 0,
			};

			this.storageService.store(
				STORAGE_KEY_PREFIX + sessionId,
				JSON.stringify(checkpoint),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE,
			);

			this._onDidChangeSession.fire({ sessionId, type: 'updated' });
			this.logService.debug(`[insrc] Checkpoint saved: ${sessionId}`);
		} catch (err) {
			this.logService.warn(`[insrc] Failed to save checkpoint: ${sessionId}`, err);
		}
	}

	async listCheckpoints(repoPath: string): Promise<SessionCheckpoint[]> {
		const index = this._loadIndex();
		const checkpoints: SessionCheckpoint[] = [];

		for (const entry of index) {
			if (entry.repoPath !== repoPath) {
				continue;
			}

			const raw = this.storageService.get(
				STORAGE_KEY_PREFIX + entry.sessionId,
				StorageScope.WORKSPACE,
			);

			if (raw) {
				try {
					checkpoints.push(JSON.parse(raw) as SessionCheckpoint);
				} catch {
					// Corrupted entry, skip
				}
			}
		}

		return checkpoints.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
	}

	// ---------------------------------------------------------------------------
	// Stream subscription
	// ---------------------------------------------------------------------------

	private _createActiveSession(sessionId: string, repoPath: string): ActiveSession {
		// Close existing session with same id if any
		this.closeSession(sessionId);

		const session: ActiveSession = {
			repoPath,
			state: null,
			streamHandle: undefined,
			streamDisposables: new DisposableStore(),
		};

		this._sessions.set(sessionId, session);
		return session;
	}

	private _attachStream(sessionId: string, session: ActiveSession, params: Record<string, unknown>): void {
		const handle = this.daemonService.stream('chat.stream', { sessionId, ...params });
		session.streamHandle = handle;
		session.streamDisposables.add(handle);

		session.streamDisposables.add(handle.onMessage((msg) => {
			session.state = msg; // Keep latest message as state snapshot

			switch (msg.type) {
				case 'delta':
					this._onDidReceiveDelta.fire({ sessionId, content: msg.content });
					break;
				case 'gate':
					this._onDidReceiveGate.fire({ sessionId, gateId: msg.gateId, actions: msg.actions });
					break;
				case 'progress':
					this._onDidProgress.fire({ sessionId, step: msg.step, status: msg.status });
					break;
			}

			this._onDidChangeSession.fire({ sessionId, type: 'updated' });
		}));

		session.streamDisposables.add(handle.onDidEnd(() => {
			this.logService.info(`[insrc] Stream ended for session ${sessionId}`);
		}));

		session.streamDisposables.add(handle.onDidError((err) => {
			this.logService.warn(`[insrc] Stream error for session ${sessionId}:`, err.message);
		}));
	}

	// ---------------------------------------------------------------------------
	// Index management
	// ---------------------------------------------------------------------------

	private _addToIndex(sessionId: string, repoPath: string): void {
		const index = this._loadIndex();
		index.push({ sessionId, repoPath });
		this.storageService.store(
			STORAGE_INDEX_KEY,
			JSON.stringify(index),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
	}

	private _loadIndex(): Array<{ sessionId: string; repoPath: string }> {
		const raw = this.storageService.get(STORAGE_INDEX_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return [];
		}
		try {
			return JSON.parse(raw) as Array<{ sessionId: string; repoPath: string }>;
		} catch {
			return [];
		}
	}

	// ---------------------------------------------------------------------------
	// Dispose
	// ---------------------------------------------------------------------------

	override dispose(): void {
		for (const [, session] of this._sessions) {
			session.streamDisposables.dispose();
		}
		this._sessions.clear();
		super.dispose();
	}
}
