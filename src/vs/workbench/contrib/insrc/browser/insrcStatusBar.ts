/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IStatusbarService, StatusbarAlignment, type IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';
import { IInsrcDaemonService } from '../common/daemonService.js';
import { IInsrcRepoService, type RepoInfo } from '../common/repoService.js';
import { IInsrcChatService } from '../common/chatService.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';

// ---------------------------------------------------------------------------
// Status bar contribution
// ---------------------------------------------------------------------------

export class InsrcStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.insrcStatusBar';

	private _entry: IStatusbarEntryAccessor | undefined;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@IInsrcRepoService private readonly repoService: IInsrcRepoService,
		@IInsrcChatService private readonly chatService: IInsrcChatService,
	) {
		super();

		this._updateStatus();

		this._register(this.daemonService.onDidChangeState(() => this._updateStatus()));
		this._register(this.repoService.onDidChangeRepos(() => this._updateStatus()));
		this._register(this.chatService.onDidReceiveEvent(e => {
			if (e.type === 'progress' || e.type === 'streamEnd') {
				this._updateStatus();
			}
		}));
	}

	private _updateStatus(): void {
		const connected = this.daemonService.isConnected;
		const streaming = this.chatService.isStreaming;
		const repos = [...this.repoService.repos];

		let text: string;
		let tooltip: MarkdownString;
		let command: string;

		if (!connected) {
			text = '$(circle-slash) insrc: disconnected';
			tooltip = this._buildTooltip('disconnected', repos);
			command = 'insrc.connectDaemon';
		} else if (streaming) {
			text = '$(loading~spin) insrc';
			tooltip = this._buildTooltip('processing', repos);
			command = 'insrc.openChat';
		} else {
			const indexing = repos.some(r => r.status === 'indexing');
			const stale = repos.some(r => r.status === 'stale');

			if (indexing) {
				text = '$(sync~spin) insrc: indexing';
				tooltip = this._buildTooltip('indexing', repos);
				command = 'insrc.openChat';
			} else if (stale) {
				text = '$(clock) insrc: stale';
				tooltip = this._buildTooltip('stale', repos);
				command = 'insrc.openChat';
			} else {
				text = '$(pass-filled) insrc';
				tooltip = this._buildTooltip('ready', repos);
				command = 'insrc.openChat';
			}
		}

		const properties = {
			name: 'insrc',
			text,
			ariaLabel: text.replace(/\$\([^)]+\)\s*/g, ''),
			tooltip,
			command,
			showInAllWindows: true,
		};

		if (this._entry) {
			this._entry.update(properties);
		} else {
			this._entry = this.statusbarService.addEntry(
				properties,
				'insrc.statusBar',
				StatusbarAlignment.LEFT,
				50,
			);
		}
	}

	private _buildTooltip(state: string, repos: RepoInfo[]): MarkdownString {
		const md = new MarkdownString('', true);
		md.isTrusted = true;
		md.supportThemeIcons = true;

		md.appendMarkdown(`### $(pass-filled) insrc\n\n`);

		const stateIcon = state === 'disconnected' ? '$(circle-slash)' :
			state === 'processing' ? '$(loading~spin)' :
				state === 'indexing' ? '$(sync~spin)' :
					state === 'stale' ? '$(clock)' : '$(pass-filled)';
		md.appendMarkdown(`**Status:** ${stateIcon} ${state}\n\n`);

		if (repos.length > 0) {
			md.appendMarkdown(`**Repos:**\n\n`);
			for (const repo of repos) {
				const icon = repo.status === 'ready' ? '$(pass-filled)' :
					repo.status === 'indexing' ? '$(sync~spin)' :
						repo.status === 'stale' ? '$(clock)' : '$(error)';
				md.appendMarkdown(`- ${icon} \`${repo.name}\`\n`);
			}
			md.appendMarkdown(`\n`);
		}

		md.appendMarkdown(`---\n\n`);
		if (state === 'disconnected') {
			md.appendMarkdown(`[$(debug-start) Connect](command:insrc.connectDaemon)`);
		} else {
			md.appendMarkdown(`[$(comment) Chat](command:insrc.openChat) · [$(gear) Settings](command:workbench.action.openSettings?%5B%22insrc%22%5D)`);
		}

		return md;
	}

	override dispose(): void {
		this._entry?.dispose();
		super.dispose();
	}
}
