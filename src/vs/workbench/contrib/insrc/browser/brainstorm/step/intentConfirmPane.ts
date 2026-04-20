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

const VALID_INTENTS: readonly string[] = [
	'implement', 'refactor', 'test', 'debug', 'review', 'document',
	'research', 'code-analysis', 'plan', 'requirements', 'design',
	'brainstorm', 'deploy', 'release', 'infra',
];

/**
 * Intent-confirm pane (Item 8a): fires when the daemon emits an
 * `intent-confirm` gate before running the agent pipeline. Shows the
 * classified intent, confidence, and reasoning, and lets the user
 * Proceed, Use different intent (with a dropdown), or Cancel the turn.
 */
export class BrainstormIntentConfirmPane extends BrainstormPaneBase {
	static readonly ID = 'insrc.brainstormIntentConfirmPane';

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
		super(BrainstormIntentConfirmPane.ID, group, telemetryService, themeService, storageService, chatService, sessionService, logService);
	}

	protected override get _paneTitle(): string { return 'Confirm intent'; }
	protected override get _gateKind(): BrainstormGateKind { return 'intent-confirm'; }

	protected override _renderGate(gate: BrainstormGateSnapshot): void {
		this.logService.info(`[brainstorm:pane:intent-confirm] _renderGate gateId=${gate.gateId} actions=[${gate.actions.join(',')}]`);
		this._currentGateId = gate.gateId;
		dom.clearNode(this._cardArea);

		const item = (gate.item ?? {}) as { intent?: string; confidence?: number; reasoning?: string };
		const intent = item.intent ?? 'unknown';
		const confidence = typeof item.confidence === 'number' ? item.confidence : 0;
		const reasoning = item.reasoning ?? '';

		const panel = dom.append(this._cardArea, dom.$('.insrc-brainstorm-intent-panel'));

		const heading = dom.append(panel, dom.$('h2.insrc-brainstorm-intent-heading'));
		heading.textContent = `Classified as: ${intent}`;

		const confRow = dom.append(panel, dom.$('.insrc-brainstorm-intent-confidence'));
		const confLabel = dom.append(confRow, dom.$('strong'));
		confLabel.textContent = 'Confidence: ';
		const confVal = dom.append(confRow, dom.$('span'));
		confVal.textContent = confidence.toFixed(2);

		if (reasoning) {
			const reasonRow = dom.append(panel, dom.$('.insrc-brainstorm-intent-reasoning'));
			const reasonLabel = dom.append(reasonRow, dom.$('strong'));
			reasonLabel.textContent = 'Reasoning: ';
			const reasonText = dom.append(reasonRow, dom.$('span'));
			reasonText.textContent = reasoning;
		}

		// Actions: Proceed | Use different intent (dropdown) | Cancel
		const actionsRow = dom.append(panel, dom.$('.insrc-brainstorm-intent-actions'));
		const availableActions = new Set(gate.actions);

		if (availableActions.has('proceed')) {
			const proceedBtn = dom.append(actionsRow, dom.$('button.insrc-brainstorm-btn.primary')) as HTMLButtonElement;
			proceedBtn.textContent = 'Proceed';
			this._register(dom.addDisposableListener(proceedBtn, 'click', () => this._dispatch('proceed', undefined)));
		}

		if (availableActions.has('use-intent')) {
			const overrideBtn = dom.append(actionsRow, dom.$('button.insrc-brainstorm-btn')) as HTMLButtonElement;
			overrideBtn.textContent = 'Use different intent';
			this._register(dom.addDisposableListener(overrideBtn, 'click', () => this._showOverridePicker(panel, actionsRow, intent)));
		}

		if (availableActions.has('cancel')) {
			const cancelBtn = dom.append(actionsRow, dom.$('button.insrc-brainstorm-btn.danger')) as HTMLButtonElement;
			cancelBtn.textContent = 'Cancel';
			this._register(dom.addDisposableListener(cancelBtn, 'click', () => this._dispatch('cancel', undefined)));
		}
	}

	private _showOverridePicker(panel: HTMLElement, actionsRow: HTMLElement, currentIntent: string): void {
		actionsRow.style.display = 'none';
		const picker = dom.append(panel, dom.$('.insrc-brainstorm-intent-picker'));

		const label = dom.append(picker, dom.$('.insrc-brainstorm-prompt-label'));
		label.textContent = 'Re-classify as:';

		const select = dom.append(picker, dom.$('select.insrc-brainstorm-intent-select')) as HTMLSelectElement;
		for (const intent of VALID_INTENTS) {
			const opt = dom.append(select, dom.$('option')) as HTMLOptionElement;
			opt.value = intent;
			opt.textContent = intent;
			if (intent === currentIntent) { opt.selected = true; }
		}

		const btnRow = dom.append(picker, dom.$('.insrc-brainstorm-prompt-actions'));
		const cancelBtn = dom.append(btnRow, dom.$('button.insrc-brainstorm-btn')) as HTMLButtonElement;
		cancelBtn.textContent = 'Back';
		this._register(dom.addDisposableListener(cancelBtn, 'click', () => {
			picker.remove();
			actionsRow.style.display = '';
		}));

		const sendBtn = dom.append(btnRow, dom.$('button.insrc-brainstorm-btn.primary')) as HTMLButtonElement;
		sendBtn.textContent = 'Use this intent';
		this._register(dom.addDisposableListener(sendBtn, 'click', () => {
			this._dispatch('use-intent', select.value);
		}));

		setTimeout(() => select.focus(), 0);
	}

	private _dispatch(action: string, feedback: string | undefined): void {
		if (!this._currentGateId) { return; }
		this.logService.info(`[brainstorm:pane:intent-confirm] _dispatch action=${action} feedback=${feedback ?? '-'} gateId=${this._currentGateId}`);
		this.chatService.replyToGate(this._currentGateId, action, feedback).then(
			() => this.logService.info(`[brainstorm:pane:intent-confirm] replyToGate resolved action=${action}`),
			err => this.logService.error(`[brainstorm:pane:intent-confirm] replyToGate failed action=${action}: ${(err as Error).message}`),
		);
		dom.clearNode(this._cardArea);
		const waiting = dom.append(this._cardArea, dom.$('.insrc-brainstorm-submitting'));
		const msg = dom.append(waiting, dom.$('span'));
		msg.textContent = 'Submitting...';
	}
}
