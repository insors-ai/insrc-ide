/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IInsrcDaemonService } from '../common/daemonService.js';
import { IInsrcSessionService, type SessionChangeEvent, type SessionCheckpoint } from '../common/sessionService.js';

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const STORAGE_KEY_PREFIX = 'insrc.session.';
const STORAGE_INDEX_KEY = 'insrc.sessions.index';

// ---------------------------------------------------------------------------
// SessionService implementation
// ---------------------------------------------------------------------------

export class InsrcSessionServiceImpl extends Disposable implements IInsrcSessionService {
	declare readonly _serviceBrand: undefined;

	private readonly _sessions = new Map<string, { repoPath: string; state: unknown }>();

	private readonly _onDidChangeSession = this._register(new Emitter<SessionChangeEvent>());
	readonly onDidChangeSession: Event<SessionChangeEvent> = this._onDidChangeSession.event;

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
		// Create session on the daemon
		const result = await this.daemonService.rpc<{ sessionId: string }>('chat.start', { repo: repoPath });
		const sessionId = result.sessionId;

		this._sessions.set(sessionId, { repoPath, state: null });
		this._onDidChangeSession.fire({ sessionId, type: 'created' });

		this.logService.info(`[insrc] Session created: ${sessionId} for ${repoPath}`);

		// Save to index
		this._addToIndex(sessionId, repoPath);

		return sessionId;
	}

	async resumeSession(sessionId: string): Promise<void> {
		// Load checkpoint from storage
		const raw = this.storageService.get(
			STORAGE_KEY_PREFIX + sessionId,
			StorageScope.WORKSPACE,
		);

		if (!raw) {
			throw new Error(`No checkpoint found for session ${sessionId}`);
		}

		try {
			const checkpoint = JSON.parse(raw) as SessionCheckpoint;
			this._sessions.set(sessionId, {
				repoPath: checkpoint.repoPath,
				state: checkpoint,
			});
			this._onDidChangeSession.fire({ sessionId, type: 'updated' });
			this.logService.info(`[insrc] Session resumed: ${sessionId}`);
		} catch {
			throw new Error(`Invalid checkpoint data for session ${sessionId}`);
		}
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

		// Fetch current state from daemon
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
	// Index management (tracks which sessions exist for which repos)
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
}
