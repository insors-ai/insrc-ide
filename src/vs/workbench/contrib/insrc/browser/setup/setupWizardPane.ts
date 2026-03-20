/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/setupWizard.css';
import * as dom from '../../../../../base/browser/dom.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IInsrcConfigService } from '../../common/configService.js';
import { IInsrcKeychainService } from '../../common/keychainService.js';
import { IInsrcDaemonService } from '../../common/daemonService.js';
import type { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import type { IEditorOpenContext } from '../../../../common/editor.js';
import type { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import type { SetupWizardInput } from './setupWizardInput.js';

const STEP_LABELS = ['System', 'Optimize', 'Models', 'Keys', 'Done'];

export class SetupWizardPane extends EditorPane {
	static readonly ID = 'insrc.setupWizardPane';

	private _container!: HTMLElement;
	private _stepDots: HTMLElement[] = [];
	private _stepContent!: HTMLElement;
	private _prevBtn!: HTMLButtonElement;
	private _nextBtn!: HTMLButtonElement;

	private _currentStep = 0;
	private _recommendation: Record<string, unknown> | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly _storageService: IStorageService,
		@IInsrcConfigService private readonly configService: IInsrcConfigService,
		@IInsrcKeychainService private readonly keychainService: IInsrcKeychainService,
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(SetupWizardPane.ID, group, telemetryService, themeService, _storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = dom.append(parent, dom.$('.insrc-setup'));

		// Header
		const header = dom.append(this._container, dom.$('.insrc-setup-header'));
		const h1 = dom.append(header, dom.$('h1'));
		h1.textContent = 'insrc Setup';
		const subtitle = dom.append(header, dom.$('p'));
		subtitle.textContent = 'Configure your local-first coding assistant';

		// Step dots
		const dots = dom.append(this._container, dom.$('.insrc-setup-steps'));
		for (let i = 0; i < STEP_LABELS.length; i++) {
			const dot = dom.append(dots, dom.$('.insrc-setup-step-dot'));
			dot.title = STEP_LABELS[i]!;
			this._stepDots.push(dot);
		}

		// Content area
		this._stepContent = dom.append(this._container, dom.$('.insrc-setup-content'));

		// Navigation
		const nav = dom.append(this._container, dom.$('.insrc-setup-nav'));
		this._prevBtn = dom.append(nav, dom.$('button.insrc-setup-btn.insrc-setup-btn-secondary')) as HTMLButtonElement;
		this._prevBtn.textContent = 'Back';
		this._prevBtn.onclick = () => this._goToStep(this._currentStep - 1);

		this._nextBtn = dom.append(nav, dom.$('button.insrc-setup-btn.insrc-setup-btn-primary')) as HTMLButtonElement;
		this._nextBtn.textContent = 'Next';
		this._nextBtn.onclick = () => this._goToStep(this._currentStep + 1);
	}

	override async setInput(input: SetupWizardInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this._goToStep(0);
	}

	layout(dimension: dom.Dimension): void {
		if (this._container) {
			this._container.style.height = `${dimension.height}px`;
			this._container.style.width = `${dimension.width}px`;
		}
	}

	// ---------------------------------------------------------------------------
	// Navigation
	// ---------------------------------------------------------------------------

	private _goToStep(step: number): void {
		if (step < 0 || step >= STEP_LABELS.length) {
			return;
		}
		this._currentStep = step;

		// Update dots
		for (let i = 0; i < this._stepDots.length; i++) {
			const dot = this._stepDots[i]!;
			dot.classList.toggle('active', i === step);
			dot.classList.toggle('done', i < step);
		}

		// Update buttons
		this._prevBtn.style.visibility = step === 0 ? 'hidden' : 'visible';
		if (step === STEP_LABELS.length - 1) {
			this._nextBtn.textContent = 'Finish';
			this._nextBtn.onclick = () => this._finish();
		} else {
			this._nextBtn.textContent = 'Next';
			this._nextBtn.onclick = () => this._goToStep(this._currentStep + 1);
		}

		// Render step
		dom.clearNode(this._stepContent);
		switch (step) {
			case 0: this._renderDetect(); break;
			case 1: this._renderOptimize(); break;
			case 2: this._renderModels(); break;
			case 3: this._renderKeys(); break;
			case 4: this._renderDone(); break;
		}
	}

	// ---------------------------------------------------------------------------
	// Step 0: System Detection
	// ---------------------------------------------------------------------------

	private async _renderDetect(): Promise<void> {
		const loading = dom.append(this._stepContent, dom.$('.insrc-setup-loading'));
		dom.append(loading, dom.$('.codicon.codicon-loading.codicon-modifier-spin'));
		const loadText = dom.append(loading, dom.$('span'));
		loadText.textContent = 'Detecting system...';

		try {
			this._recommendation = await this.configService.getRecommendation();
		} catch {
			dom.clearNode(this._stepContent);
			const err = dom.append(this._stepContent, dom.$('p'));
			err.textContent = 'Failed to detect system. Is the daemon running?';
			return;
		}

		dom.clearNode(this._stepContent);

		const system = this._recommendation['system'] as Record<string, unknown> | undefined;
		const rec = this._recommendation['recommendation'] as Record<string, unknown> | undefined;

		if (!system || !rec) {
			const err = dom.append(this._stepContent, dom.$('p'));
			err.textContent = 'No system data available.';
			return;
		}

		// Hardware table
		const cpu = system['cpu'] as Record<string, unknown> | undefined;
		const ram = system['ram'] as Record<string, unknown> | undefined;
		const gpu = system['gpu'] as Record<string, unknown> | undefined;
		const ollama = system['ollama'] as Record<string, unknown> | undefined;

		const table = dom.append(this._stepContent, dom.$('table.insrc-setup-table'));
		this._addRow(table, 'CPU', `${cpu?.['model'] ?? 'Unknown'} (${cpu?.['cores'] ?? '?'} cores)`);
		this._addRow(table, 'RAM', `${Math.round(((ram?.['totalMb'] as number) ?? 0) / 1024)} GB`);
		this._addRow(table, 'GPU', gpu ? `${gpu['name']} (${Math.round(((gpu['vramMb'] as number) ?? 0) / 1024)} GB VRAM)` : 'None detected');
		this._addRow(table, 'Ollama', ollama?.['available'] ? `v${ollama['version']}` : 'Not installed');

		// Recommendation card
		const card = dom.append(this._stepContent, dom.$('.insrc-setup-recommendation'));
		const tier = dom.append(card, dom.$('.insrc-setup-tier'));
		tier.textContent = (rec['tier'] as string) ?? 'unknown';

		const coderRec = rec['coder'] as Record<string, unknown> | undefined;
		const embRec = rec['embedding'] as Record<string, unknown> | undefined;
		const ctxRec = rec['context'] as Record<string, unknown> | undefined;

		const recTable = dom.append(card, dom.$('table.insrc-setup-table'));
		this._addRow(recTable, 'Coder Model', `${coderRec?.['model'] ?? '?'} (${coderRec?.['params'] ?? '?'})`);
		this._addRow(recTable, 'Embedding', `${embRec?.['model'] ?? '?'} (${embRec?.['dims'] ?? '?'} dims)`);
		this._addRow(recTable, 'Context', `${ctxRec?.['shape'] ?? '?'} (${ctxRec?.['tokens'] ?? '?'} tokens)`);

		// Notes
		const notes = rec['notes'] as string[] | undefined;
		if (notes && notes.length > 0) {
			const ul = dom.append(this._stepContent, dom.$('ul.insrc-setup-notes'));
			for (const note of notes) {
				const li = dom.append(ul, dom.$('li'));
				li.textContent = note;
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Step 1: Ollama Optimizations
	// ---------------------------------------------------------------------------

	private _renderOptimize(): void {
		const rec = this._recommendation?.['recommendation'] as Record<string, unknown> | undefined;
		const opts = (rec?.['ollamaOptimizations'] ?? []) as Array<Record<string, unknown>>;

		if (opts.length === 0) {
			const msg = dom.append(this._stepContent, dom.$('p'));
			msg.textContent = 'No optimizations needed. Your Ollama setup is good!';
			dom.append(this._stepContent, dom.$('.codicon.codicon-pass-filled')).style.fontSize = '32px';
			return;
		}

		const intro = dom.append(this._stepContent, dom.$('p'));
		intro.textContent = `${opts.length} optimization(s) found. Apply these for better performance:`;

		for (const opt of opts) {
			const card = dom.append(this._stepContent, dom.$('.insrc-setup-opt-card'));

			const issue = dom.append(card, dom.$('.insrc-setup-opt-issue'));
			issue.textContent = opt['issue'] as string ?? '';

			const fix = dom.append(card, dom.$('.insrc-setup-opt-fix'));
			fix.textContent = opt['fix'] as string ?? '';

			const command = opt['command'] as string | undefined;
			if (command) {
				const cmdRow = dom.append(card, dom.$('.insrc-setup-opt-cmd'));
				const code = dom.append(cmdRow, dom.$('code'));
				code.textContent = command;

				const copyBtn = dom.append(cmdRow, dom.$('button.insrc-setup-copy-btn.codicon.codicon-copy'));
				copyBtn.title = 'Copy to clipboard';
				copyBtn.onclick = () => {
					navigator.clipboard.writeText(command);
					copyBtn.classList.remove('codicon-copy');
					copyBtn.classList.add('codicon-check');
					setTimeout(() => {
						copyBtn.classList.remove('codicon-check');
						copyBtn.classList.add('codicon-copy');
					}, 2000);
				};
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Step 2: Model Pull
	// ---------------------------------------------------------------------------

	private _renderModels(): void {
		const rec = this._recommendation?.['recommendation'] as Record<string, unknown> | undefined;
		const coder = rec?.['coder'] as Record<string, unknown> | undefined;
		const embedding = rec?.['embedding'] as Record<string, unknown> | undefined;

		const models = [
			{ label: 'Coder', name: coder?.['model'] as string ?? '', needsPull: coder?.['pull'] as boolean ?? true },
			{ label: 'Embedding', name: embedding?.['model'] as string ?? '', needsPull: embedding?.['pull'] as boolean ?? true },
		].filter(m => m.name);

		if (models.length === 0) {
			const msg = dom.append(this._stepContent, dom.$('p'));
			msg.textContent = 'No models to pull.';
			return;
		}

		const intro = dom.append(this._stepContent, dom.$('p'));
		intro.textContent = 'Pull the recommended models:';

		for (const model of models) {
			const row = dom.append(this._stepContent, dom.$('.insrc-setup-model-row'));

			const nameEl = dom.append(row, dom.$('.insrc-setup-model-name'));
			nameEl.textContent = `${model.label}: ${model.name}`;

			const statusEl = dom.append(row, dom.$('.insrc-setup-model-status'));

			if (!model.needsPull) {
				statusEl.textContent = 'Already installed';
				dom.append(row, dom.$('.codicon.codicon-pass-filled')).style.color = 'var(--vscode-testing-iconPassed)';
			} else {
				const progressContainer = dom.append(row, dom.$('.insrc-setup-progress'));
				const progressFill = dom.append(progressContainer, dom.$('.insrc-setup-progress-fill'));
				progressFill.style.width = '0%';

				const pullBtn = dom.append(row, dom.$('button.insrc-setup-btn.insrc-setup-btn-primary')) as HTMLButtonElement;
				pullBtn.textContent = 'Pull';
				pullBtn.onclick = () => {
					pullBtn.disabled = true;
					pullBtn.textContent = 'Pulling...';
					statusEl.textContent = 'Starting...';
					this._pullModel(model.name, statusEl, progressFill, pullBtn);
				};
			}
		}
	}

	private _pullModel(model: string, statusEl: HTMLElement, progressFill: HTMLElement, btn: HTMLButtonElement): void {
		const handle = this.daemonService.stream('ollama.pull', { model });

		handle.onMessage((msg) => {
			if (msg.type === 'progress') {
				const data = msg as unknown as { step: string; status: string };
				statusEl.textContent = data.step || 'Downloading...';
				// Parse percentage from step field (daemon sends pct in step)
				const pctMatch = data.step.match(/(\d+)/);
				if (pctMatch) {
					progressFill.style.width = `${pctMatch[1]}%`;
				}
			}
		});

		handle.onDidEnd(() => {
			statusEl.textContent = 'Installed';
			progressFill.style.width = '100%';
			btn.textContent = 'Done';
			btn.classList.remove('insrc-setup-btn-primary');
		});

		handle.onDidError((err) => {
			statusEl.textContent = `Error: ${err.message}`;
			btn.textContent = 'Retry';
			btn.disabled = false;
		});
	}

	// ---------------------------------------------------------------------------
	// Step 3: API Keys
	// ---------------------------------------------------------------------------

	private async _renderKeys(): Promise<void> {
		const intro = dom.append(this._stepContent, dom.$('p'));
		intro.textContent = 'Optional: add API keys for Claude and other services.';

		const existingKeys = await this.keychainService.listKeys();
		const anthropicExists = existingKeys.some(k => k.name === 'ANTHROPIC_API_KEY');

		// Anthropic key
		const row1 = dom.append(this._stepContent, dom.$('.insrc-setup-key-row'));
		const label1 = dom.append(row1, dom.$('.insrc-setup-key-label'));
		label1.textContent = 'Anthropic API Key';
		const input1 = dom.append(row1, dom.$('input.insrc-setup-key-input')) as HTMLInputElement;
		input1.type = 'password';
		input1.placeholder = anthropicExists ? '(already set)' : 'sk-ant-...';

		const saveBtn1 = dom.append(row1, dom.$('button.insrc-setup-btn.insrc-setup-btn-secondary')) as HTMLButtonElement;
		saveBtn1.textContent = 'Save';
		saveBtn1.onclick = async () => {
			if (input1.value.trim()) {
				await this.keychainService.setKey('ANTHROPIC_API_KEY', input1.value.trim());
				input1.value = '';
				input1.placeholder = '(saved)';
				saveBtn1.textContent = 'Saved';
			}
		};

		// Add custom key
		const addRow = dom.append(this._stepContent, dom.$('p'));
		addRow.style.marginTop = '16px';
		addRow.style.fontSize = '12px';
		addRow.style.color = 'var(--vscode-descriptionForeground)';
		addRow.textContent = 'Use "insrc: Manage Keys" from the command palette to add more keys later.';
	}

	// ---------------------------------------------------------------------------
	// Step 4: Done
	// ---------------------------------------------------------------------------

	private _renderDone(): void {
		const done = dom.append(this._stepContent, dom.$('.insrc-setup-done'));
		dom.append(done, dom.$('.codicon.codicon-pass-filled'));

		const h2 = dom.append(done, dom.$('h2'));
		h2.textContent = 'Setup Complete';

		const msg = dom.append(done, dom.$('p'));
		msg.textContent = 'insrc is ready. Start chatting with your codebase.';
		msg.style.color = 'var(--vscode-descriptionForeground)';
		msg.style.marginBottom = '24px';

		const chatBtn = dom.append(done, dom.$('button.insrc-setup-btn.insrc-setup-btn-primary')) as HTMLButtonElement;
		chatBtn.textContent = 'Open Chat';
		chatBtn.onclick = () => {
			this.commandService.executeCommand('insrc.openChat');
		};
	}

	// ---------------------------------------------------------------------------
	// Finish
	// ---------------------------------------------------------------------------

	private async _finish(): Promise<void> {
		// Apply recommended config
		if (this._recommendation) {
			const config = this._recommendation['config'] as Record<string, unknown> | undefined;
			if (config) {
				for (const [key, value] of Object.entries(config)) {
					try {
						await this.configService.setConfigValue(key, value);
					} catch {
						// best effort
					}
				}
			}
		}

		// Mark setup as complete
		this._storageService.store('insrc.setupComplete', 'true', StorageScope.APPLICATION, StorageTarget.MACHINE);

		// Open chat
		this.commandService.executeCommand('insrc.openChat');
	}

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	private _addRow(table: HTMLElement, label: string, value: string): void {
		const tr = dom.append(table, dom.$('tr'));
		const tdLabel = dom.append(tr, dom.$('td'));
		tdLabel.textContent = label;
		const tdValue = dom.append(tr, dom.$('td'));
		tdValue.textContent = value;
	}
}
