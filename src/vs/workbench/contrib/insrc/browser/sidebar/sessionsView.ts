/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { clearNode } from '../../../../../base/browser/dom.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInsrcDaemonService } from '../../common/daemonService.js';
import type { SessionInfo } from './sessionsTreeNodes.js';

// ---------------------------------------------------------------------------
// Sessions ViewPane
// ---------------------------------------------------------------------------

export class InsrcSessionsViewPane extends ViewPane {

	private _container: HTMLElement | undefined;
	private _listEl: HTMLElement | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IHoverService hoverService: IHoverService,
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService, hoverService);

		this._register(this.daemonService.onDidChangeState(() => this._refresh()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._container = container;
		container.style.overflow = 'auto';

		this._listEl = document.createElement('div');
		this._listEl.style.padding = '4px 12px';
		this._listEl.style.fontSize = '12px';
		this._listEl.style.lineHeight = '20px';
		container.appendChild(this._listEl);

		this._refresh();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	private async _refresh(): Promise<void> {
		if (!this._listEl) {
			return;
		}

		if (!this.daemonService.isConnected) {
			this._listEl.textContent = 'Connecting to daemon...';
			return;
		}

		try {
			const sessions = await this.daemonService.rpc<SessionInfo[]>('session.list');
			if (!sessions || sessions.length === 0) {
				this._listEl.textContent = 'No sessions.';
				return;
			}

			// Group by date
			const now = new Date();
			const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			const yesterday = new Date(today.getTime() - 86_400_000);
			const thisWeek = new Date(today.getTime() - 7 * 86_400_000);

			const groups: Map<string, SessionInfo[]> = new Map();
			for (const session of sessions) {
				const d = new Date(session.createdAt);
				let label: string;
				if (d >= today) {
					label = 'Today';
				} else if (d >= yesterday) {
					label = 'Yesterday';
				} else if (d >= thisWeek) {
					label = 'This week';
				} else {
					label = 'Older';
				}
				if (!groups.has(label)) {
					groups.set(label, []);
				}
				groups.get(label)!.push(session);
			}

			clearNode(this._listEl);
			for (const [label, items] of groups) {
				const header = document.createElement('div');
				header.style.fontWeight = '600';
				header.style.marginTop = '8px';
				header.style.marginBottom = '2px';
				header.style.color = 'var(--vscode-foreground)';
				header.textContent = `${label} (${items.length})`;
				this._listEl.appendChild(header);

				for (const s of items) {
					const row = document.createElement('div');
					row.style.color = 'var(--vscode-descriptionForeground)';
					row.style.whiteSpace = 'nowrap';
					row.style.overflow = 'hidden';
					row.style.textOverflow = 'ellipsis';
					row.style.paddingLeft = '8px';
					row.style.cursor = 'pointer';

					const time = new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
					const summary = (s.summary || s.id).substring(0, 60);
					row.textContent = `${time}  ${summary}`;
					row.title = s.summary || s.id;
					this._listEl.appendChild(row);
				}
			}
		} catch (err) {
			this._listEl.textContent = `Failed: ${(err as Error).message}`;
		}
	}
}
