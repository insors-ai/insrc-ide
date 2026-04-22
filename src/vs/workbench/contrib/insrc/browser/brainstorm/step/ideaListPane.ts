/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import type { IEditorGroup } from '../../../../../services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IInsrcChatService } from '../../../common/chatService.js';
import {
	IInsrcBrainstormSessionService,
	type BrainstormGateKind,
	type BrainstormGateSnapshot,
} from '../../../common/brainstormSessionService.js';
import { BrainstormPaneBase } from './brainstormPaneBase.js';

/**
 * Idea-list pane: reached after the queue empties (or when the threshold
 * for auto-converge hasn't been hit yet). Shows every idea with its
 * current status and offers bulk actions: Accept remaining, Diverge,
 * Converge now.
 *
 * Diverge is input-requiring (optional direction text); Accept/Converge
 * are single-shot.
 */
export class BrainstormIdeaListPane extends BrainstormPaneBase {
	static readonly ID = 'insrc.brainstormIdeaListPane';

	private _currentGateId: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInsrcChatService chatService: IInsrcChatService,
		@IInsrcBrainstormSessionService sessionService: IInsrcBrainstormSessionService,
		@ILogService logService: ILogService,
	) {
		super(BrainstormIdeaListPane.ID, group, telemetryService, themeService, storageService, chatService, sessionService, logService);
	}

	protected override get _paneTitle(): string { return 'Ideas'; }
	protected override get _gateKind(): BrainstormGateKind { return 'idea-list'; }

	protected override _renderGate(gate: BrainstormGateSnapshot): void {
		this.logService.info(`[brainstorm:pane:idea-list] _renderGate gateId=${gate.gateId} actions=[${gate.actions.join(',')}]`);
		this._currentGateId = gate.gateId;
		dom.clearNode(this._cardArea);

		const panel = dom.append(this._cardArea, dom.$('.insrc-brainstorm-list-panel'));

		// Ideas list
		const ideas = this.sessionService.ideas;
		if (ideas.length === 0) {
			const empty = dom.append(panel, dom.$('.insrc-brainstorm-empty'));
			empty.textContent = 'No ideas to show yet.';
		} else {
			const list = dom.append(panel, dom.$('ul.insrc-brainstorm-list'));
			for (const idea of ideas) {
				const li = dom.append(list, dom.$('li.insrc-brainstorm-list-item'));
				const badge = dom.append(li, dom.$(`span.insrc-brainstorm-list-status.status-${idea.status}`));
				badge.textContent = idea.status;
				const title = dom.append(li, dom.$('span.insrc-brainstorm-list-title'));
				title.textContent = idea.title;
			}
		}

		// Actions row (bulk). Diverge wants optional feedback, so we give
		// it its own inline prompt toggle; others dispatch immediately.
		const actions = dom.append(panel, dom.$('.insrc-brainstorm-list-actions'));
		for (const action of gate.actions) {
			const btn = dom.append(actions, dom.$('button.insrc-brainstorm-action-btn')) as HTMLButtonElement;
			btn.classList.add(`action-${action}`);
			btn.textContent = this._label(action);
			btn.title = this._tooltip(action);
			this._register(dom.addDisposableListener(btn, 'click', () => this._onActionClick(action, panel, actions)));
		}
	}

	private _onActionClick(action: string, panel: HTMLElement, actionsRow: HTMLElement): void {
		if (action === 'diverge') {
			// Open inline prompt; cancel restores the action row.
			actionsRow.style.display = 'none';
			const prompt = dom.append(panel, dom.$('.insrc-brainstorm-prompt-panel'));
			const label = dom.append(prompt, dom.$('.insrc-brainstorm-prompt-label'));
			label.textContent = 'What direction for the next round? (optional)';
			const textarea = dom.append(prompt, dom.$('textarea.insrc-brainstorm-prompt-textarea')) as HTMLTextAreaElement;
			textarea.rows = 3;
			const btnRow = dom.append(prompt, dom.$('.insrc-brainstorm-prompt-actions'));
			const cancelBtn = dom.append(btnRow, dom.$('button.insrc-brainstorm-btn')) as HTMLButtonElement;
			cancelBtn.textContent = 'Cancel';
			const sendBtn = dom.append(btnRow, dom.$('button.insrc-brainstorm-btn.primary')) as HTMLButtonElement;
			sendBtn.textContent = 'Send';
			this._register(dom.addDisposableListener(cancelBtn, 'click', () => {
				prompt.remove();
				actionsRow.style.display = '';
			}));
			this._register(dom.addDisposableListener(sendBtn, 'click', () => {
				this._dispatch(action, textarea.value.trim() || undefined);
			}));
			setTimeout(() => textarea.focus(), 0);
		} else {
			this._dispatch(action, undefined);
		}
	}

	private _dispatch(action: string, feedback: string | undefined): void {
		if (!this._currentGateId) { return; }
		this.logService.info(`[brainstorm:pane:idea-list] _dispatch action=${action} feedbackLen=${feedback?.length ?? 0} gateId=${this._currentGateId}`);
		this.chatService.replyToGate(this._currentGateId, action, feedback).then(
			() => this.logService.info(`[brainstorm:pane:idea-list] replyToGate resolved action=${action}`),
			err => this.logService.error(`[brainstorm:pane:idea-list] replyToGate failed action=${action}: ${(err as Error).message}`),
		);
		// Item 37: keep the idea list rendered while the pipeline runs
		// cluster + promote + validate (~30s on converge). Clearing the
		// pane immediately leaves the user staring at a blank screen.
		// Instead, pin a transient "Working..." strip at the top and
		// dim the existing panel. The convergence-review gate opens a
		// different pane (themes) which replaces this editor when ready.
		const existingPanel = this._cardArea.querySelector('.insrc-brainstorm-list-panel') as HTMLElement | null;
		if (existingPanel) {
			existingPanel.classList.add('insrc-brainstorm-submitting-dim');
			// Disable all action buttons so repeated clicks can't fire.
			existingPanel.querySelectorAll('button').forEach(btn => { (btn as HTMLButtonElement).disabled = true; });
		}
		const working = dom.prepend(this._cardArea, dom.$('.insrc-brainstorm-submitting-strip'));
		const msg = dom.append(working, dom.$('span'));
		msg.textContent = action === 'converge'
			? 'Clustering ideas into themes...'
			: action === 'diverge'
				? 'Generating more ideas...'
				: 'Submitting...';
	}

	private _label(action: string): string {
		switch (action) {
			case 'accept-remaining': return 'Accept remaining';
			case 'diverge': return 'Diverge';
			case 'converge': return 'Converge now';
			default: return action;
		}
	}

	private _tooltip(action: string): string {
		switch (action) {
			case 'accept-remaining': return 'Auto-accept every proposed idea and move on';
			case 'diverge': return 'Generate more ideas before moving on';
			case 'converge': return 'Cluster accepted ideas into themes';
			default: return '';
		}
	}
}
