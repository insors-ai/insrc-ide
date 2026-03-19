/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IDecorationsService, type IDecorationsProvider, type IDecorationData } from '../../../../services/decorations/common/decorations.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IInsrcRepoService, type RepoInfo } from '../../common/repoService.js';
import { listErrorForeground, listWarningForeground } from '../../../../../platform/theme/common/colorRegistry.js';

// ---------------------------------------------------------------------------
// Color references
// ---------------------------------------------------------------------------

// 'testing.iconPassed' may not be available in all contexts; use a known green
const listSuccessForeground = 'testing.iconPassed';

// ---------------------------------------------------------------------------
// Decoration data per repo status
// ---------------------------------------------------------------------------

function getDecorationForStatus(status: string, name: string): IDecorationData | undefined {
	switch (status) {
		case 'ready':
			return {
				letter: 'I',
				color: listSuccessForeground,
				tooltip: `insrc: indexed (${name})`,
				bubble: false,
			};
		case 'indexing':
			return {
				letter: '\u21BB',  // clockwise arrow
				color: listWarningForeground,
				tooltip: `insrc: indexing (${name})`,
				bubble: false,
			};
		case 'stale':
			return {
				letter: 'S',
				color: listWarningForeground,
				tooltip: `insrc: stale - needs re-index (${name})`,
				bubble: false,
			};
		case 'error':
			return {
				letter: 'E',
				color: listErrorForeground,
				tooltip: `insrc: error (${name})`,
				bubble: false,
			};
		default:
			return undefined;
	}
}

// ---------------------------------------------------------------------------
// InsrcFileDecorationsProvider
// ---------------------------------------------------------------------------

class InsrcDecorationsProvider implements IDecorationsProvider {
	readonly label = 'insrc';

	private readonly _onDidChange = new Emitter<readonly URI[]>();
	readonly onDidChange: Event<readonly URI[]> = this._onDidChange.event;

	private _repoMap = new Map<string, RepoInfo>();

	constructor(
		private readonly repoService: IInsrcRepoService,
	) {
		this._rebuildMap();
	}

	provideDecorations(uri: URI, _token: CancellationToken): IDecorationData | undefined {
		// Check if this URI is a repo root folder
		const fsPath = uri.fsPath;
		const repo = this._repoMap.get(fsPath);
		if (!repo) {
			return undefined;
		}

		return getDecorationForStatus(repo.status, repo.name);
	}

	update(): void {
		this._rebuildMap();

		// Fire change for all repo root URIs
		const uris = Array.from(this._repoMap.keys()).map(p => URI.file(p));
		this._onDidChange.fire(uris);
	}

	dispose(): void {
		this._onDidChange.dispose();
	}

	private _rebuildMap(): void {
		this._repoMap.clear();
		for (const repo of this.repoService.repos) {
			this._repoMap.set(repo.path, repo);
		}
	}
}

// ---------------------------------------------------------------------------
// Workbench contribution
// ---------------------------------------------------------------------------

export class InsrcFileDecorationsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.insrcFileDecorations';

	constructor(
		@IDecorationsService decorationsService: IDecorationsService,
		@IInsrcRepoService repoService: IInsrcRepoService,
		@ILogService logService: ILogService,
	) {
		super();

		const provider = new InsrcDecorationsProvider(repoService);
		this._register(decorationsService.registerDecorationsProvider(provider));

		this._register(repoService.onDidChangeRepos(() => {
			provider.update();
			logService.trace('[insrc] File decorations updated');
		}));
	}
}
