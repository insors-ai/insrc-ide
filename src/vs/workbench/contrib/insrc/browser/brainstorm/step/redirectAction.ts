/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IInsrcChatService } from '../../../common/chatService.js';
import { IInsrcBrainstormSessionService } from '../../../common/brainstormSessionService.js';

/**
 * Mid-turn intent correction (Item 6) affordance -- the "Redirect" header
 * button + picker. Shared between `BrainstormPaneBase` (for panes that use
 * the common base) and `BrainstormIdeasPane` / `BrainstormIdeaChatPane`
 * (which extend EditorPane directly).
 *
 * Usage: call `attachRedirectAction(containerForOverlay, headerRightHost,
 * chatService, sessionService, logService, logTag)` during pane construction.
 * Returns an IDisposable to register with the pane's disposable store.
 */

const REDIRECT_INTENTS: readonly string[] = [
	'implement', 'refactor', 'test', 'debug', 'review', 'document',
	'research', 'code-analysis', 'plan', 'requirements', 'design',
	'brainstorm', 'deploy', 'release', 'infra',
];

export interface RedirectActionDeps {
	chatService: IInsrcChatService;
	sessionService: IInsrcBrainstormSessionService;
	logService: ILogService;
	/** Prefix for log lines, e.g. "brainstorm:pane:idea". */
	logTag: string;
}

/**
 * Attach the Redirect button to `headerRight` and wire the picker overlay
 * onto `containerForOverlay` (typically the pane's root element so the
 * overlay can cover the whole pane).
 */
export function attachRedirectAction(
	containerForOverlay: HTMLElement,
	headerRight: HTMLElement,
	deps: RedirectActionDeps,
): IDisposable {
	const disposables: IDisposable[] = [];

	const btn = dom.append(headerRight, dom.$('button.insrc-brainstorm-header-btn.insrc-brainstorm-redirect-btn')) as HTMLButtonElement;
	btn.title = 'Redirect this turn to a different intent (cancels the current stream and resends)';
	const icon = dom.append(btn, dom.$('span.codicon'));
	icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.replace));
	const label = dom.append(btn, dom.$('span.insrc-brainstorm-redirect-label'));
	label.textContent = 'Redirect';

	let picker: HTMLElement | undefined;
	disposables.push(dom.addDisposableListener(btn, 'click', () => {
		if (picker) {
			picker.remove();
			picker = undefined;
			return;
		}
		picker = openRedirectPicker(containerForOverlay, deps, () => {
			picker?.remove();
			picker = undefined;
		});
	}));

	disposables.push(toDisposable(() => {
		picker?.remove();
		picker = undefined;
	}));

	return {
		dispose: () => {
			for (const d of disposables) { d.dispose(); }
		},
	};
}

function openRedirectPicker(
	container: HTMLElement,
	deps: RedirectActionDeps,
	onClose: () => void,
): HTMLElement {
	const overlay = dom.append(container, dom.$('.insrc-brainstorm-redirect-overlay'));
	const panel = dom.append(overlay, dom.$('.insrc-brainstorm-redirect-panel'));

	const heading = dom.append(panel, dom.$('h3'));
	heading.textContent = 'Redirect turn';

	const help = dom.append(panel, dom.$('.insrc-brainstorm-redirect-help'));
	help.textContent = 'Cancels the current stream and re-sends with a different intent.';

	const intentLabel = dom.append(panel, dom.$('.insrc-brainstorm-prompt-label'));
	intentLabel.textContent = 'New intent:';
	const select = dom.append(panel, dom.$('select.insrc-brainstorm-intent-select')) as HTMLSelectElement;
	const suggested = deps.sessionService.category;
	for (const intent of REDIRECT_INTENTS) {
		const opt = dom.append(select, dom.$('option')) as HTMLOptionElement;
		opt.value = intent;
		opt.textContent = intent;
		if (intent === suggested) { opt.selected = true; }
	}

	const textLabel = dom.append(panel, dom.$('.insrc-brainstorm-prompt-label'));
	textLabel.textContent = 'Optional refinement:';
	const textarea = dom.append(panel, dom.$('textarea.insrc-brainstorm-prompt-textarea')) as HTMLTextAreaElement;
	textarea.rows = 3;
	textarea.placeholder = 'Additional context for the redirected turn (optional)';

	const actions = dom.append(panel, dom.$('.insrc-brainstorm-prompt-actions'));
	const cancelBtn = dom.append(actions, dom.$('button.insrc-brainstorm-btn')) as HTMLButtonElement;
	cancelBtn.textContent = 'Cancel';
	const sendBtn = dom.append(actions, dom.$('button.insrc-brainstorm-btn.primary')) as HTMLButtonElement;
	sendBtn.textContent = 'Redirect';

	const d1 = dom.addDisposableListener(cancelBtn, 'click', () => onClose());
	const d2 = dom.addDisposableListener(sendBtn, 'click', () => {
		const intent = select.value;
		const refinement = textarea.value.trim();
		sendBtn.disabled = true;
		cancelBtn.disabled = true;
		deps.logService.info(`[${deps.logTag}] redirect intent=${intent} refinementLen=${refinement.length}`);
		deps.chatService.redirect(intent, refinement || undefined).then(
			() => {
				deps.logService.info(`[${deps.logTag}] redirect resolved`);
				onClose();
			},
			err => {
				deps.logService.error(`[${deps.logTag}] redirect failed: ${(err as Error).message}`);
				sendBtn.disabled = false;
				cancelBtn.disabled = false;
				const errRow = dom.append(panel, dom.$('.insrc-brainstorm-redirect-error'));
				errRow.textContent = `Redirect failed: ${(err as Error).message}`;
			},
		);
	});

	// Listeners attached to elements that are removed with the overlay clean
	// up naturally; still track them so we dispose the handlers promptly when
	// the overlay is closed while the handler might fire from a late event.
	(overlay as any)._redirectDisposables = [d1, d2];

	setTimeout(() => select.focus(), 0);
	return overlay;
}
