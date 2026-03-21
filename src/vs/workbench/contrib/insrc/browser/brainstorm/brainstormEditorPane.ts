/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import type { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IInsrcDaemonService } from '../../common/daemonService.js';
import { IInsrcChatService, type ChatEvent } from '../../common/chatService.js';
import { BrainstormEditorInput } from './brainstormEditorInput.js';
import { BrainstormCardWidget } from './brainstormCardWidget.js';

// ---------------------------------------------------------------------------
// Types for structured gate data
// ---------------------------------------------------------------------------

interface IdeaRef {
	type: 'code' | 'doc' | 'url';
	path: string;
	label: string;
	line?: number;
	snippet?: string;
}

interface BrainstormIdea {
	id: string;
	index: number;
	title: string;
	body: string;
	references: IdeaRef[];
	status: string;
	source: string;
	round: number;
	tags: string[];
	reviewVerdict?: string;
	reviewRationale?: string;
	userComment?: string;
}

interface BrainstormProgress {
	total: number;
	current: number;
	approved: number;
	rejected: number;
	parked: number;
	skipped: number;
	pending: number;
}

interface StructuredGateData {
	phase: string;
	itemType: string;
	itemId: string;
	item: BrainstormIdea;
	progress: BrainstormProgress;
}

// ---------------------------------------------------------------------------
// EditorPane
// ---------------------------------------------------------------------------

export class BrainstormEditorPane extends EditorPane {
	static readonly ID = 'insrc.brainstormEditorPane';

	private _container!: HTMLElement;
	private _header!: HTMLElement;
	private _headerTitle!: HTMLElement;
	private _headerPhase!: HTMLElement;
	private _addIdeaBtn!: HTMLButtonElement;

	private _cardArea!: HTMLElement;
	private _cardWidget: BrainstormCardWidget | undefined;

	private _specPanel!: HTMLElement;
	private _specContent!: HTMLElement;
	private _specVisible = false;

	private _progressBar!: HTMLElement;
	private _progressText!: HTMLElement;
	private _progressIcons!: HTMLElement;

	private _emptyState!: HTMLElement;

	private _phase: 'waiting' | 'ideation' | 'convergence' | 'preview' = 'waiting';
	private _ideas: BrainstormIdea[] = [];
	private _currentGateId: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@IInsrcChatService private readonly chatService: IInsrcChatService,
	) {
		super(BrainstormEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = dom.append(parent, dom.$('.insrc-brainstorm'));

		// Header
		this._header = dom.append(this._container, dom.$('.insrc-brainstorm-header'));
		const headerLeft = dom.append(this._header, dom.$('.insrc-brainstorm-header-left'));
		const iconEl = dom.append(headerLeft, dom.$('.insrc-brainstorm-header-icon'));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.lightbulb));
		this._headerTitle = dom.append(headerLeft, dom.$('h2.insrc-brainstorm-title'));
		this._headerTitle.textContent = 'Brainstorm';
		this._headerPhase = dom.append(headerLeft, dom.$('span.insrc-brainstorm-phase'));
		this._headerPhase.textContent = '';

		const headerRight = dom.append(this._header, dom.$('.insrc-brainstorm-header-right'));

		// Toggle spec panel button
		const toggleSpecBtn = dom.append(headerRight, dom.$('button.insrc-brainstorm-btn')) as HTMLButtonElement;
		toggleSpecBtn.title = 'Toggle spec panel';
		toggleSpecBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.splitHorizontal));
		this._register(dom.addDisposableListener(toggleSpecBtn, 'click', () => this._toggleSpec()));

		// Add idea button
		this._addIdeaBtn = dom.append(headerRight, dom.$('button.insrc-brainstorm-btn.primary')) as HTMLButtonElement;
		this._addIdeaBtn.textContent = '+ Add Idea';
		this._addIdeaBtn.title = 'Add your own idea';
		this._register(dom.addDisposableListener(this._addIdeaBtn, 'click', () => this._showAddIdeaForm()));

		// Main content area (card + spec panel side by side)
		const main = dom.append(this._container, dom.$('.insrc-brainstorm-main'));

		// Card area (left/center)
		this._cardArea = dom.append(main, dom.$('.insrc-brainstorm-card-area'));

		// Empty state
		this._emptyState = dom.append(this._cardArea, dom.$('.insrc-brainstorm-empty'));
		this._emptyState.textContent = 'Starting brainstorm session...';

		// Spec panel (right, hidden by default)
		this._specPanel = dom.append(main, dom.$('.insrc-brainstorm-spec-panel.hidden'));
		const specTitle = dom.append(this._specPanel, dom.$('.insrc-brainstorm-spec-title'));
		specTitle.textContent = 'Spec';
		this._specContent = dom.append(this._specPanel, dom.$('.insrc-brainstorm-spec-content'));
		this._specContent.textContent = 'Spec builds as ideas are promoted.';

		// Progress bar (bottom)
		this._progressBar = dom.append(this._container, dom.$('.insrc-brainstorm-progress'));
		this._progressIcons = dom.append(this._progressBar, dom.$('.insrc-brainstorm-progress-icons'));
		this._progressText = dom.append(this._progressBar, dom.$('.insrc-brainstorm-progress-text'));
		this._progressText.textContent = '';

		// Subscribe to chat events for brainstorm data
		this._registerStreamHandlers();
	}

	override async setInput(input: BrainstormEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this._headerTitle.textContent = `Brainstorm`;
		this._phase = 'waiting';
		this._emptyState.textContent = 'Waiting for ideas...';
		this._emptyState.classList.remove('hidden');
	}

	layout(dimension: dom.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}

	// ---------------------------------------------------------------------------
	// Stream handlers
	// ---------------------------------------------------------------------------

	private _registerStreamHandlers(): void {
		// Listen for gate events from chat service
		this._register(this.chatService.onDidReceiveEvent((event: ChatEvent) => {
			if (event.type === 'gate') {
				this._handleGate(event.gate);
			} else if (event.type === 'progress') {
				this._handleProgress(event.progress.step, event.progress.status);
			}
		}));
	}

	private _handleGate(gate: { gateId: string; actions: string[]; title?: string; context?: unknown }): void {
		const structured = gate.context as StructuredGateData | undefined;
		if (!structured || structured.phase !== 'ideation') {
			return; // Not a brainstorm gate
		}

		this._currentGateId = gate.gateId;
		this._phase = 'ideation';
		this._emptyState.classList.add('hidden');
		this._headerPhase.textContent = 'Ideation';

		const data = structured;

		// Track all ideas
		if (data.item) {
			const existing = this._ideas.find(i => i.id === data.item.id);
			if (!existing) {
				this._ideas.push(data.item);
			}
		}

		// Render the current idea card
		this._renderIdeaCard(data.item, gate.actions, data.progress);
	}

	private _handleProgress(step: string, status: string): void {
		if (this._phase === 'waiting' && (step.includes('brainstorm') || step.includes('seed') || step.includes('diverge') || step.includes('review'))) {
			this._emptyState.textContent = status || step;
		}
	}

	// ---------------------------------------------------------------------------
	// Card rendering
	// ---------------------------------------------------------------------------

	private _renderIdeaCard(idea: BrainstormIdea, actions: string[], progress: BrainstormProgress): void {
		// Clear previous card
		if (this._cardWidget) {
			this._cardWidget.dispose();
			this._cardWidget = undefined;
		}

		this._cardWidget = this.instantiationService.createInstance(
			BrainstormCardWidget,
			this._cardArea,
			{
				id: idea.id,
				title: idea.title,
				body: idea.body,
				references: idea.references,
				status: idea.status,
				tags: idea.tags,
				reviewVerdict: idea.reviewVerdict,
				reviewRationale: idea.reviewRationale,
			},
			actions,
			// Action callback
			(action: string, feedback?: string) => {
				if (this._currentGateId) {
					this.chatService.replyToGate(this._currentGateId, action, feedback);
				}
			},
			// Discuss callback
			(message: string) => {
				if (this._currentGateId) {
					this.chatService.replyToGate(this._currentGateId, 'respond', message);
				}
			},
		);

		// Update progress bar
		this._updateProgress(progress);
	}

	private _updateProgress(progress: BrainstormProgress): void {
		this._progressText.textContent =
			`Idea ${progress.current} of ${progress.total} | ` +
			`Approved: ${progress.approved} | Rejected: ${progress.rejected} | ` +
			`Parked: ${progress.parked}`;

		// Build icon strip
		dom.clearNode(this._progressIcons);
		for (let i = 0; i < progress.total; i++) {
			const dot = dom.append(this._progressIcons, dom.$('span.insrc-brainstorm-progress-dot'));
			if (i < progress.current - 1) {
				// Past ideas - show status
				const pastIdea = this._ideas[i];
				if (pastIdea) {
					dot.classList.add(`status-${pastIdea.status}`);
					dot.title = `${pastIdea.title} (${pastIdea.status})`;
				}
			} else if (i === progress.current - 1) {
				dot.classList.add('current');
				dot.title = 'Current';
			} else {
				dot.classList.add('pending');
				dot.title = 'Pending';
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Add idea
	// ---------------------------------------------------------------------------

	private _showAddIdeaForm(): void {
		// Simple inline form
		const form = dom.append(this._cardArea, dom.$('.insrc-brainstorm-add-form'));

		const titleInput = dom.append(form, dom.$('input.insrc-brainstorm-add-title')) as HTMLInputElement;
		titleInput.type = 'text';
		titleInput.placeholder = 'Idea title...';

		const bodyInput = dom.append(form, dom.$('textarea.insrc-brainstorm-add-body')) as HTMLTextAreaElement;
		bodyInput.placeholder = 'Description (optional)...';
		bodyInput.rows = 3;

		const btnRow = dom.append(form, dom.$('.insrc-brainstorm-add-btns'));
		const addBtn = dom.append(btnRow, dom.$('button.insrc-brainstorm-btn.primary')) as HTMLButtonElement;
		addBtn.textContent = 'Add';
		const cancelBtn = dom.append(btnRow, dom.$('button.insrc-brainstorm-btn')) as HTMLButtonElement;
		cancelBtn.textContent = 'Cancel';

		this._register(dom.addDisposableListener(cancelBtn, 'click', () => form.remove()));
		this._register(dom.addDisposableListener(addBtn, 'click', () => {
			const title = titleInput.value.trim();
			if (!title) { return; }
			const body = bodyInput.value.trim() || title;

			const input = this.input as BrainstormEditorInput;
			if (input) {
				this.daemonService.rpc('brainstorm.addIdea', {
					sessionId: input.sessionId,
					title,
					body,
				}).catch(() => { /* ignore */ });
			}
			form.remove();
		}));

		titleInput.focus();
	}

	// ---------------------------------------------------------------------------
	// Spec panel
	// ---------------------------------------------------------------------------

	private _toggleSpec(): void {
		this._specVisible = !this._specVisible;
		this._specPanel.classList.toggle('hidden', !this._specVisible);
	}
}
