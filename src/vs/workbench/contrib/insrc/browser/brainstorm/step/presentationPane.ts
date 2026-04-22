/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import type { IEditorGroup } from '../../../../../services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { createTrustedTypesPolicy } from '../../../../../../base/browser/trustedTypes.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IInsrcChatService } from '../../../common/chatService.js';
import {
	IInsrcBrainstormSessionService,
	type BrainstormGateKind,
	type BrainstormGateSnapshot,
} from '../../../common/brainstormSessionService.js';
import { BrainstormPaneBase } from './brainstormPaneBase.js';

const ttPolicy = createTrustedTypesPolicy('insrcBrainstormPresentation', {
	createHTML: (value: string) => value,
});

/**
 * Final-stage pane. Shows the assembled HTML document and offers
 * Save / Skip. Save opens an inline form for format + path (the
 * backend expects a JSON feedback blob with those fields).
 */
export class BrainstormPresentationPane extends BrainstormPaneBase {
	static readonly ID = 'insrc.brainstormPresentationPane';

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
		super(BrainstormPresentationPane.ID, group, telemetryService, themeService, storageService, chatService, sessionService, logService);
	}

	protected override get _paneTitle(): string { return 'Final'; }
	protected override get _gateKind(): BrainstormGateKind { return 'presentation'; }

	protected override _renderGate(gate: BrainstormGateSnapshot): void {
		this.logService.info(`[brainstorm:pane:presentation] _renderGate gateId=${gate.gateId} actions=[${gate.actions.join(',')}]`);
		this._currentGateId = gate.gateId;
		dom.clearNode(this._cardArea);

		const panel = dom.append(this._cardArea, dom.$('.insrc-brainstorm-spec-panel-inline'));

		const title = dom.append(panel, dom.$('h3.insrc-brainstorm-spec-title'));
		title.textContent = 'Brainstorm complete';

		const preview = dom.append(panel, dom.$('.insrc-brainstorm-final-preview'));
		const content = gate.content ?? this.sessionService.finalDocument ?? '';
		// Gate content is HTML-rendered markdown from the daemon. Use trusted
		// types so CSP passes; the content comes from our own pipeline.
		// Item 51: if the policy isn't allowed by the CSP (name missing
		// from workbench.html's trusted-types allowlist) ttPolicy is
		// undefined. Do NOT fall back to raw innerHTML -- CSP rejects it
		// and the whole pane crashes with "This document requires
		// 'TrustedHTML' assignment" + falls back to errorEditor. Render
		// as preformatted text instead so the user at least sees the
		// assembled spec.
		if (ttPolicy) {
			preview.innerHTML = ttPolicy.createHTML(content) as unknown as string;
		} else {
			this.logService.warn(`[brainstorm:pane:presentation] ttPolicy unavailable; rendering as plain text`);
			const pre = dom.append(preview, dom.$('pre.insrc-brainstorm-final-preview-fallback'));
			pre.textContent = content;
		}

		const actions = dom.append(panel, dom.$('.insrc-brainstorm-list-actions'));
		for (const action of gate.actions) {
			const btn = dom.append(actions, dom.$('button.insrc-brainstorm-action-btn')) as HTMLButtonElement;
			btn.classList.add(`action-${action}`);
			btn.textContent = action === 'save' ? 'Save...' : action === 'skip' ? 'Discard' : action;
			this._register(dom.addDisposableListener(btn, 'click', () => this._onActionClick(action, panel, actions)));
		}
	}

	private _onActionClick(action: string, panel: HTMLElement, actionsRow: HTMLElement): void {
		if (action === 'skip') {
			this._dispatch('skip', undefined);
			return;
		}
		if (action !== 'save') {
			this._dispatch(action, undefined);
			return;
		}
		// Save form: format + path
		actionsRow.style.display = 'none';
		const form = dom.append(panel, dom.$('.insrc-brainstorm-prompt-panel'));
		const label = dom.append(form, dom.$('.insrc-brainstorm-prompt-label'));
		label.textContent = 'Save the brainstorm as:';

		const formatRow = dom.append(form, dom.$('.insrc-brainstorm-save-row'));
		const formatLabel = dom.append(formatRow, dom.$('span'));
		formatLabel.textContent = 'Format';
		const formatSelect = dom.append(formatRow, dom.$('select.insrc-brainstorm-save-select')) as HTMLSelectElement;
		for (const f of ['markdown', 'html']) {
			const opt = dom.append(formatSelect, dom.$('option')) as HTMLOptionElement;
			opt.value = f;
			opt.textContent = f;
		}

		const pathRow = dom.append(form, dom.$('.insrc-brainstorm-save-row'));
		const pathLabel = dom.append(pathRow, dom.$('span'));
		pathLabel.textContent = 'Path';
		const pathInput = dom.append(pathRow, dom.$('input.insrc-brainstorm-save-input')) as HTMLInputElement;
		pathInput.type = 'text';
		pathInput.placeholder = 'e.g. docs/brainstorm.md';

		const btnRow = dom.append(form, dom.$('.insrc-brainstorm-prompt-actions'));
		const cancelBtn = dom.append(btnRow, dom.$('button.insrc-brainstorm-btn')) as HTMLButtonElement;
		cancelBtn.textContent = 'Cancel';
		const sendBtn = dom.append(btnRow, dom.$('button.insrc-brainstorm-btn.primary')) as HTMLButtonElement;
		sendBtn.textContent = 'Save';

		this._register(dom.addDisposableListener(cancelBtn, 'click', () => {
			form.remove();
			actionsRow.style.display = '';
		}));
		this._register(dom.addDisposableListener(sendBtn, 'click', () => {
			const payload = JSON.stringify({ format: formatSelect.value, path: pathInput.value.trim() });
			this._dispatch('save', payload);
		}));
		setTimeout(() => pathInput.focus(), 0);
	}

	private _dispatch(action: string, feedback: string | undefined): void {
		if (!this._currentGateId) { return; }
		this.logService.info(`[brainstorm:pane:presentation] _dispatch action=${action} feedbackLen=${feedback?.length ?? 0} gateId=${this._currentGateId}`);
		this.chatService.replyToGate(this._currentGateId, action, feedback).then(
			() => this.logService.info(`[brainstorm:pane:presentation] replyToGate resolved action=${action}`),
			err => this.logService.error(`[brainstorm:pane:presentation] replyToGate failed action=${action}: ${(err as Error).message}`),
		);
	}
}
