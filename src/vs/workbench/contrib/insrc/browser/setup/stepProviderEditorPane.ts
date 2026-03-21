/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/setupWizard.css';
import * as dom from '../../../../../base/browser/dom.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IInsrcConfigService } from '../../common/configService.js';
import type { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import type { IEditorOpenContext } from '../../../../common/editor.js';
import type { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import type { StepProviderEditorInput } from './stepProviderEditorInput.js';

const PROVIDERS = ['local', 'claude:fast', 'claude:standard', 'claude:powerful'];


export class StepProviderEditorPane extends EditorPane {
	static readonly ID = 'insrc.stepProviderEditorPane';

	private _container!: HTMLElement;
	private _tableBody!: HTMLElement;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInsrcConfigService private readonly configService: IInsrcConfigService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(StepProviderEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = dom.append(parent, dom.$('.insrc-setup'));

		// Header
		const header = dom.append(this._container, dom.$('.insrc-setup-header'));
		const h1 = dom.append(header, dom.$('h1'));
		h1.textContent = 'Step Providers';
		const subtitle = dom.append(header, dom.$('p'));
		subtitle.textContent = 'Configure which LLM provider handles each agent step. Click a provider to change it.';

		// Accordion container (scrollable)
		this._tableBody = dom.append(this._container, dom.$('.insrc-setup-content'));
	}

	override async setInput(input: StepProviderEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		await this._loadTable();

		// Refresh when config changes
		this._register(this.configService.onDidChangeConfig(() => this._loadTable()));
	}

	layout(dimension: dom.Dimension): void {
		if (this._container) {
			this._container.style.height = `${dimension.height}px`;
			this._container.style.width = `${dimension.width}px`;
		}
	}

	private _expandedAgent: string | undefined;
	private _sections = new Map<string, { header: HTMLElement; body: HTMLElement }>();

	private async _loadTable(): Promise<void> {
		dom.clearNode(this._tableBody);
		this._sections.clear();

		const agents = await this.configService.getAgentBindings();

		if (Object.keys(agents).length === 0) {
			const msg = dom.append(this._tableBody, dom.$('p'));
			msg.style.padding = '24px 12px';
			msg.style.color = 'var(--vscode-descriptionForeground)';
			msg.style.textAlign = 'center';
			msg.textContent = 'No agent step providers configured. Run the Setup Wizard to get started.';
			return;
		}

		for (const [agentName, steps] of Object.entries(agents)) {
			if (typeof steps !== 'object' || steps === null) {
				continue;
			}

			const stepEntries = Object.entries(steps);
			const claudeCount = stepEntries.filter(([, v]) => String(v).startsWith('claude')).length;

			// Section container
			const section = dom.append(this._tableBody, dom.$('.insrc-sp-section'));
			section.style.borderBottom = '1px solid var(--vscode-widget-border, rgba(128,128,128,0.15))';

			// Header (clickable)
			const header = dom.append(section, dom.$('.insrc-sp-header'));
			header.style.display = 'flex';
			header.style.alignItems = 'center';
			header.style.padding = '8px 12px';
			header.style.cursor = 'pointer';
			header.style.userSelect = 'none';

			const chevron = dom.append(header, dom.$('.codicon.codicon-chevron-right'));
			chevron.style.fontSize = '14px';
			chevron.style.marginRight = '8px';
			chevron.style.transition = 'transform 0.15s';

			const nameEl = dom.append(header, dom.$('span'));
			nameEl.textContent = agentName;
			nameEl.style.fontWeight = '600';
			nameEl.style.fontSize = '13px';
			nameEl.style.flex = '1';

			const badge = dom.append(header, dom.$('span'));
			badge.textContent = `${stepEntries.length} steps`;
			badge.style.fontSize = '11px';
			badge.style.color = 'var(--vscode-descriptionForeground)';
			badge.style.marginRight = '8px';

			if (claudeCount > 0) {
				const claudeBadge = dom.append(header, dom.$('span'));
				claudeBadge.textContent = `${claudeCount} claude`;
				claudeBadge.style.fontSize = '11px';
				claudeBadge.style.color = 'var(--vscode-textLink-foreground)';
				claudeBadge.style.padding = '1px 6px';
				claudeBadge.style.borderRadius = '8px';
				claudeBadge.style.border = '1px solid var(--vscode-textLink-foreground)';
			}

			// Body (collapsed by default)
			const body = dom.append(section, dom.$('.insrc-sp-body'));
			body.style.display = 'none';
			body.style.padding = '0 12px 8px 34px';

			this._sections.set(agentName, { header, body });

			// Click to toggle
			header.onclick = () => this._toggleSection(agentName, chevron);

			// Step rows
			for (const [stepName, value] of stepEntries) {
				const provider = String(value);

				const row = dom.append(body, dom.$('.insrc-sp-row'));
				row.style.display = 'flex';
				row.style.alignItems = 'center';
				row.style.padding = '4px 0';
				row.style.gap = '8px';

				const stepEl = dom.append(row, dom.$('span'));
				stepEl.textContent = stepName;
				stepEl.style.flex = '1';
				stepEl.style.fontSize = '12px';

				const providerBtn = dom.append(row, dom.$('span'));
				providerBtn.textContent = provider;
				providerBtn.style.cursor = 'pointer';
				providerBtn.style.padding = '2px 8px';
				providerBtn.style.borderRadius = '4px';
				providerBtn.style.border = '1px solid var(--vscode-widget-border, rgba(128,128,128,0.3))';
				providerBtn.style.fontSize = '12px';

				if (provider.startsWith('claude')) {
					providerBtn.style.color = 'var(--vscode-textLink-foreground)';
				} else {
					providerBtn.style.color = 'var(--vscode-testing-iconPassed, #4caf7d)';
				}

				providerBtn.onclick = (e) => {
					e.stopPropagation();
					this._changeProvider(agentName, stepName, provider, providerBtn);
				};
			}
		}
	}

	private _toggleSection(agentName: string, chevron: HTMLElement): void {
		const isExpanding = this._expandedAgent !== agentName;

		// Collapse current
		if (this._expandedAgent) {
			const current = this._sections.get(this._expandedAgent);
			if (current) {
				current.body.style.display = 'none';
				const currentChevron = current.header.querySelector('.codicon') as HTMLElement | null;
				if (currentChevron) {
					currentChevron.style.transform = 'rotate(0deg)';
				}
			}
		}

		// Expand new (if different)
		if (isExpanding) {
			const section = this._sections.get(agentName);
			if (section) {
				section.body.style.display = 'block';
				chevron.style.transform = 'rotate(90deg)';
			}
			this._expandedAgent = agentName;
		} else {
			this._expandedAgent = undefined;
		}
	}

	private async _changeProvider(agentName: string, stepName: string, currentProvider: string, labelEl: HTMLElement): Promise<void> {
		const pick = await this.quickInputService.pick(
			PROVIDERS.map(p => ({
				label: p,
				description: p === currentProvider ? '(current)' : undefined,
			})),
			{ placeHolder: `Provider for ${agentName}.${stepName}` }
		);

		if (!pick || pick.label === currentProvider) {
			return;
		}

		try {
			await this.configService.setConfigValue(`models.agents.${agentName}.${stepName}`, pick.label);
			labelEl.textContent = pick.label;

			if (pick.label.startsWith('claude')) {
				labelEl.style.color = 'var(--vscode-textLink-foreground)';
			} else {
				labelEl.style.color = 'var(--vscode-testing-iconPassed, #4caf7d)';
			}

			this.notificationService.info(`${agentName}.${stepName} set to ${pick.label}`);
		} catch (err) {
			this.notificationService.warn(`Failed: ${(err as Error).message}`);
		}
	}
}
