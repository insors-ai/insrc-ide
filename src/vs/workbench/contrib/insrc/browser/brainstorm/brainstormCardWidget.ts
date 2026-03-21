/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { URI } from '../../../../../base/common/uri.js';

interface IdeaRef {
	type: 'code' | 'doc' | 'url';
	path: string;
	label: string;
	line?: number;
	snippet?: string;
}

interface CardData {
	id: string;
	title: string;
	body: string;
	references: IdeaRef[];
	status: string;
	tags: string[];
	reviewVerdict?: string;
	reviewRationale?: string;
}

interface DiscussionMessage {
	role: 'user' | 'assistant';
	content: string;
}

export class BrainstormCardWidget extends Disposable {
	private _container: HTMLElement;
	private _discussionEl: HTMLElement;
	private _inputEl: HTMLTextAreaElement;
	private _messages: DiscussionMessage[] = [];

	constructor(
		parent: HTMLElement,
		data: CardData,
		actions: string[],
		private readonly onAction: (action: string, feedback?: string) => void,
		private readonly onDiscuss: (message: string) => void,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();

		// Clear parent
		dom.clearNode(parent);

		this._container = dom.append(parent, dom.$('.insrc-brainstorm-card'));

		// Title section
		const titleSection = dom.append(this._container, dom.$('.insrc-brainstorm-card-title-section'));
		const titleEl = dom.append(titleSection, dom.$('h3.insrc-brainstorm-card-title'));
		titleEl.textContent = data.title;

		// Verdict badge
		if (data.reviewVerdict) {
			const badge = dom.append(titleSection, dom.$(`span.insrc-brainstorm-verdict.verdict-${data.reviewVerdict}`));
			badge.textContent = data.reviewVerdict;
		}

		// Tags
		if (data.tags.length > 0) {
			const tagRow = dom.append(titleSection, dom.$('.insrc-brainstorm-tags'));
			for (const tag of data.tags) {
				const tagEl = dom.append(tagRow, dom.$('span.insrc-brainstorm-tag'));
				tagEl.textContent = tag;
			}
		}

		// Body section
		const bodySection = dom.append(this._container, dom.$('.insrc-brainstorm-card-body'));
		bodySection.textContent = data.body;

		// Review rationale (if present)
		if (data.reviewRationale) {
			const rationaleSection = dom.append(this._container, dom.$('.insrc-brainstorm-card-rationale'));
			const rationaleLabel = dom.append(rationaleSection, dom.$('strong'));
			rationaleLabel.textContent = 'Review: ';
			const rationaleText = dom.append(rationaleSection, dom.$('span'));
			rationaleText.textContent = data.reviewRationale;
		}

		// References section
		if (data.references.length > 0) {
			const refsSection = dom.append(this._container, dom.$('.insrc-brainstorm-card-refs'));
			const refsLabel = dom.append(refsSection, dom.$('h4'));
			refsLabel.textContent = 'References';
			for (const ref of data.references) {
				const refEl = dom.append(refsSection, dom.$('a.insrc-brainstorm-ref'));
				const icon = dom.append(refEl, dom.$('span'));
				icon.classList.add(...ThemeIcon.asClassNameArray(
					ref.type === 'code' ? Codicon.symbolFile :
						ref.type === 'url' ? Codicon.link : Codicon.file
				));
				const label = dom.append(refEl, dom.$('span'));
				label.textContent = ref.label;
				this._register(dom.addDisposableListener(refEl, 'click', () => {
					if (ref.type === 'code' || ref.type === 'doc') {
						const uri = URI.file(ref.path);
						this.editorService.openEditor({ resource: uri, options: { selection: ref.line ? { startLineNumber: ref.line, startColumn: 1 } : undefined } });
					}
				}));
			}
		}

		// Discussion section
		this._discussionEl = dom.append(this._container, dom.$('.insrc-brainstorm-card-discussion'));

		// Input area
		const inputSection = dom.append(this._container, dom.$('.insrc-brainstorm-card-input'));
		this._inputEl = dom.append(inputSection, dom.$('textarea.insrc-brainstorm-card-textarea')) as HTMLTextAreaElement;
		this._inputEl.placeholder = 'Ask a question or give feedback about this idea...';
		this._inputEl.rows = 2;

		const sendBtn = dom.append(inputSection, dom.$('button.insrc-brainstorm-btn.send')) as HTMLButtonElement;
		sendBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.send));
		sendBtn.title = 'Send';
		this._register(dom.addDisposableListener(sendBtn, 'click', () => this._sendMessage()));
		this._register(dom.addDisposableListener(this._inputEl, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this._sendMessage();
			}
		}));

		// Action buttons
		const actionsSection = dom.append(this._container, dom.$('.insrc-brainstorm-card-actions'));
		for (const action of actions) {
			const btn = dom.append(actionsSection, dom.$('button.insrc-brainstorm-action-btn')) as HTMLButtonElement;
			btn.textContent = this._actionLabel(action);
			btn.classList.add(`action-${action}`);
			btn.title = this._actionTooltip(action);
			this._register(dom.addDisposableListener(btn, 'click', () => {
				this.onAction(action, undefined);
			}));
		}
	}

	/** Add a discussion message (from user or assistant). */
	addMessage(role: 'user' | 'assistant', content: string): void {
		this._messages.push({ role, content });
		const msgEl = dom.append(this._discussionEl, dom.$(`.insrc-brainstorm-discussion-msg.msg-${role}`));
		const labelEl = dom.append(msgEl, dom.$('strong'));
		labelEl.textContent = role === 'user' ? 'You: ' : 'Agent: ';
		const textEl = dom.append(msgEl, dom.$('span'));
		textEl.textContent = content;
		this._discussionEl.scrollTop = this._discussionEl.scrollHeight;
	}

	/** Update the idea title and body (after LLM incorporated feedback). */
	updateIdea(title: string, body: string): void {
		const titleEl = this._container.querySelector('.insrc-brainstorm-card-title');
		if (titleEl) { titleEl.textContent = title; }
		const bodyEl = this._container.querySelector('.insrc-brainstorm-card-body');
		if (bodyEl) { bodyEl.textContent = body; }

		// Show update notice
		const notice = dom.append(this._discussionEl, dom.$('.insrc-brainstorm-discussion-notice'));
		notice.textContent = `Idea updated: ${title}`;
		this._discussionEl.scrollTop = this._discussionEl.scrollHeight;
	}

	private _sendMessage(): void {
		const msg = this._inputEl.value.trim();
		if (!msg) { return; }
		this._inputEl.value = '';
		this.addMessage('user', msg);
		this.onDiscuss(msg);
	}

	private _actionLabel(action: string): string {
		switch (action) {
			case 'approve': return 'Approve';
			case 'reject': return 'Reject';
			case 'diverge': return 'Diverge';
			case 'skip': return 'Skip';
			case 'park': return 'Park';
			case 'discuss': return 'Discuss';
			default: return action;
		}
	}

	private _actionTooltip(action: string): string {
		switch (action) {
			case 'approve': return 'Accept this idea';
			case 'reject': return 'Discard this idea';
			case 'diverge': return 'Generate variations of this idea';
			case 'skip': return 'Skip for now, come back later';
			case 'park': return 'Set aside, review after all others';
			case 'discuss': return 'Enter discussion';
			default: return '';
		}
	}
}
