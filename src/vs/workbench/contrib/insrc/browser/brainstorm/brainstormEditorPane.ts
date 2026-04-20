/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/brainstorm.css';
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

interface BrainstormTheme {
	id: string;
	name: string;
	description: string;
	ideaIds: string[];
	status: string;
}

interface StructuredGateData {
	phase: string;
	itemType: string;
	itemId: string;
	item: BrainstormIdea | BrainstormTheme;
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
	private _headerCategory!: HTMLElement;
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
	private _themes: BrainstormTheme[] = [];
	private _currentGateId: string | undefined;
	private _currentIdeaIndex = 0;
	private _navPrevBtn!: HTMLButtonElement;
	private _navNextBtn!: HTMLButtonElement;
	private _navLabel!: HTMLElement;

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
		this._headerCategory = dom.append(headerLeft, dom.$('span.insrc-brainstorm-category'));
		this._headerCategory.textContent = '';
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

		// Navigation bar (prev/next for browsing decided ideas)
		const navBar = dom.append(this._container, dom.$('.insrc-brainstorm-nav'));
		this._navPrevBtn = dom.append(navBar, dom.$('button.insrc-brainstorm-nav-btn')) as HTMLButtonElement;
		this._navPrevBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronLeft));
		this._navPrevBtn.title = 'Previous idea';
		this._navPrevBtn.disabled = true;
		this._register(dom.addDisposableListener(this._navPrevBtn, 'click', () => this._navigatePrev()));

		this._navLabel = dom.append(navBar, dom.$('span.insrc-brainstorm-nav-label'));
		this._navLabel.textContent = '';

		this._navNextBtn = dom.append(navBar, dom.$('button.insrc-brainstorm-nav-btn')) as HTMLButtonElement;
		this._navNextBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronRight));
		this._navNextBtn.title = 'Next idea';
		this._navNextBtn.disabled = true;
		this._register(dom.addDisposableListener(this._navNextBtn, 'click', () => this._navigateNext()));

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
		this._headerCategory.textContent = '';
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

	private _handleGate(gate: { gateId: string; actions: string[]; title?: string; content?: string; context?: unknown }): void {
		const structured = gate.context as StructuredGateData | undefined;

		if (!structured) {
			// Non-structured gate (e.g. preview/presentation) -- show content as HTML
			if (gate.content && (gate.title?.includes('preview') || gate.title?.includes('Preview') || gate.title?.includes('presentation'))) {
				this._showPreview(gate.content);
				this._currentGateId = gate.gateId;
			}
			return;
		}

		if (structured.phase === 'convergence') {
			this._handleConvergenceGate(gate);
			return;
		}

		if (structured.phase !== 'ideation') {
			return; // Unknown phase
		}

		this._currentGateId = gate.gateId;
		this._phase = 'ideation';
		this._emptyState.classList.add('hidden');
		this._headerPhase.textContent = 'Ideation';

		const data = structured;

		// Track all ideas (only for ideation phase, item is BrainstormIdea)
		const idea = data.item as BrainstormIdea;
		if (idea && idea.title) {
			const existingIdx = this._ideas.findIndex(i => i.id === idea.id);
			if (existingIdx >= 0) {
				this._ideas[existingIdx] = idea; // Update existing
				this._currentIdeaIndex = existingIdx;
			} else {
				this._ideas.push(idea);
				this._currentIdeaIndex = this._ideas.length - 1;
			}
			this._updateNavButtons();
		}

		// Render the current idea card
		this._renderIdeaCard(idea, gate.actions, data.progress);
	}

	private _handleProgress(step: string, status: string): void {
		// "Intent: brainstorm/general" messages drive the category badge, not the
		// empty-state body. The primary intent (brainstorm) is implicit from the
		// pane itself -- only the sub-intent is worth showing.
		const intentMatch = step.match(/^Intent:\s*\w+\/(\w+)/);
		if (intentMatch) {
			this._headerCategory.textContent = intentMatch[1]!;
			return;
		}

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
	// Navigation (prev/next through decided ideas)
	// ---------------------------------------------------------------------------

	private _navigatePrev(): void {
		if (this._currentIdeaIndex > 0) {
			this._currentIdeaIndex--;
			this._showIdeaAtIndex(this._currentIdeaIndex);
		}
	}

	private _navigateNext(): void {
		if (this._currentIdeaIndex < this._ideas.length - 1) {
			this._currentIdeaIndex++;
			this._showIdeaAtIndex(this._currentIdeaIndex);
		}
	}

	private _showIdeaAtIndex(index: number): void {
		const idea = this._ideas[index];
		if (!idea) { return; }

		this._updateNavButtons();

		// Show as read-only card (no action buttons) for decided ideas
		const isDecided = idea.status === 'accepted' || idea.status === 'rejected' || idea.status === 'parked';
		const actions = isDecided
			? ['reopen']  // Only reopen action for decided ideas
			: ['approve', 'reject', 'diverge', 'skip', 'park', 'discuss'];

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
			(action: string, feedback?: string) => {
				if (action === 'reopen') {
					// Reopen: change status back to proposed and re-present as active
					idea.status = 'proposed';
					this._showIdeaAtIndex(index);
				} else if (this._currentGateId) {
					this.chatService.replyToGate(this._currentGateId, action, feedback);
				}
			},
			(message: string) => {
				if (this._currentGateId) {
					this.chatService.replyToGate(this._currentGateId, 'respond', message);
				}
			},
		);
	}

	private _updateNavButtons(): void {
		this._navPrevBtn.disabled = this._currentIdeaIndex <= 0;
		this._navNextBtn.disabled = this._currentIdeaIndex >= this._ideas.length - 1;
		this._navLabel.textContent = this._ideas.length > 0
			? `${this._currentIdeaIndex + 1} / ${this._ideas.length}`
			: '';
	}

	// ---------------------------------------------------------------------------
	// Convergence phase (theme cards)
	// ---------------------------------------------------------------------------

	private _handleConvergenceGate(gate: { gateId: string; actions: string[]; context?: unknown }): void {
		const structured = gate.context as StructuredGateData | undefined;
		if (!structured || structured.itemType !== 'theme') { return; }

		this._currentGateId = gate.gateId;
		this._phase = 'convergence';
		this._headerPhase.textContent = 'Convergence';
		this._emptyState.classList.add('hidden');

		const theme = structured.item as BrainstormTheme;

		// Track themes
		const existingIdx = this._themes.findIndex(t => t.id === theme.id);
		if (existingIdx >= 0) {
			this._themes[existingIdx] = theme;
		} else {
			this._themes.push(theme);
		}

		// Find ideas belonging to this theme
		const themeIdeas = theme.ideaIds
			.map(id => this._ideas.find(i => i.id === id))
			.filter((i): i is BrainstormIdea => i !== undefined);

		// Render theme as a card with merged ideas listed
		if (this._cardWidget) {
			this._cardWidget.dispose();
			this._cardWidget = undefined;
		}

		const themeBody = [
			theme.description,
			'',
			'**Merged Ideas:**',
			...themeIdeas.map(i => `- ${i.title}`),
		].join('\n');

		this._cardWidget = this.instantiationService.createInstance(
			BrainstormCardWidget,
			this._cardArea,
			{
				id: theme.id,
				title: theme.name,
				body: themeBody,
				references: [],
				status: theme.status,
				tags: [],
			},
			gate.actions,
			(action: string, feedback?: string) => {
				if (this._currentGateId) {
					this.chatService.replyToGate(this._currentGateId, action, feedback);
				}
			},
			(message: string) => {
				if (this._currentGateId) {
					this.chatService.replyToGate(this._currentGateId, 'respond', message);
				}
			},
		);

		this._updateProgress(structured.progress);
	}

	// ---------------------------------------------------------------------------
	// Preview phase (final document)
	// ---------------------------------------------------------------------------

	private _showPreview(content: string): void {
		this._phase = 'preview';
		this._headerPhase.textContent = 'Preview';
		this._emptyState.classList.add('hidden');

		if (this._cardWidget) {
			this._cardWidget.dispose();
			this._cardWidget = undefined;
		}

		dom.clearNode(this._cardArea);
		const previewCard = dom.append(this._cardArea, dom.$('.insrc-brainstorm-card'));
		const previewBody = dom.append(previewCard, dom.$('.insrc-brainstorm-card-body'));
		previewBody.innerHTML = content;

		// Show in spec panel too
		this._specContent.innerHTML = content;
		if (!this._specVisible) {
			this._toggleSpec();
		}
	}

	// ---------------------------------------------------------------------------
	// Spec panel
	// ---------------------------------------------------------------------------

	private _toggleSpec(): void {
		this._specVisible = !this._specVisible;
		this._specPanel.classList.toggle('hidden', !this._specVisible);
	}

	appendSpecSection(html: string): void {
		const section = dom.append(this._specContent, dom.$('div'));
		section.innerHTML = html;
	}
}
