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
import type { AgentRunInfo } from '../../common/agentRunService.js';

// ---------------------------------------------------------------------------
// Runs ViewPane
// ---------------------------------------------------------------------------

const STATUS_ICON: Record<string, string> = {
	active: '\u25B6',   // play triangle
	paused: '\u275A\u275A', // double bar
	crashed: '\u2716',  // heavy X
	completed: '\u2714', // check
};

export class InsrcRunsViewPane extends ViewPane {

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
			const runs = await this.daemonService.rpc<AgentRunInfo[]>('agent.list');
			if (!runs || runs.length === 0) {
				this._listEl.textContent = 'No agent runs.';
				return;
			}

			// Filter to non-completed or recent
			const active = runs.filter(r => r.status !== 'completed');
			const completed = runs.filter(r => r.status === 'completed').slice(0, 5);
			const display = [...active, ...completed];

			if (display.length === 0) {
				this._listEl.textContent = 'No agent runs.';
				return;
			}

			clearNode(this._listEl);
			for (const run of display) {
				const row = document.createElement('div');
				row.style.whiteSpace = 'nowrap';
				row.style.overflow = 'hidden';
				row.style.textOverflow = 'ellipsis';

				const icon = STATUS_ICON[run.status] ?? '?';
				const agentName = run.id.split('-')[0] || run.agent || 'unknown';
				const step = run.step ? ` \u2014 ${run.step}` : '';
				const status = run.status || 'unknown';

				row.textContent = `${icon} ${agentName}${step} [${status}]`;
				row.title = `${run.id} - ${status}`;

				// Color based on status
				if (run.status === 'active') {
					row.style.color = 'var(--vscode-testing-iconPassed)';
				} else if (run.status === 'paused') {
					row.style.color = 'var(--vscode-editorWarning-foreground)';
				} else if (run.status === 'crashed') {
					row.style.color = 'var(--vscode-errorForeground)';
				} else {
					row.style.color = 'var(--vscode-descriptionForeground)';
				}

				this._listEl.appendChild(row);
			}
		} catch (err) {
			this._listEl.textContent = `Failed: ${(err as Error).message}`;
		}
	}
}
