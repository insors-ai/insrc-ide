/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/brainstorm.css';
import * as dom from '../../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { IEditorOpenContext } from '../../../../../common/editor.js';
import type { IEditorGroup } from '../../../../../services/editor/common/editorGroupsService.js';
import { EditorPane } from '../../../../../browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { IEditorOptions } from '../../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IInsrcChatService } from '../../../common/chatService.js';
import { IInsrcDaemonService } from '../../../common/daemonService.js';
import {
	IInsrcBrainstormSessionService,
	type BrainstormGateSnapshot,
	type BrainstormIdea,
} from '../../../common/brainstormSessionService.js';
import { BrainstormCardWidget } from '../brainstormCardWidget.js';
import { BrainstormIdeasInput } from './ideasInput.js';

/**
 * Per-idea review pane. Renders whichever single idea the controller is
 * currently asking the user to decide on. Reads the active gate from the
 * shared session service, so swapping gates within a session is a re-render
 * rather than a re-open.
 */
export class BrainstormIdeasPane extends EditorPane {
	static readonly ID = 'insrc.brainstormIdeasPane';

	private _container!: HTMLElement;
	private _headerCategory!: HTMLElement;
	private _headerProgress!: HTMLElement;
	private _addIdeaBtn!: HTMLButtonElement;
	private _cardArea!: HTMLElement;
	private _emptyState!: HTMLElement;
	private _addIdeaFormEl: HTMLElement | undefined;

	private _cardWidget: BrainstormCardWidget | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IInsrcChatService private readonly chatService: IInsrcChatService,
		@IInsrcBrainstormSessionService private readonly sessionService: IInsrcBrainstormSessionService,
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
	) {
		super(BrainstormIdeasPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = dom.append(parent, dom.$('.insrc-brainstorm'));

		// Header
		const header = dom.append(this._container, dom.$('.insrc-brainstorm-header'));
		const headerLeft = dom.append(header, dom.$('.insrc-brainstorm-header-left'));
		const iconEl = dom.append(headerLeft, dom.$('.insrc-brainstorm-header-icon'));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.lightbulb));
		const titleEl = dom.append(headerLeft, dom.$('h2.insrc-brainstorm-title'));
		titleEl.textContent = 'Ideas';
		this._headerCategory = dom.append(headerLeft, dom.$('span.insrc-brainstorm-category'));
		this._headerCategory.textContent = this.sessionService.category ?? '';
		this._headerProgress = dom.append(headerLeft, dom.$('span.insrc-brainstorm-phase'));
		this._headerProgress.textContent = '';

		// Header right -- "+ Add Idea" button. Enabled only while we're in the
		// ideation phase (the daemon's brainstorm.addIdea RPC pushes into the
		// review queue, which is meaningless after convergence starts).
		const headerRight = dom.append(header, dom.$('.insrc-brainstorm-header-right'));
		this._addIdeaBtn = dom.append(headerRight, dom.$('button.insrc-brainstorm-btn.primary')) as HTMLButtonElement;
		this._addIdeaBtn.textContent = '+ Add Idea';
		this._addIdeaBtn.title = 'Add your own idea to the review queue';
		this._addIdeaBtn.disabled = true;
		this._register(dom.addDisposableListener(this._addIdeaBtn, 'click', () => this._showAddIdeaForm()));

		// Card area
		const main = dom.append(this._container, dom.$('.insrc-brainstorm-main'));
		this._cardArea = dom.append(main, dom.$('.insrc-brainstorm-card-area'));
		this._emptyState = dom.append(this._cardArea, dom.$('.insrc-brainstorm-empty'));
		this._emptyState.textContent = 'Waiting for an idea to review...';

		// Re-render whenever a new gate arrives (could be the next idea, or a
		// refreshed version of the current one after discussion). Phase changes
		// to something non-ideation are handled by the flow contribution, which
		// will swap us out for a different pane.
		this._register(this.sessionService.onDidChangeActiveGate(gate => {
			if (gate.kind === 'idea') {
				this._render(gate);
			}
			this._updateAddIdeaState();
		}));

		this._register(this.sessionService.onDidChange(() => {
			this._headerCategory.textContent = this.sessionService.category ?? '';
			this._updateAddIdeaState();
		}));
		this._updateAddIdeaState();
	}

	private _updateAddIdeaState(): void {
		if (!this._addIdeaBtn) { return; }
		// Only meaningful during the ideation phase. We keep the button visible
		// (per the design doc's resolved decision) but disable it outside that
		// window so users don't lose the affordance between sessions.
		const active = this.sessionService.isSessionActive
			&& this.sessionService.phase === 'ideation';
		this._addIdeaBtn.disabled = !active;
		this._addIdeaBtn.title = active
			? 'Add your own idea to the review queue'
			: 'Add idea is only available during the ideation phase';
	}

	override async setInput(input: BrainstormIdeasInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		const gate = this.sessionService.activeGate;
		if (gate && gate.kind === 'idea') {
			this._render(gate);
		}
	}

	layout(dimension: dom.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}

	// ---------------------------------------------------------------------------
	// Rendering
	// ---------------------------------------------------------------------------

	private _render(gate: BrainstormGateSnapshot): void {
		const idea = gate.item as BrainstormIdea | undefined;
		if (!idea || !idea.title) {
			// Gate arrived without an idea payload -- surface a neutral state
			// rather than crashing the pane.
			this._emptyState.textContent = 'Idea payload missing.';
			this._emptyState.classList.remove('hidden');
			return;
		}
		this._emptyState.classList.add('hidden');

		this._updateProgress(gate);

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
				references: idea.references.map(r => ({ ...r })),
				status: idea.status,
				tags: [...idea.tags],
				reviewVerdict: idea.reviewVerdict,
				reviewRationale: idea.reviewRationale,
			},
			gate.actions.slice(),
			(action, feedback) => {
				this.chatService.replyToGate(gate.gateId, action, feedback);
				// `approve`/`reject` consume the slot, so when the user decides
				// the last pending idea we've finished ideation and should give
				// them a clear "hand-off" state rather than leaving the now-stale
				// card visible while the backend computes themes. `skip`/`park`
				// re-queue the idea, so they don't count as finishing.
				if (this._wasFinalDecision(gate, action)) {
					this._showCompletionState(gate, action);
				}
			},
		);
	}

	private _wasFinalDecision(gate: BrainstormGateSnapshot, action: string): boolean {
		if (action !== 'approve' && action !== 'reject') { return false; }
		const p = gate.progress;
		if (!p) { return false; }
		const current = p['current'] ?? 0;
		const total = p['total'] ?? 0;
		// Backend reports pending = ideas left after this one; some categories
		// omit that and only set current/total. Treat either signal as "last".
		const pending = p['pending'];
		if (pending !== undefined) { return pending <= 0; }
		return total > 0 && current >= total;
	}

	private _showCompletionState(gate: BrainstormGateSnapshot, action: string): void {
		if (this._cardWidget) {
			this._cardWidget.dispose();
			this._cardWidget = undefined;
		}
		dom.clearNode(this._cardArea);

		const banner = dom.append(this._cardArea, dom.$('.insrc-brainstorm-completion'));

		const titleEl = dom.append(banner, dom.$('h3.insrc-brainstorm-completion-title'));
		titleEl.textContent = 'All ideas reviewed';

		// The backend's progress counters are the source of truth, but they
		// reflect state BEFORE the reply we just sent -- the next gate with
		// updated numbers hasn't arrived yet. Apply the just-taken action to
		// the appropriate bucket so the banner shows the true post-action
		// state. (Reading from sessionService.ideas would undercount because
		// the current idea's local status is still 'proposed' until the
		// backend echoes the update.)
		const p = gate.progress ?? {};
		const base = {
			approved: p['approved'] ?? 0,
			rejected: p['rejected'] ?? 0,
			parked: p['parked'] ?? 0,
			skipped: p['skipped'] ?? 0,
		};
		if (action === 'approve') { base.approved += 1; }
		else if (action === 'reject') { base.rejected += 1; }
		else if (action === 'park') { base.parked += 1; }
		else if (action === 'skip') { base.skipped += 1; }
		const total = p['total'] ?? (base.approved + base.rejected + base.parked + base.skipped);

		const counts = dom.append(banner, dom.$('.insrc-brainstorm-completion-counts'));
		const pill = (label: string, n: number, modifier: string): void => {
			const el = dom.append(counts, dom.$(`span.insrc-brainstorm-completion-pill.${modifier}`));
			el.textContent = `${label}: ${n}`;
		};
		pill('Approved', base.approved, 'approved');
		pill('Rejected', base.rejected, 'rejected');
		pill('Parked', base.parked, 'parked');
		pill('Skipped', base.skipped, 'skipped');
		pill('Total', total, 'total');

		const note = dom.append(banner, dom.$('p.insrc-brainstorm-completion-note'));
		const spinner = dom.append(note, dom.$('span.insrc-brainstorm-completion-spinner'));
		spinner.classList.add(...ThemeIcon.asClassNameArray(Codicon.loading), 'codicon-modifier-spin');
		const msg = dom.append(note, dom.$('span'));
		msg.textContent = 'Preparing next step...';
	}

	private _updateProgress(gate: BrainstormGateSnapshot): void {
		const p = gate.progress ?? {};
		const total = p['total'] ?? 0;
		const current = p['current'] ?? 0;
		const approved = p['approved'] ?? 0;
		const rejected = p['rejected'] ?? 0;
		const parked = p['parked'] ?? 0;
		const skipped = p['skipped'] ?? 0;
		// Prefer the backend's own `pending` count; fall back to a derived
		// value so unrelated categories still render a meaningful remainder.
		const pending = p['pending'] ?? Math.max(total - approved - rejected - parked - skipped, 0);

		const parts: string[] = [];
		if (total) { parts.push(`${current}/${total}`); }
		parts.push(`approved ${approved}`);
		parts.push(`rejected ${rejected}`);
		parts.push(`parked ${parked}`);
		parts.push(`skipped ${skipped}`);
		parts.push(`pending ${pending}`);
		this._headerProgress.textContent = parts.join(' | ');
	}

	// ---------------------------------------------------------------------------
	// Add idea form
	// ---------------------------------------------------------------------------

	private _showAddIdeaForm(): void {
		if (this._addIdeaFormEl) { return; }

		const form = dom.append(this._cardArea, dom.$('.insrc-brainstorm-add-idea-form'));
		this._addIdeaFormEl = form;

		const titleLabel = dom.append(form, dom.$('label.insrc-brainstorm-add-idea-label'));
		titleLabel.textContent = 'Title';
		const titleInput = dom.append(form, dom.$('input.insrc-brainstorm-add-idea-title')) as HTMLInputElement;
		titleInput.type = 'text';
		titleInput.maxLength = 200;
		titleInput.placeholder = 'Short idea title';

		const bodyLabel = dom.append(form, dom.$('label.insrc-brainstorm-add-idea-label'));
		bodyLabel.textContent = 'Body (optional)';
		const bodyInput = dom.append(form, dom.$('textarea.insrc-brainstorm-add-idea-body')) as HTMLTextAreaElement;
		bodyInput.rows = 4;
		bodyInput.maxLength = 4000;
		bodyInput.placeholder = 'Details, context, or examples';

		const errorEl = dom.append(form, dom.$('.insrc-brainstorm-add-idea-error.hidden'));

		const btnRow = dom.append(form, dom.$('.insrc-brainstorm-add-idea-actions'));
		const cancelBtn = dom.append(btnRow, dom.$('button.insrc-brainstorm-btn')) as HTMLButtonElement;
		cancelBtn.textContent = 'Cancel';
		const submitBtn = dom.append(btnRow, dom.$('button.insrc-brainstorm-btn.primary')) as HTMLButtonElement;
		submitBtn.textContent = 'Add idea';
		submitBtn.disabled = true;

		const revalidate = (): void => {
			submitBtn.disabled = titleInput.value.trim().length === 0;
		};
		this._register(dom.addDisposableListener(titleInput, 'input', revalidate));

		this._register(dom.addDisposableListener(cancelBtn, 'click', () => this._closeAddIdeaForm()));
		this._register(dom.addDisposableListener(submitBtn, 'click', async () => {
			const title = titleInput.value.trim();
			const body = bodyInput.value.trim() || title;
			if (!title) { return; }
			submitBtn.disabled = true;
			errorEl.classList.add('hidden');
			try {
				await this._submitAddIdea(title, body);
				this._closeAddIdeaForm();
			} catch (err) {
				errorEl.textContent = `Couldn't add idea: ${(err as Error).message || 'unknown error'}`;
				errorEl.classList.remove('hidden');
				submitBtn.disabled = false;
			}
		}));

		setTimeout(() => titleInput.focus(), 0);
	}

	private _closeAddIdeaForm(): void {
		if (!this._addIdeaFormEl) { return; }
		this._addIdeaFormEl.remove();
		this._addIdeaFormEl = undefined;
	}

	private async _submitAddIdea(title: string, body: string): Promise<void> {
		const sessionId = this.chatService.activeSessionId;
		if (!sessionId) { throw new Error('no active session'); }
		await this.daemonService.rpc('brainstorm.addIdea', { sessionId, title, body });
	}
}
