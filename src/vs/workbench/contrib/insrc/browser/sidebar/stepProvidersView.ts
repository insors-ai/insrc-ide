/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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

// ---------------------------------------------------------------------------
// Step Providers ViewPane
// ---------------------------------------------------------------------------
// Shows agent -> step -> provider bindings.
// Tree: AgentNode -> StepNode (with provider as description)
// Right-click step -> "Change Provider" quick pick.
// ---------------------------------------------------------------------------

export class InsrcStepProvidersViewPane extends ViewPane {

	private _placeholder: HTMLElement | undefined;

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

		this._register(this.daemonService.onDidChangeState(() => this._updateContent()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this._placeholder = document.createElement('div');
		this._placeholder.style.padding = '12px';
		this._placeholder.style.color = 'var(--vscode-descriptionForeground)';
		container.appendChild(this._placeholder);

		this._updateContent();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	private async _updateContent(): Promise<void> {
		if (!this._placeholder) {
			return;
		}

		if (!this.daemonService.isConnected) {
			this._placeholder.textContent = 'Connect to daemon to view step providers.';
			return;
		}

		try {
			const config = await this.daemonService.rpc<Record<string, Record<string, string>>>('config.show');
			const agents = config?.['agents'] ?? {};

			if (Object.keys(agents).length === 0) {
				this._placeholder.textContent = 'No step provider overrides configured.';
				return;
			}

			const lines: string[] = [];
			for (const [agent, steps] of Object.entries(agents)) {
				lines.push(agent);
				for (const [step, provider] of Object.entries(steps as Record<string, string>)) {
					lines.push(`  ${step} -> ${provider}`);
				}
			}
			this._placeholder.textContent = lines.join('\n');
		} catch {
			this._placeholder.textContent = 'Failed to load step providers.';
		}
	}
}
