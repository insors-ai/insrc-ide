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
import { createTrustedTypesPolicy } from '../../../../../../base/browser/trustedTypes.js';
import { IInsrcChatService } from '../../../common/chatService.js';
import {
	IInsrcBrainstormSessionService,
	type BrainstormGateKind,
	type BrainstormGateSnapshot,
} from '../../../common/brainstormSessionService.js';
import { BrainstormPaneBase } from './brainstormPaneBase.js';

// Item 44: daemon sends `gate.content` as rendered HTML (from
// renderMarkdown), so the "Promotions, merges and gaps" block has to
// go through a trusted-types policy; otherwise CSP makes us fall back
// to textContent and the user sees raw <ol>/<li>/<p> tags.
const ttPolicy = createTrustedTypesPolicy('insrcBrainstormThemes', {
	createHTML: (value: string) => value,
});

/**
 * Convergence review pane. Shows the clustered themes (from the session
 * service's accumulator) and the gate's raw content markdown for any
 * cluster-level notes (promotions / merges / gaps). Actions: approve /
 * edit (needs input) / diverge (needs input, loops back to ideation).
 */
export class BrainstormThemesPane extends BrainstormPaneBase {
	static readonly ID = 'insrc.brainstormThemesPane';

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
		super(BrainstormThemesPane.ID, group, telemetryService, themeService, storageService, chatService, sessionService, logService);
	}

	protected override get _paneTitle(): string { return 'Themes'; }
	protected override get _gateKind(): BrainstormGateKind { return 'convergence-review'; }

	protected override _renderGate(gate: BrainstormGateSnapshot): void {
		this.logService.info(`[brainstorm:pane:convergence-review] _renderGate gateId=${gate.gateId} actions=[${gate.actions.join(',')}]`);
		this._currentGateId = gate.gateId;
		dom.clearNode(this._cardArea);

		const panel = dom.append(this._cardArea, dom.$('.insrc-brainstorm-list-panel'));

		const themes = this.sessionService.themes;
		if (themes.length === 0) {
			const empty = dom.append(panel, dom.$('.insrc-brainstorm-empty'));
			empty.textContent = 'No themes clustered yet.';
		} else {
			for (const theme of themes) {
				const card = dom.append(panel, dom.$('.insrc-brainstorm-theme-card'));
				const title = dom.append(card, dom.$('h4.insrc-brainstorm-theme-title'));
				title.textContent = theme.name;
				if (theme.priority) {
					const priorityBadge = dom.append(title, dom.$('span.insrc-brainstorm-theme-priority'));
					priorityBadge.textContent = theme.priority;
				}
				const desc = dom.append(card, dom.$('.insrc-brainstorm-theme-desc'));
				desc.textContent = theme.description;
				const membership = dom.append(card, dom.$('.insrc-brainstorm-theme-members'));
				membership.textContent = `${theme.ideaIds.length} idea${theme.ideaIds.length === 1 ? '' : 's'}`;
			}
		}

		// Gate content is daemon-rendered HTML (promotions / merges /
		// gaps summary). Render via trusted types so markdown formats
		// (Item 44); fall back to preformatted text if CSP blocks.
		if (gate.content) {
			const details = dom.append(panel, dom.$('details.insrc-brainstorm-theme-details'));
			const summary = dom.append(details, dom.$('summary'));
			summary.textContent = 'Promotions, merges and gaps';
			if (ttPolicy) {
				const body = dom.append(details, dom.$('.insrc-brainstorm-theme-raw'));
				(body as HTMLElement).innerHTML = ttPolicy.createHTML(gate.content) as unknown as string;
			} else {
				const pre = dom.append(details, dom.$('pre.insrc-brainstorm-theme-raw'));
				pre.textContent = gate.content;
			}
		}

		// Actions
		const actions = dom.append(panel, dom.$('.insrc-brainstorm-list-actions'));
		for (const action of gate.actions) {
			const btn = dom.append(actions, dom.$('button.insrc-brainstorm-action-btn')) as HTMLButtonElement;
			btn.classList.add(`action-${action}`);
			btn.textContent = this._label(action);
			this._register(dom.addDisposableListener(btn, 'click', () => this._onActionClick(action, panel, actions)));
		}
	}

	private _onActionClick(action: string, panel: HTMLElement, actionsRow: HTMLElement): void {
		if (action === 'approve') {
			this._dispatch(action, undefined);
			return;
		}
		// edit / diverge both want feedback
		actionsRow.style.display = 'none';
		const prompt = dom.append(panel, dom.$('.insrc-brainstorm-prompt-panel'));
		const label = dom.append(prompt, dom.$('.insrc-brainstorm-prompt-label'));
		label.textContent = action === 'edit'
			? 'What changes do you want to the theme set?'
			: 'What direction for the next round?';
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
		this.logService.info(`[brainstorm:pane:convergence-review] _dispatch action=${action} feedbackLen=${feedback?.length ?? 0} gateId=${this._currentGateId}`);
		this.chatService.replyToGate(this._currentGateId, action, feedback).then(
			() => this.logService.info(`[brainstorm:pane:convergence-review] replyToGate resolved action=${action}`),
			err => this.logService.error(`[brainstorm:pane:convergence-review] replyToGate failed action=${action}: ${(err as Error).message}`),
		);
		dom.clearNode(this._cardArea);
		const waiting = dom.append(this._cardArea, dom.$('.insrc-brainstorm-submitting'));
		const msg = dom.append(waiting, dom.$('span'));
		msg.textContent = 'Submitting...';
	}

	private _label(action: string): string {
		switch (action) {
			case 'approve': return 'Approve themes';
			case 'edit': return 'Request edits';
			case 'diverge': return 'Back to ideation';
			default: return action;
		}
	}
}
