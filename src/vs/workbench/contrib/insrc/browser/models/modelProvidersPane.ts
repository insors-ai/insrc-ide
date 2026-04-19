/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../setup/media/setupWizard.css';
import * as dom from '../../../../../base/browser/dom.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import type { IEditorOpenContext } from '../../../../common/editor.js';
import type { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import {
	IInsrcConfigService,
	type CloudProviderDTO,
	type CloudProviderName,
	type ProviderModel,
	type ProviderName,
	type ProvidersConfigDTO,
} from '../../common/configService.js';
import { IInsrcKeychainService } from '../../common/keychainService.js';
import type { ModelProvidersInput } from './modelProvidersInput.js';

const PROVIDER_TABS: Array<{ id: ProviderName; label: string }> = [
	{ id: 'local', label: 'Local' },
	{ id: 'openai', label: 'OpenAI' },
	{ id: 'anthropic', label: 'Anthropic' },
	{ id: 'gemini', label: 'Gemini' },
	{ id: 'mistral', label: 'Mistral' },
];

const COST_BANNER_DISMISSED_KEY = 'insrc.modelProviders.costBanner.dismissed';

export class ModelProvidersPane extends EditorPane {
	static readonly ID = 'insrc.modelProvidersPane';

	private _container!: HTMLElement;
	private _body!: HTMLElement;
	private _activeTab: ProviderName = 'local';
	private _tabButtons = new Map<ProviderName, HTMLElement>();
	private _modelListCache = new Map<ProviderName, ProviderModel[]>();
	private _config?: ProvidersConfigDTO;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService2: IStorageService,
		@IInsrcConfigService private readonly configService: IInsrcConfigService,
		@IInsrcKeychainService private readonly keychainService: IInsrcKeychainService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super(ModelProvidersPane.ID, group, telemetryService, themeService, storageService2);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = dom.append(parent, dom.$('.insrc-setup'));

		// Header
		const header = dom.append(this._container, dom.$('.insrc-setup-header'));
		const h1 = dom.append(header, dom.$('h1'));
		h1.textContent = 'Model Providers';
		const subtitle = dom.append(header, dom.$('p'));
		subtitle.textContent = 'Configure API keys, pick enabled models, and set the active cloud provider. Local (Ollama) is always available alongside.';

		// Tab bar
		const tabBar = dom.append(this._container, dom.$('div'));
		tabBar.style.display = 'flex';
		tabBar.style.gap = '4px';
		tabBar.style.padding = '0 12px';
		tabBar.style.borderBottom = '1px solid var(--vscode-widget-border, rgba(128,128,128,0.2))';

		for (const tab of PROVIDER_TABS) {
			const btn = dom.append(tabBar, dom.$('button'));
			btn.textContent = tab.label;
			btn.style.background = 'transparent';
			btn.style.border = 'none';
			btn.style.borderBottom = '2px solid transparent';
			btn.style.color = 'var(--vscode-foreground)';
			btn.style.padding = '8px 14px';
			btn.style.cursor = 'pointer';
			btn.style.fontSize = '13px';
			btn.onclick = () => this._selectTab(tab.id);
			this._tabButtons.set(tab.id, btn);
		}

		// Body (scrollable)
		this._body = dom.append(this._container, dom.$('.insrc-setup-content'));
		this._body.style.overflowY = 'auto';
		this._body.style.padding = '16px';
	}

	override async setInput(input: ModelProvidersInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (input.initialProvider) {
			this._activeTab = input.initialProvider;
		}
		await this._reloadConfig();
		this._selectTab(this._activeTab);
	}

	layout(dimension: dom.Dimension): void {
		if (this._container) {
			this._container.style.height = `${dimension.height}px`;
			this._container.style.width = `${dimension.width}px`;
		}
	}

	// ---- Data --------------------------------------------------------------

	/** Apply a partial patch to one cloud provider's config slice. */
	private async _patchCloudProvider(provider: CloudProviderName, patch: Partial<CloudProviderDTO>): Promise<void> {
		if (!this._config) {
			return;
		}
		const current = this._config.providers[provider];
		const nextProvider: CloudProviderDTO = { ...current, ...patch };
		const nextProviders: ProvidersConfigDTO['providers'] = {
			...this._config.providers,
			[provider]: nextProvider,
		};
		await this.configService.setProvidersConfig({ providers: nextProviders });
	}

	private async _reloadConfig(): Promise<void> {
		try {
			this._config = await this.configService.getProvidersConfig();
		} catch (err) {
			this.notificationService.warn(`Failed to load provider config: ${(err as Error).message}`);
		}
	}

	private async _fetchModels(provider: ProviderName, force = false): Promise<ProviderModel[]> {
		if (!force && this._modelListCache.has(provider)) {
			return this._modelListCache.get(provider)!;
		}
		try {
			const { models } = await this.configService.listProviderModels(provider);
			this._modelListCache.set(provider, models);
			return models;
		} catch (err) {
			this.notificationService.warn(`Failed to list ${provider} models: ${(err as Error).message}`);
			return [];
		}
	}

	// ---- Rendering ---------------------------------------------------------

	private _selectTab(tab: ProviderName): void {
		this._activeTab = tab;
		for (const [id, btn] of this._tabButtons) {
			btn.style.borderBottom = id === tab ? '2px solid var(--vscode-focusBorder)' : '2px solid transparent';
			btn.style.fontWeight = id === tab ? '600' : '400';
		}
		this._renderTab(tab);
	}

	private async _renderTab(tab: ProviderName): Promise<void> {
		dom.clearNode(this._body);
		if (!this._config) {
			await this._reloadConfig();
		}
		if (!this._config) {
			return;
		}
		if (tab === 'local') {
			this._renderLocalTab();
		} else {
			this._renderCloudTab(tab);
		}

		// Vision default (global; shown on every tab)
		this._renderVisionDefault();
	}

	private async _renderLocalTab(): Promise<void> {
		if (!this._config) {
			return;
		}
		const local = this._config.providers.local;

		const header = dom.append(this._body, dom.$('h2'));
		header.textContent = 'Local (Ollama)';
		header.style.margin = '0 0 12px';
		header.style.fontSize = '16px';

		// Host
		this._field('Ollama host', local.host, async v => {
			await this.configService.setProvidersConfig({
				providers: { ...this._config!.providers, local: { ...local, host: v } },
			});
			await this._reloadConfig();
			this._modelListCache.delete('local');
			this._selectTab('local');
		});

		// Fetch installed models
		const loading = dom.append(this._body, dom.$('p'));
		loading.textContent = 'Loading installed Ollama models...';
		loading.style.color = 'var(--vscode-descriptionForeground)';

		const models = await this._fetchModels('local');
		loading.remove();

		if (models.length === 0) {
			const empty = dom.append(this._body, dom.$('p'));
			empty.textContent = 'No models installed. Run `ollama pull <model>` and refresh.';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			this._button(this._body, 'Refresh', async () => {
				this._modelListCache.delete('local');
				this._selectTab('local');
			});
			return;
		}

		const coreModels = models.filter(m => !m.embedding);
		const embedModels = models.filter(m => m.embedding);

		this._select('Core model', coreModels.map(m => m.id), local.coreModel, async v => {
			await this.configService.setProvidersConfig({
				providers: { ...this._config!.providers, local: { ...local, coreModel: v } },
			});
			await this._reloadConfig();
			this._selectTab('local');
		});

		this._select('Embedding model', embedModels.map(m => m.id), local.embeddingModel, async v => {
			await this.configService.setProvidersConfig({
				providers: { ...this._config!.providers, local: { ...local, embeddingModel: v } },
			});
			await this._reloadConfig();
		});

		// Per-model context window for the core model
		const params = local.params[local.coreModel] ?? { maxInputTokens: 16384, maxOutputTokens: 8192 };
		this._paramEditor(`${local.coreModel} context window`, params, async next => {
			const newParams = { ...local.params, [local.coreModel]: next };
			await this.configService.setProvidersConfig({
				providers: { ...this._config!.providers, local: { ...local, params: newParams } },
			});
			await this._reloadConfig();
		});

		this._button(this._body, 'Refresh model list', async () => {
			this._modelListCache.delete('local');
			this._selectTab('local');
		});
	}

	private async _renderCloudTab(provider: CloudProviderName): Promise<void> {
		if (!this._config) {
			return;
		}
		const cfg = this._config.providers[provider];
		const keys = await this.keychainService.listKeys();
		const hasKey = keys.some(k => k.name === provider);

		const header = dom.append(this._body, dom.$('h2'));
		header.textContent = providerLabel(provider);
		header.style.margin = '0 0 8px';
		header.style.fontSize = '16px';

		// Cost warning banner (dismissible per-provider)
		this._renderCostBanner(provider);

		// Key status + actions row
		const row = dom.append(this._body, dom.$('div'));
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.gap = '12px';
		row.style.margin = '8px 0 16px';

		const status = dom.append(row, dom.$('span'));
		status.textContent = hasKey ? `Key configured` : `No API key set`;
		status.style.color = hasKey ? 'var(--vscode-testing-iconPassed, #4caf7d)' : 'var(--vscode-errorForeground)';
		status.style.fontSize = '12px';

		this._button(row, hasKey ? 'Replace API Key...' : 'Set API Key...', async () => {
			await this._promptForKey(provider);
			await this._renderTab(provider);
		}, { inline: true });

		if (hasKey) {
			this._button(row, 'Test key', async () => {
				const result = await this.configService.testProviderKey(provider);
				if (result.ok) {
					this.notificationService.info(`${providerLabel(provider)} key works.`);
				} else {
					this.notificationService.warn(`${providerLabel(provider)} key failed: ${result.error ?? ''}`);
				}
			}, { inline: true });
		}

		// Active-provider toggle
		const isActive = this._config.activeProvider === provider;
		this._button(row, isActive ? 'Active (click to deactivate)' : 'Set as active',
			async () => this._changeActiveProvider(isActive ? null : provider),
			{ inline: true, primary: !isActive });

		// Model list (live)
		if (!hasKey) {
			const warn = dom.append(this._body, dom.$('p'));
			warn.textContent = 'Set an API key to load the model list.';
			warn.style.color = 'var(--vscode-descriptionForeground)';
			return;
		}

		const loading = dom.append(this._body, dom.$('p'));
		loading.textContent = 'Loading models...';
		loading.style.color = 'var(--vscode-descriptionForeground)';
		const models = await this._fetchModels(provider);
		loading.remove();

		if (models.length === 0) {
			const empty = dom.append(this._body, dom.$('p'));
			empty.textContent = 'No models returned.';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			return;
		}

		// Model list with enabled checkbox + default radio
		const listHeader = dom.append(this._body, dom.$('h3'));
		listHeader.textContent = 'Models';
		listHeader.style.margin = '16px 0 6px';
		listHeader.style.fontSize = '13px';

		const list = dom.append(this._body, dom.$('div'));
		list.style.display = 'flex';
		list.style.flexDirection = 'column';
		list.style.gap = '2px';

		for (const m of models) {
			const modelRow = dom.append(list, dom.$('div'));
			modelRow.style.display = 'flex';
			modelRow.style.alignItems = 'center';
			modelRow.style.padding = '4px 0';
			modelRow.style.gap = '8px';

			const enableCb = dom.append(modelRow, dom.$('input')) as HTMLInputElement;
			enableCb.type = 'checkbox';
			enableCb.checked = cfg.enabled.includes(m.id);

			const name = dom.append(modelRow, dom.$('span'));
			name.textContent = m.id;
			name.style.flex = '1';
			name.style.fontSize = '12px';
			if (m.description) {
				const desc = dom.append(modelRow, dom.$('span'));
				desc.textContent = m.description;
				desc.style.fontSize = '11px';
				desc.style.color = 'var(--vscode-descriptionForeground)';
			}

			const defaultRadio = dom.append(modelRow, dom.$('input')) as HTMLInputElement;
			defaultRadio.type = 'radio';
			defaultRadio.name = `default-${provider}`;
			defaultRadio.checked = cfg.default === m.id;
			defaultRadio.disabled = !enableCb.checked;
			const defaultLabel = dom.append(modelRow, dom.$('span'));
			defaultLabel.textContent = 'default';
			defaultLabel.style.fontSize = '11px';
			defaultLabel.style.color = defaultRadio.checked ? 'var(--vscode-textLink-foreground)' : 'var(--vscode-descriptionForeground)';

			enableCb.onchange = async () => {
				const nextEnabled = enableCb.checked
					? Array.from(new Set([...cfg.enabled, m.id]))
					: cfg.enabled.filter(x => x !== m.id);
				let nextDefault = cfg.default;
				if (!enableCb.checked && cfg.default === m.id) {
					nextDefault = null;
				}
				if (nextDefault === null && nextEnabled.length === 1 && nextEnabled[0] === m.id) {
					nextDefault = m.id;
				}
				const nextParams = { ...cfg.params };
				if (enableCb.checked && !nextParams[m.id]) {
					nextParams[m.id] = {
						maxInputTokens: m.maxInputTokens ?? 128_000,
						maxOutputTokens: m.maxOutputTokens ?? 8_192,
					};
				}
				if (!enableCb.checked) {
					delete nextParams[m.id];
				}
				await this._patchCloudProvider(provider, { enabled: nextEnabled, default: nextDefault, params: nextParams });
				await this._reloadConfig();
				this._renderTab(provider);
			};

			defaultRadio.onchange = async () => {
				if (!defaultRadio.checked) {
					return;
				}
				await this._patchCloudProvider(provider, { default: m.id });
				await this._reloadConfig();
				this._renderTab(provider);
			};

			// Per-model params accordion (only if enabled)
			if (enableCb.checked) {
				const params = cfg.params[m.id] ?? {
					maxInputTokens: m.maxInputTokens ?? 128_000,
					maxOutputTokens: m.maxOutputTokens ?? 8_192,
				};
				const accordion = dom.append(list, dom.$('div'));
				accordion.style.paddingLeft = '28px';
				accordion.style.paddingBottom = '6px';
				this._paramEditor(undefined, params, async next => {
					const nextParams = { ...cfg.params, [m.id]: next };
					await this._patchCloudProvider(provider, { params: nextParams });
					await this._reloadConfig();
				}, accordion);
			}
		}

		this._button(this._body, 'Refresh model list', async () => {
			this._modelListCache.delete(provider);
			this._renderTab(provider);
		});
	}

	private _renderVisionDefault(): void {
		if (!this._config) {
			return;
		}
		const wrap = dom.append(this._body, dom.$('div'));
		wrap.style.marginTop = '32px';
		wrap.style.padding = '12px';
		wrap.style.border = '1px solid var(--vscode-widget-border, rgba(128,128,128,0.2))';
		wrap.style.borderRadius = '4px';

		const h = dom.append(wrap, dom.$('h3'));
		h.textContent = 'Vision Default';
		h.style.margin = '0 0 4px';
		h.style.fontSize = '13px';

		const note = dom.append(wrap, dom.$('p'));
		note.style.margin = '0 0 8px';
		note.style.fontSize = '11px';
		note.style.color = 'var(--vscode-descriptionForeground)';
		note.textContent =
			'When a turn includes an image or PDF attachment, route through this (provider, model) instead of the normal step binding. Unset -> attachment turns error.';

		const current = this._config.visionDefault;
		const label = dom.append(wrap, dom.$('span'));
		label.textContent = current ? `${current.provider} / ${current.model}` : '(none)';
		label.style.fontSize = '12px';

		this._button(wrap, current ? 'Change...' : 'Set vision default...', async () => {
			await this._pickVisionDefault();
		}, { inline: true });
		if (current) {
			this._button(wrap, 'Clear', async () => {
				await this.configService.setProvidersConfig({ visionDefault: null });
				await this._reloadConfig();
				this._renderTab(this._activeTab);
			}, { inline: true });
		}
	}

	private _renderCostBanner(provider: CloudProviderName): void {
		if (!this._config) {
			return;
		}
		const dismissed = this.storageService2.getBoolean(`${COST_BANNER_DISMISSED_KEY}.${provider}`, StorageScope.APPLICATION, false);
		if (dismissed) {
			return;
		}
		const banner = dom.append(this._body, dom.$('div.insrc-banner.insrc-banner-warning'));

		const icon = dom.append(banner, dom.$('span.codicon.codicon-warning.insrc-banner-icon'));
		void icon;

		const text = dom.append(banner, dom.$('div.insrc-banner-body'));
		const strong = dom.append(text, dom.$('strong'));
		strong.textContent = 'Set spend limits in your provider console. ';
		const rest = dom.append(text, dom.$('span'));
		rest.textContent =
			'insrc does not track token usage or enforce spend caps. Configure usage limits and alerts with your provider (billing / usage / quota settings in their web console) to avoid unexpected charges.';

		const dismiss = dom.append(banner, dom.$('button.insrc-banner-dismiss'));
		dismiss.textContent = 'Dismiss';
		dismiss.onclick = () => {
			this.storageService2.store(`${COST_BANNER_DISMISSED_KEY}.${provider}`, true, StorageScope.APPLICATION, StorageTarget.USER);
			banner.remove();
		};
	}

	// ---- Interactions ------------------------------------------------------

	private async _promptForKey(provider: CloudProviderName): Promise<void> {
		const value = await this.quickInputService.input({
			prompt: `${providerLabel(provider)} API key`,
			placeHolder: `Paste key (stored in OS keychain as account '${provider}')`,
			password: true,
			ignoreFocusLost: true,
		});
		if (!value) {
			return;
		}
		try {
			await this.keychainService.setKey(provider, value);
			this.notificationService.info(`${providerLabel(provider)} key stored.`);
		} catch (err) {
			this.notificationService.notify({
				severity: Severity.Error,
				message: `Failed to store ${provider} key: ${(err as Error).message}`,
			});
		}
	}

	private async _changeActiveProvider(next: CloudProviderName | null): Promise<void> {
		if (!this._config) {
			return;
		}
		const current = this._config.activeProvider;
		if (current === next) {
			return;
		}
		if (current !== null) {
			const { confirmed } = await this.dialogService.confirm({
				type: 'warning',
				message: `Switch active provider from ${providerLabel(current)} to ${next ? providerLabel(next) : 'none'}?`,
				detail: 'This clears all agent step bindings and the vision default. Per-provider enabled models and API keys are kept.',
				primaryButton: 'Switch',
			});
			if (!confirmed) {
				return;
			}
		}
		try {
			await this.configService.setProvidersConfig({ activeProvider: next });
			await this._reloadConfig();
			this._renderTab(this._activeTab);
		} catch (err) {
			this.notificationService.warn(`Failed to switch provider: ${(err as Error).message}`);
		}
	}

	private async _pickVisionDefault(): Promise<void> {
		if (!this._config) {
			return;
		}
		const active = this._config.activeProvider;
		const candidates: Array<{ provider: ProviderName; model: string }> = [];
		if (active) {
			for (const m of this._config.providers[active].enabled) {
				candidates.push({ provider: active, model: m });
			}
		}
		const local = this._config.providers.local;
		if (local.coreModel) {
			candidates.push({ provider: 'local', model: local.coreModel });
		}
		if (candidates.length === 0) {
			this.notificationService.warn('No enabled models to choose from. Enable models for the active provider first.');
			return;
		}

		type VisionPick = { label: string; provider: ProviderName; model: string };
		const items: VisionPick[] = candidates.map(c => ({
			label: `${providerLabel(c.provider)}: ${c.model}`,
			provider: c.provider,
			model: c.model,
		}));
		const pick = await this.quickInputService.pick<VisionPick>(items, {
			placeHolder: 'Vision default model (used when an image or PDF is attached)',
		});
		if (!pick) {
			return;
		}
		await this.configService.setProvidersConfig({ visionDefault: { provider: pick.provider, model: pick.model } });
		await this._reloadConfig();
		this._renderTab(this._activeTab);
	}

	// ---- Widget helpers ---------------------------------------------------

	private _field(label: string, value: string, onCommit: (v: string) => void | Promise<void>): void {
		const row = dom.append(this._body, dom.$('div.insrc-field-row'));
		const l = dom.append(row, dom.$('label'));
		l.textContent = label;
		const input = dom.append(row, dom.$('input')) as HTMLInputElement;
		input.value = value;
		input.onblur = () => {
			if (input.value !== value) {
				void onCommit(input.value);
			}
		};
		input.onkeydown = (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				(e.target as HTMLInputElement).blur();
			}
		};
	}

	private _select(label: string, options: string[], value: string, onChange: (v: string) => void | Promise<void>): void {
		const row = dom.append(this._body, dom.$('div.insrc-field-row'));
		const l = dom.append(row, dom.$('label'));
		l.textContent = label;
		const sel = dom.append(row, dom.$('select')) as HTMLSelectElement;
		const seen = new Set<string>();
		for (const opt of options) {
			if (seen.has(opt)) {
				continue;
			}
			seen.add(opt);
			const o = dom.append(sel, dom.$('option')) as HTMLOptionElement;
			o.value = opt;
			o.textContent = opt;
		}
		if (value && !seen.has(value)) {
			// Current value might not be in the live list -- show it anyway.
			const o = dom.append(sel, dom.$('option')) as HTMLOptionElement;
			o.value = value;
			o.textContent = value + ' (not installed)';
		}
		sel.value = value;
		sel.onchange = () => void onChange(sel.value);
	}

	private _paramEditor(
		label: string | undefined,
		params: { maxInputTokens: number; maxOutputTokens: number },
		onChange: (next: { maxInputTokens: number; maxOutputTokens: number }) => void | Promise<void>,
		parent?: HTMLElement,
	): void {
		const container = parent ?? this._body;
		const wrap = dom.append(container, dom.$('div'));
		wrap.style.display = 'flex';
		wrap.style.alignItems = 'center';
		wrap.style.gap = '12px';
		wrap.style.margin = '4px 0';
		wrap.style.fontSize = '11px';
		wrap.style.color = 'var(--vscode-descriptionForeground)';

		if (label) {
			const l = dom.append(wrap, dom.$('label'));
			l.textContent = label;
			l.style.width = '160px';
		}

		const mkNum = (name: string, initial: number, setter: (v: number) => void): void => {
			const cell = dom.append(wrap, dom.$('span'));
			cell.textContent = `${name}: `;
			const inp = dom.append(cell, dom.$('input')) as HTMLInputElement;
			inp.type = 'number';
			inp.value = String(initial);
			inp.style.width = '100px';
			inp.style.marginLeft = '4px';
			inp.style.background = 'var(--vscode-input-background)';
			inp.style.color = 'var(--vscode-input-foreground)';
			inp.style.border = '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, transparent))';
			inp.style.padding = '2px 4px';
			inp.onblur = () => {
				const n = Number(inp.value);
				if (Number.isFinite(n) && n > 0) {
					setter(n);
				}
			};
		};

		let next = { ...params };
		mkNum('maxInputTokens', params.maxInputTokens, v => { next = { ...next, maxInputTokens: v }; void onChange(next); });
		mkNum('maxOutputTokens', params.maxOutputTokens, v => { next = { ...next, maxOutputTokens: v }; void onChange(next); });
	}

	private _button(
		parent: HTMLElement,
		label: string,
		handler: () => void | Promise<void>,
		opts: { inline?: boolean; primary?: boolean } = {},
	): HTMLButtonElement {
		const cls = opts.primary ? 'insrc-btn.insrc-btn-primary' : 'insrc-btn.insrc-btn-secondary';
		const btn = dom.append(parent, dom.$(`button.${cls}`)) as HTMLButtonElement;
		btn.textContent = label;
		if (!opts.inline) {
			btn.classList.add('insrc-btn-block');
		}
		btn.onclick = () => void handler();
		return btn;
	}
}

function providerLabel(p: ProviderName): string {
	switch (p) {
		case 'local': return 'Local';
		case 'openai': return 'OpenAI';
		case 'anthropic': return 'Anthropic';
		case 'gemini': return 'Gemini';
		case 'mistral': return 'Mistral';
	}
}
