/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IInsrcDaemonService } from '../common/daemonService.js';
import { IInsrcRepoService, type RepoInfo } from '../common/repoService.js';
import { IInsrcWorkspaceService } from '../common/workspaceService.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// RepoServiceImpl
// ---------------------------------------------------------------------------

export class InsrcRepoServiceImpl extends Disposable implements IInsrcRepoService {
	declare readonly _serviceBrand: undefined;

	private _repos: RepoInfo[] = [];

	private readonly _onDidChangeRepos = this._register(new Emitter<void>());
	readonly onDidChangeRepos: Event<void> = this._onDidChangeRepos.event;

	private readonly _poller: RunOnceScheduler;

	get repos(): readonly RepoInfo[] { return this._repos; }

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@IInsrcWorkspaceService private readonly workspaceService: IInsrcWorkspaceService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._poller = this._register(new RunOnceScheduler(() => this._poll(), POLL_INTERVAL_MS));

		// Refresh when daemon connects
		this._register(this.daemonService.onDidChangeState(state => {
			if (state === 'connected') {
				this.refresh();
				this._poller.schedule();
			} else {
				this._poller.cancel();
			}
		}));

		// Initial refresh if already connected
		if (this.daemonService.isConnected) {
			this.refresh();
			this._poller.schedule();
		}
	}

	async refresh(): Promise<void> {
		if (!this.daemonService.isConnected) {
			return;
		}

		try {
			const result = await this.daemonService.rpc<RepoInfo[]>('repo.list');
			this._repos = result ?? [];
			this._onDidChangeRepos.fire();
		} catch (err) {
			this.logService.warn('[insrc] Failed to refresh repos:', (err as Error).message);
		}
	}

	async addRepo(path: string): Promise<void> {
		if (!this.daemonService.isConnected) {
			throw new Error('Not connected to daemon');
		}

		await this.daemonService.rpc('repo.add', { path });
		await this.workspaceService.addFolder(path);
		await this.refresh();
		this.logService.info('[insrc] Added repo:', path);
	}

	async removeRepo(path: string): Promise<void> {
		if (!this.daemonService.isConnected) {
			throw new Error('Not connected to daemon');
		}

		await this.daemonService.rpc('repo.remove', { path });
		await this.workspaceService.removeFolder(path);
		await this.refresh();
		this.logService.info('[insrc] Removed repo:', path);
	}

	async reindexRepo(path: string): Promise<void> {
		if (!this.daemonService.isConnected) {
			throw new Error('Not connected to daemon');
		}

		await this.daemonService.rpc('repo.reindex', { path });
		await this.refresh();
		this.logService.info('[insrc] Re-indexing repo:', path);
	}

	private async _poll(): Promise<void> {
		await this.refresh();
		if (this.daemonService.isConnected) {
			this._poller.schedule();
		}
	}
}
