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
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IInsrcConfigService, type ProvidersConfigDTO, type ProviderName } from '../../common/configService.js';
import type { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import type { IEditorOpenContext } from '../../../../common/editor.js';
import type { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import type { StepProviderEditorInput } from './stepProviderEditorInput.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StepBinding = { provider: ProviderName; model?: string };
type StepValue = string | StepBinding;

const CLOUD_PROVIDERS: readonly ProviderName[] = ['anthropic', 'openai', 'gemini', 'mistral'];

/**
 * Normalise whatever shape the config currently carries into a concrete
 * `{ provider, model }` pair. Works for raw shorthand strings, full
 * StepBinding objects, or the legacy `claude:*` strings that Item 23b's
 * migration replaces on load (kept here as a defensive fallback for
 * configs that never went through the migration).
 */
function normalizeBinding(value: StepValue | undefined, cfg: ProvidersConfigDTO): { provider: ProviderName; model: string } {
	if (!value) {
		return activeProviderDefault(cfg);
	}
	if (typeof value === 'string') {
		if (value === 'local') {
			return { provider: 'local', model: cfg.providers.local.coreModel };
		}
		if ((CLOUD_PROVIDERS as readonly string[]).includes(value)) {
			const name = value as ProviderName;
			if (name !== 'local') {
				const def = cfg.providers[name].default ?? '';
				return { provider: name, model: def };
			}
		}
		// Legacy `claude:*` or anything else -> fall through to active default.
		return activeProviderDefault(cfg);
	}
	// Object form.
	const provider = value.provider;
	if (provider === 'local') {
		return { provider: 'local', model: value.model ?? cfg.providers.local.coreModel };
	}
	const def = cfg.providers[provider].default ?? '';
	return { provider, model: value.model ?? def };
}

function activeProviderDefault(cfg: ProvidersConfigDTO): { provider: ProviderName; model: string } {
	const active = cfg.activeProvider;
	if (active) {
		const def = cfg.providers[active].default ?? '';
		return { provider: active, model: def };
	}
	return { provider: 'local', model: cfg.providers.local.coreModel };
}

function enabledModelsFor(provider: ProviderName, cfg: ProvidersConfigDTO): string[] {
	if (provider === 'local') {
		// Local has one core model; surface it as the only option.
		return [cfg.providers.local.coreModel];
	}
	return [...cfg.providers[provider].enabled];
}

// ---------------------------------------------------------------------------
// Editor pane
// ---------------------------------------------------------------------------

export class StepProviderEditorPane extends EditorPane {
	static readonly ID = 'insrc.stepProviderEditorPane';

	private _container!: HTMLElement;
	private _tableBody!: HTMLElement;
	private _expandedAgent: string | undefined;
	private _sections = new Map<string, { header: HTMLElement; body: HTMLElement }>();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInsrcConfigService private readonly configService: IInsrcConfigService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(StepProviderEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = dom.append(parent, dom.$('.insrc-setup'));

		const header = dom.append(this._container, dom.$('.insrc-setup-header'));
		const h1 = dom.append(header, dom.$('h1'));
		h1.textContent = 'Step Providers';
		const subtitle = dom.append(header, dom.$('p'));
		subtitle.textContent = 'Pick a provider and model for every agent step. Options reflect your currently-active cloud provider in the Model Providers pane.';

		this._tableBody = dom.append(this._container, dom.$('.insrc-setup-content'));
	}

	override async setInput(input: StepProviderEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		await this._loadTable();
		this._register(this.configService.onDidChangeConfig(() => this._loadTable()));
	}

	layout(dimension: dom.Dimension): void {
		if (this._container) {
			this._container.style.height = `${dimension.height}px`;
			this._container.style.width = `${dimension.width}px`;
		}
	}

	private async _loadTable(): Promise<void> {
		dom.clearNode(this._tableBody);
		this._sections.clear();

		// Pull both the providers config (active cloud + enabled models) and
		// the agent bindings. Fall back gracefully if either RPC fails.
		let providers: ProvidersConfigDTO;
		try {
			providers = await this.configService.getProvidersConfig();
		} catch (err) {
			const msg = dom.append(this._tableBody, dom.$('p'));
			msg.style.padding = '24px 12px';
			msg.style.color = 'var(--vscode-errorForeground)';
			msg.textContent = `Failed to load providers config: ${(err as Error).message}`;
			return;
		}

		const rawAgents = providers.agents ?? {};

		const agentEntries = Object.entries(rawAgents).filter(([, steps]) =>
			steps && typeof steps === 'object' && Object.keys(steps).length > 0,
		);

		if (agentEntries.length === 0) {
			// Item 26d: actionable empty state. The old copy ("daemon seeds
			// defaults on first use") was aspirational and misleading -- the
			// daemon only seeds once the user picks an active cloud in the
			// Model Providers pane. Point them there when no active cloud is
			// set; otherwise assume a load race and nudge a reload.
			const msg = dom.append(this._tableBody, dom.$('.insrc-sp-empty'));
			msg.style.padding = '32px 20px';
			msg.style.color = 'var(--vscode-descriptionForeground)';
			msg.style.textAlign = 'center';
			msg.style.display = 'flex';
			msg.style.flexDirection = 'column';
			msg.style.alignItems = 'center';
			msg.style.gap = '10px';

			const heading = dom.append(msg, dom.$('div'));
			heading.style.fontSize = '13px';
			heading.style.color = 'var(--vscode-foreground)';

			const hint = dom.append(msg, dom.$('div'));
			hint.style.fontSize = '12px';
			hint.style.maxWidth = '420px';

			if (providers.activeProvider) {
				heading.textContent = 'No agent step bindings found.';
				hint.textContent = `Active cloud is ${providers.activeProvider}, but the \`models.agents\` map is empty. This usually self-heals on daemon restart -- try reopening this pane or restarting the daemon.`;
			} else {
				heading.textContent = 'No active cloud provider.';
				hint.textContent = 'Pick an active cloud provider (Anthropic, OpenAI, Gemini, or Mistral) in the Model Providers pane. Once configured, this page will populate with per-step defaults that you can customize.';

				const btn = dom.append(msg, dom.$('button.insrc-sp-open-providers')) as HTMLButtonElement;
				btn.textContent = 'Open Model Providers';
				btn.style.marginTop = '6px';
				btn.style.padding = '6px 14px';
				btn.style.fontSize = '12px';
				btn.style.background = 'var(--vscode-button-background)';
				btn.style.color = 'var(--vscode-button-foreground)';
				btn.style.border = 'none';
				btn.style.borderRadius = '4px';
				btn.style.cursor = 'pointer';
				btn.addEventListener('click', () => {
					// insrc.openModelProviders is the registered command id.
					this.commandService.executeCommand('insrc.openModelProviders').then(
						undefined,
						(err: Error) => this.notificationService.warn(`Failed to open Model Providers: ${err.message}`),
					);
				});
			}
			return;
		}

		// Sticky "current active cloud" banner at the top -- clarifies which
		// cloud provider the dropdowns default to and which one orphan
		// warnings reference.
		const activeBanner = dom.append(this._tableBody, dom.$('.insrc-sp-active-banner'));
		activeBanner.style.padding = '8px 12px';
		activeBanner.style.fontSize = '12px';
		activeBanner.style.color = 'var(--vscode-descriptionForeground)';
		if (providers.activeProvider) {
			activeBanner.textContent = `Active cloud provider: ${providers.activeProvider}. Cloud bindings to other providers will be flagged as orphan.`;
		} else {
			activeBanner.textContent = 'No active cloud provider. Every step binding runs on local until you pick one in the Model Providers pane.';
		}

		for (const [agentName, steps] of agentEntries) {
			this._renderAgentSection(agentName, steps as Record<string, StepValue>, providers);
		}
	}

	private _renderAgentSection(agentName: string, steps: Record<string, StepValue>, providers: ProvidersConfigDTO): void {
		const stepEntries = Object.entries(steps);

		const section = dom.append(this._tableBody, dom.$('.insrc-sp-section'));
		section.style.borderBottom = '1px solid var(--vscode-widget-border, rgba(128,128,128,0.15))';

		// Header
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

		// Orphan count (bindings referencing non-active cloud providers).
		const orphanCount = stepEntries.filter(([, v]) => {
			const resolved = normalizeBinding(v, providers);
			return resolved.provider !== 'local'
				&& providers.activeProvider !== null
				&& resolved.provider !== providers.activeProvider;
		}).length;
		if (orphanCount > 0) {
			const orphanBadge = dom.append(header, dom.$('span'));
			orphanBadge.textContent = `${orphanCount} orphan`;
			orphanBadge.style.fontSize = '11px';
			orphanBadge.style.color = 'var(--vscode-editorWarning-foreground)';
			orphanBadge.style.padding = '1px 6px';
			orphanBadge.style.borderRadius = '8px';
			orphanBadge.style.border = '1px solid var(--vscode-editorWarning-foreground)';
			orphanBadge.title = `Step bindings reference a non-active cloud provider. Reassign in the editor below.`;
		}

		// Body
		const body = dom.append(section, dom.$('.insrc-sp-body'));
		body.style.display = 'none';
		body.style.padding = '0 12px 12px 34px';

		this._sections.set(agentName, { header, body });
		header.onclick = () => this._toggleSection(agentName, chevron);

		// Step rows
		for (const [stepName, value] of stepEntries) {
			this._renderStepRow(body, agentName, stepName, value, providers);
		}
	}

	private _renderStepRow(
		body: HTMLElement,
		agentName: string,
		stepName: string,
		value: StepValue,
		providers: ProvidersConfigDTO,
	): void {
		const resolved = normalizeBinding(value, providers);
		const row = dom.append(body, dom.$('.insrc-sp-row'));
		row.style.display = 'grid';
		row.style.gridTemplateColumns = '160px 130px 1fr auto';
		row.style.alignItems = 'center';
		row.style.gap = '8px';
		row.style.padding = '6px 0';

		const stepEl = dom.append(row, dom.$('span'));
		stepEl.textContent = stepName;
		stepEl.style.fontSize = '12px';

		// Provider dropdown: always offers Local + whichever cloud is active.
		// A currently-bound non-active cloud (orphan) is also included so the
		// user can see it; picking a different provider clears the orphan.
		const providerSelect = dom.append(row, dom.$('select.insrc-sp-provider')) as HTMLSelectElement;
		const providerOptions: ProviderName[] = ['local'];
		if (providers.activeProvider) {
			providerOptions.push(providers.activeProvider);
		}
		if (resolved.provider !== 'local' && !providerOptions.includes(resolved.provider)) {
			providerOptions.push(resolved.provider);
		}
		for (const p of providerOptions) {
			const opt = dom.append(providerSelect, dom.$('option')) as HTMLOptionElement;
			opt.value = p;
			opt.textContent = p;
			if (p === resolved.provider) { opt.selected = true; }
		}

		// Model dropdown: populated from providers[selected].enabled.
		const modelSelect = dom.append(row, dom.$('select.insrc-sp-model')) as HTMLSelectElement;
		this._populateModelDropdown(modelSelect, resolved.provider, resolved.model, providers);

		// Status column: orphan warning OR resolved model echo.
		const status = dom.append(row, dom.$('span'));
		status.style.fontSize = '11px';
		const isOrphan = resolved.provider !== 'local'
			&& providers.activeProvider !== null
			&& resolved.provider !== providers.activeProvider;
		if (isOrphan) {
			status.textContent = `orphan -- active cloud is ${providers.activeProvider}`;
			status.style.color = 'var(--vscode-editorWarning-foreground)';
		} else {
			status.textContent = '';
		}

		// Clear button (only visible when the step has an explicit binding --
		// lets the user fall back to the active-provider default).
		const clearBtn = dom.append(row, dom.$('button.insrc-sp-clear')) as HTMLButtonElement;
		clearBtn.textContent = 'Clear';
		clearBtn.title = 'Remove this explicit binding; step will use the active-provider default.';
		clearBtn.style.fontSize = '11px';
		clearBtn.style.padding = '2px 8px';
		clearBtn.style.background = 'transparent';
		clearBtn.style.border = '1px solid var(--vscode-widget-border, rgba(128,128,128,0.3))';
		clearBtn.style.color = 'var(--vscode-descriptionForeground)';
		clearBtn.style.borderRadius = '4px';
		clearBtn.style.cursor = 'pointer';

		providerSelect.addEventListener('change', async () => {
			const nextProvider = providerSelect.value as ProviderName;
			// Repopulate model dropdown for the new provider, pick its first
			// enabled model by default.
			const enabled = enabledModelsFor(nextProvider, providers);
			const nextModel = enabled[0] ?? '';
			this._populateModelDropdown(modelSelect, nextProvider, nextModel, providers);
			await this._writeBinding(agentName, stepName, { provider: nextProvider, model: nextModel || undefined });
		});

		modelSelect.addEventListener('change', async () => {
			const nextProvider = providerSelect.value as ProviderName;
			const nextModel = modelSelect.value;
			await this._writeBinding(agentName, stepName, { provider: nextProvider, model: nextModel || undefined });
		});

		clearBtn.addEventListener('click', async () => {
			try {
				await this.configService.setConfigValue(`models.agents.${agentName}.${stepName}`, null);
				this.notificationService.info(`${agentName}.${stepName} binding cleared.`);
			} catch (err) {
				this.notificationService.warn(`Failed to clear: ${(err as Error).message}`);
			}
		});
	}

	private _populateModelDropdown(
		select: HTMLSelectElement,
		provider: ProviderName,
		selectedModel: string,
		providers: ProvidersConfigDTO,
	): void {
		dom.clearNode(select);
		const enabled = enabledModelsFor(provider, providers);
		if (enabled.length === 0) {
			const opt = dom.append(select, dom.$('option')) as HTMLOptionElement;
			opt.value = '';
			opt.textContent = '(no models enabled)';
			opt.disabled = true;
			opt.selected = true;
			return;
		}
		// If the currently-bound model isn't in the enabled list, surface it
		// as a disabled option tagged "(missing)" so the user sees what's
		// actually configured.
		const known = new Set(enabled);
		const final = known.has(selectedModel) ? enabled : [selectedModel, ...enabled];
		for (const m of final) {
			if (!m) { continue; }
			const opt = dom.append(select, dom.$('option')) as HTMLOptionElement;
			opt.value = m;
			opt.textContent = known.has(m) ? m : `${m} (missing)`;
			if (m === selectedModel) { opt.selected = true; }
		}
	}

	private async _writeBinding(agentName: string, stepName: string, binding: StepBinding): Promise<void> {
		// Item 23e: always write the StepBinding object shape. Keeping the
		// runtime's string-shorthand acceptance for hand-edited configs is
		// fine, but the editor normalises every touched entry.
		try {
			await this.configService.setConfigValue(`models.agents.${agentName}.${stepName}`, binding);
			this.notificationService.info(`${agentName}.${stepName} set to ${binding.provider}${binding.model ? ` / ${binding.model}` : ''}.`);
		} catch (err) {
			this.notificationService.warn(`Failed to save: ${(err as Error).message}`);
		}
	}

	private _toggleSection(agentName: string, chevron: HTMLElement): void {
		const isExpanding = this._expandedAgent !== agentName;
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
}
