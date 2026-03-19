/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { Event } from '../../../../base/common/event.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RepoInfo {
	readonly path: string;
	readonly name: string;
	readonly status: 'ready' | 'indexing' | 'stale' | 'error';
	readonly lastIndexed?: string | undefined;
	readonly entityCount?: number | undefined;
}

// ---------------------------------------------------------------------------
// IInsrcRepoService
// ---------------------------------------------------------------------------
// Manages indexed repos via daemon RPCs. Also keeps workspace folders
// in sync via IInsrcWorkspaceService.
// ---------------------------------------------------------------------------

export const IInsrcRepoService = createDecorator<IInsrcRepoService>('insrcRepoService');

export interface IInsrcRepoService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeRepos: Event<void>;
	readonly repos: readonly RepoInfo[];

	/** Refresh repo list from daemon */
	refresh(): Promise<void>;

	/** Add a repo (daemon + workspace folder) */
	addRepo(path: string): Promise<void>;

	/** Remove a repo (daemon + workspace folder) */
	removeRepo(path: string): Promise<void>;

	/** Trigger re-index for a repo */
	reindexRepo(path: string): Promise<void>;
}
