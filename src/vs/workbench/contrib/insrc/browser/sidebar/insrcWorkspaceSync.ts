/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IInsrcDaemonService } from '../../common/daemonService.js';
import { IInsrcRepoService, type RepoInfo } from '../../common/repoService.js';
import { IInsrcWorkspaceService } from '../../common/workspaceService.js';

// ---------------------------------------------------------------------------
// InsrcWorkspaceSyncContribution
// ---------------------------------------------------------------------------
// On daemon connect, ensures all daemon-registered repos are added as
// workspace folders. This keeps the Explorer file tree in sync with the
// daemon's repo list.
// ---------------------------------------------------------------------------

export class InsrcWorkspaceSyncContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.insrcWorkspaceSync';

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@IInsrcRepoService private readonly repoService: IInsrcRepoService,
		@IInsrcWorkspaceService private readonly workspaceService: IInsrcWorkspaceService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Sync when daemon connects
		this._register(this.daemonService.onDidChangeState(state => {
			if (state === 'connected') {
				this._syncReposToWorkspace();
			}
		}));

		// Sync when repos change
		this._register(this.repoService.onDidChangeRepos(() => {
			this._syncReposToWorkspace();
		}));

		// Initial sync if already connected
		if (this.daemonService.isConnected) {
			this._syncReposToWorkspace();
		}
	}

	private async _syncReposToWorkspace(): Promise<void> {
		try {
			const repos: readonly RepoInfo[] = this.repoService.repos;
			if (repos.length === 0) {
				return;
			}

			// Ensure workspace file exists
			await this.workspaceService.ensureWorkspace();

			// Add each repo as a workspace folder if not already present
			for (const repo of repos) {
				try {
					await this.workspaceService.addFolder(repo.path);
				} catch (err) {
					this.logService.warn('[insrc] Failed to add repo folder to workspace:', repo.path, (err as Error).message);
				}
			}

			this.logService.info(`[insrc] Synced ${repos.length} repo(s) to workspace folders`);
		} catch (err) {
			this.logService.warn('[insrc] Workspace sync failed:', (err as Error).message);
		}
	}
}
