/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import type { IEditorGroup } from '../../../../../services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { IInsrcChatService } from '../../../common/chatService.js';
import {
	IInsrcBrainstormSessionService,
	type BrainstormGateKind,
	type BrainstormGateSnapshot,
} from '../../../common/brainstormSessionService.js';
import { BrainstormPaneBase } from './brainstormPaneBase.js';

interface ThemeSpecItem {
	themeIndex: number;
	themeName: string;
	themeId?: string;
	content: string;
}

/**
 * Theme-spec review pane. One gate per theme: user approves the polished
 * section or requests edits (which loops back through the generation
 * task with their feedback).
 */
export class BrainstormThemeDetailsPane extends BrainstormPaneBase {
	static readonly ID = 'insrc.brainstormThemeDetailsPane';

	private _currentGateId: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInsrcChatService chatService: IInsrcChatService,
		@IInsrcBrainstormSessionService sessionService: IInsrcBrainstormSessionService,
	) {
		super(BrainstormThemeDetailsPane.ID, group, telemetryService, themeService, storageService, chatService, sessionService);
	}

	protected override get _paneTitle(): string { return 'Theme Spec'; }
	protected override get _gateKind(): BrainstormGateKind { return 'theme-spec'; }

	protected override _renderGate(gate: BrainstormGateSnapshot): void {
		this._currentGateId = gate.gateId;
		dom.clearNode(this._cardArea);

		const section = gate.item as ThemeSpecItem | undefined;
		if (!section) {
			const empty = dom.append(this._cardArea, dom.$('.insrc-brainstorm-empty'));
			empty.textContent = 'Theme-spec gate missing item payload.';
			return;
		}

		const panel = dom.append(this._cardArea, dom.$('.insrc-brainstorm-spec-panel-inline'));

		const title = dom.append(panel, dom.$('h3.insrc-brainstorm-spec-title'));
		title.textContent = section.themeName;
		if (section.themeId) {
			const id = dom.append(title, dom.$('span.insrc-brainstorm-spec-theme-id'));
			id.textContent = ` (${section.themeId})`;
		}

		const body = dom.append(panel, dom.$('pre.insrc-brainstorm-spec-body'));
		body.textContent = section.content;

		// Actions
		const actions = dom.append(panel, dom.$('.insrc-brainstorm-list-actions'));
		for (const action of gate.actions) {
			const btn = dom.append(actions, dom.$('button.insrc-brainstorm-action-btn')) as HTMLButtonElement;
			btn.classList.add(`action-${action}`);
			btn.textContent = action === 'approve' ? 'Approve' : action === 'edit' ? 'Request edits' : action;
			this._register(dom.addDisposableListener(btn, 'click', () => this._onActionClick(action, panel, actions)));
		}
	}

	private _onActionClick(action: string, panel: HTMLElement, actionsRow: HTMLElement): void {
		if (action === 'approve') {
			this._dispatch(action, undefined);
			return;
		}
		actionsRow.style.display = 'none';
		const prompt = dom.append(panel, dom.$('.insrc-brainstorm-prompt-panel'));
		const label = dom.append(prompt, dom.$('.insrc-brainstorm-prompt-label'));
		label.textContent = 'What should change in this theme spec?';
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
	}

	private _dispatch(action: string, feedback: string | undefined): void {
		if (!this._currentGateId) { return; }
		this.chatService.replyToGate(this._currentGateId, action, feedback);
		dom.clearNode(this._cardArea);
		const waiting = dom.append(this._cardArea, dom.$('.insrc-brainstorm-submitting'));
		const msg = dom.append(waiting, dom.$('span'));
		msg.textContent = 'Submitting...';
	}
}
