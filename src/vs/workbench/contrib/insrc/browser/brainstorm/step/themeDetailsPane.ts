/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import type { IEditorGroup } from '../../../../../services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IInsrcChatService } from '../../../common/chatService.js';
import {
	IInsrcBrainstormSessionService,
	type BrainstormGateKind,
	type BrainstormGateSnapshot,
} from '../../../common/brainstormSessionService.js';
import { BrainstormPaneBase } from './brainstormPaneBase.js';
import { MarkdownRenderer } from '../../../../../../editor/browser/widget/markdownRenderer/browser/markdownRenderer.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';

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
	private _markdownRenderer: MarkdownRenderer | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IInsrcChatService chatService: IInsrcChatService,
		@IInsrcBrainstormSessionService sessionService: IInsrcBrainstormSessionService,
		@ILogService logService: ILogService,
	) {
		super(BrainstormThemeDetailsPane.ID, group, telemetryService, themeService, storageService, chatService, sessionService, logService);
	}

	private _getMarkdownRenderer(): MarkdownRenderer {
		if (!this._markdownRenderer) {
			this._markdownRenderer = this._register(this.instantiationService.createInstance(MarkdownRenderer, {}));
		}
		return this._markdownRenderer;
	}

	protected override get _paneTitle(): string { return 'Theme Spec'; }
	protected override get _gateKind(): BrainstormGateKind { return 'theme-spec'; }

	protected override _renderGate(gate: BrainstormGateSnapshot): void {
		this.logService.info(`[brainstorm:pane:theme-spec] _renderGate gateId=${gate.gateId} actions=[${gate.actions.join(',')}]`);
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

		// Item 52: render raw markdown via VS Code's MarkdownRenderer so
		// code fences get the editor's tokenizer-based syntax highlighting
		// and proper monospace / background styling. Fallback to daemon-
		// rendered HTML (gate.content) if for some reason the structured
		// payload didn't carry raw content.
		const body = dom.append(panel, dom.$('.insrc-brainstorm-spec-body.rendered-markdown-host'));
		const rawMarkdown = section.content;
		if (rawMarkdown) {
			const renderer = this._getMarkdownRenderer();
			const rendered = renderer.render(new MarkdownString(rawMarkdown));
			body.appendChild(rendered.element);
		} else {
			const pre = dom.append(body, dom.$('pre.insrc-brainstorm-spec-body-fallback'));
			pre.textContent = gate.content ?? '';
		}

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
		this.logService.info(`[brainstorm:pane:theme-spec] _dispatch action=${action} feedbackLen=${feedback?.length ?? 0} gateId=${this._currentGateId}`);
		this.chatService.replyToGate(this._currentGateId, action, feedback).then(
			() => this.logService.info(`[brainstorm:pane:theme-spec] replyToGate resolved action=${action}`),
			err => this.logService.error(`[brainstorm:pane:theme-spec] replyToGate failed action=${action}: ${(err as Error).message}`),
		);
		// Items 48 + 50: keep the current theme spec visible during the
		// inter-theme wait (search + generate + review for the NEXT
		// theme, ~100s each) and during the final assemble-spec phase
		// (~11min with no gate). Same pattern as Item 37. The pane will
		// be replaced naturally when the next theme-spec gate fires or
		// when the presentation gate opens the final-output pane.
		const existingPanel = this._cardArea.querySelector('.insrc-brainstorm-spec-panel-inline') as HTMLElement | null;
		if (existingPanel) {
			existingPanel.classList.add('insrc-brainstorm-submitting-dim');
			existingPanel.querySelectorAll('button').forEach(btn => { (btn as HTMLButtonElement).disabled = true; });
		}
		const working = dom.prepend(this._cardArea, dom.$('.insrc-brainstorm-submitting-strip'));
		const msg = dom.append(working, dom.$('span'));
		msg.textContent = action === 'approve'
			? 'Approved. Working on the next theme (or assembling the final doc)...'
			: action === 'edit'
				? 'Regenerating this theme spec with your feedback...'
				: 'Submitting...';
	}
}
