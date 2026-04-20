/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { URI } from '../../../../../base/common/uri.js';

interface IdeaRef {
	type: 'code' | 'doc' | 'url';
	path: string;
	label: string;
	line?: number;
	snippet?: string;
}

export interface CardDiscussionMessage {
	role: 'user' | 'assistant';
	content: string;
}

interface CardData {
	id: string;
	title: string;
	body: string;
	/** Preferred primary description: 2-4 sentence rich summary from the LLM.
	 *  When present the card renders this as the main body; `body` becomes a
	 *  fallback for legacy ideas that predate the rich-format parse. */
	summary?: string;
	/** 1-2 sentences on motivation / tradeoffs (optional). */
	rationale?: string;
	/** Reviewer's refined description from the review pass (optional). */
	reviewDescription?: string;
	references: IdeaRef[];
	status: string;
	tags: string[];
	reviewVerdict?: string;
	reviewRationale?: string;
	/** Prior discussion history to render under the body (optional). */
	messages?: readonly CardDiscussionMessage[];
	/** Transient warning (e.g. LLM returned no variations) -- rendered as an amber strip above the title. */
	warning?: string;
}

/**
 * Actions the backend emits with `needsInput: true` on the single-idea /
 * idea-discussion gates. Clicking one of these reveals an inline prompt
 * panel; the feedback captured there becomes gateReply.feedback.
 *
 * Keep this list in sync with the controller -- if the backend adds a new
 * input-requiring action, add it here. (We can't derive this from the gate
 * payload because daemonServiceImpl flattens actions to bare names.)
 */
const INPUT_REQUIRING_ACTIONS: ReadonlySet<string> = new Set([
	'diverge', 'discuss', 'respond', 'refine', 'edit', 'split',
]);

const PROMPT_LABELS: Record<string, string> = {
	diverge: 'What direction should we explore?',
	discuss: 'What would you like to discuss?',
	respond: 'Your response or follow-up question',
	refine: 'How should this be refined?',
	edit: 'Describe your edit',
	split: 'How should this be split?',
};

const PROMPT_PLACEHOLDERS: Record<string, string> = {
	diverge: 'Optional -- leave empty for default 3-5 variations',
	discuss: 'Type your thoughts...',
	respond: 'Type your response...',
	refine: 'Describe the refinement...',
	edit: 'Describe the edit...',
	split: 'Describe the split...',
};

export class BrainstormCardWidget extends Disposable {
	private _container: HTMLElement;
	private _actionContainer!: HTMLElement;
	private readonly _actions: readonly string[];
	private _dispatched = false;

	constructor(
		parent: HTMLElement,
		data: CardData,
		actions: readonly string[],
		private readonly onAction: (action: string, feedback: string | undefined) => void,
		@IEditorService private readonly editorService: IEditorService,
		@ILogService private readonly logService: ILogService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		this._actions = actions.slice();
		this.logService.info(`[brainstorm:card] constructed id=${data.id.slice(0, 8)} title="${data.title.slice(0, 60)}" actions=[${actions.join(',')}] messages=${data.messages?.length ?? 0}`);

		dom.clearNode(parent);
		this._container = dom.append(parent, dom.$('.insrc-brainstorm-card'));

		this._renderWarning(data);
		this._renderTitle(data);
		this._renderBody(data);
		this._renderReviewDescription(data);
		this._renderIdeaRationale(data);
		this._renderRationale(data);
		this._renderReferences(data);
		this._renderDiscussion(data);

		this._actionContainer = dom.append(this._container, dom.$('.insrc-brainstorm-card-actions'));
		this._renderActions();
	}

	// ---------------------------------------------------------------------------
	// Rendering -- idea content
	// ---------------------------------------------------------------------------

	private _renderWarning(data: CardData): void {
		if (!data.warning) { return; }
		const strip = dom.append(this._container, dom.$('.insrc-brainstorm-card-warning'));
		const icon = dom.append(strip, dom.$('span.codicon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.warning));
		const text = dom.append(strip, dom.$('span.insrc-brainstorm-card-warning-text'));
		text.textContent = data.warning;
	}

	private _renderTitle(data: CardData): void {
		const titleSection = dom.append(this._container, dom.$('.insrc-brainstorm-card-title-section'));
		const titleEl = dom.append(titleSection, dom.$('h3.insrc-brainstorm-card-title'));
		titleEl.textContent = data.title;

		if (data.reviewVerdict) {
			const badge = dom.append(titleSection, dom.$(`span.insrc-brainstorm-verdict.verdict-${data.reviewVerdict}`));
			badge.textContent = data.reviewVerdict;
		}

		if (data.tags.length > 0) {
			const tagRow = dom.append(titleSection, dom.$('.insrc-brainstorm-tags'));
			for (const tag of data.tags) {
				const tagEl = dom.append(tagRow, dom.$('span.insrc-brainstorm-tag'));
				tagEl.textContent = tag;
			}
		}
	}

	private _renderBody(data: CardData): void {
		// Prefer the rich-format summary; fall back to raw body for legacy
		// ideas generated before the rich prompts landed (Item 10).
		const primary = (data.summary && data.summary.trim().length > 0)
			? data.summary
			: data.body;
		if (!primary || primary.trim().length === 0) { return; }
		const bodySection = dom.append(this._container, dom.$('.insrc-brainstorm-card-body'));
		bodySection.textContent = primary;
	}

	private _renderReviewDescription(data: CardData): void {
		if (!data.reviewDescription || data.reviewDescription.trim().length === 0) { return; }
		// Skip when reviewDescription is just a paraphrase of summary/body
		// (common when the reviewer had nothing to add).
		const primary = (data.summary ?? data.body ?? '').trim().toLowerCase();
		if (primary && data.reviewDescription.trim().toLowerCase() === primary) { return; }
		const section = dom.append(this._container, dom.$('.insrc-brainstorm-card-review'));
		const label = dom.append(section, dom.$('strong'));
		label.textContent = 'Reviewer notes: ';
		const text = dom.append(section, dom.$('span'));
		text.textContent = data.reviewDescription;
	}

	private _renderIdeaRationale(data: CardData): void {
		if (!data.rationale || data.rationale.trim().length === 0) { return; }
		const section = dom.append(this._container, dom.$('.insrc-brainstorm-card-idea-rationale'));
		const label = dom.append(section, dom.$('strong'));
		label.textContent = 'Rationale: ';
		const text = dom.append(section, dom.$('span'));
		text.textContent = data.rationale;
	}

	private _renderRationale(data: CardData): void {
		if (!data.reviewRationale) { return; }
		const section = dom.append(this._container, dom.$('.insrc-brainstorm-card-rationale'));
		const label = dom.append(section, dom.$('strong'));
		label.textContent = 'Review: ';
		const text = dom.append(section, dom.$('span'));
		text.textContent = data.reviewRationale;
	}

	private _renderReferences(data: CardData): void {
		if (data.references.length === 0) { return; }

		const refsSection = dom.append(this._container, dom.$('.insrc-brainstorm-card-refs'));
		const refsLabel = dom.append(refsSection, dom.$('h4'));
		refsLabel.textContent = 'References';
		for (const ref of data.references) {
			const openable = isOpenableRef(ref);
			// Unresolved refs (entity name the daemon couldn't locate) render
			// as a greyed-out non-clickable chip with a tooltip. Prior behaviour
			// dropped them silently, which hid the LLM's intent.
			const tag = openable ? 'a.insrc-brainstorm-ref' : 'span.insrc-brainstorm-ref.unresolved';
			const refEl = dom.append(refsSection, dom.$(tag));
			if (!openable) {
				refEl.title = `Couldn't resolve "${ref.label}" to a file or URL`;
			}
			const icon = dom.append(refEl, dom.$('span'));
			icon.classList.add(...ThemeIcon.asClassNameArray(
				!openable ? Codicon.circleSlash :
					ref.type === 'url' ? Codicon.link :
						ref.type === 'code' ? Codicon.symbolFile : Codicon.file
			));
			const label = dom.append(refEl, dom.$('span'));
			label.textContent = ref.label;
			if (!openable) { continue; }
			this._register(dom.addDisposableListener(refEl, 'click', () => {
				if (ref.type === 'url') {
					this.openerService.open(ref.path).then(
						undefined,
						err => this.logService.error(`[brainstorm:card] url open failed: ${(err as Error).message}`),
					);
					return;
				}
				if (ref.type === 'code' || ref.type === 'doc') {
					const uri = URI.file(ref.path);
					this.editorService.openEditor({
						resource: uri,
						options: {
							selection: ref.line ? { startLineNumber: ref.line, startColumn: 1 } : undefined,
						},
					});
				}
			}));
		}
	}

	private _renderDiscussion(data: CardData): void {
		const messages = data.messages;
		if (!messages || messages.length === 0) { return; }
		const section = dom.append(this._container, dom.$('.insrc-brainstorm-card-discussion'));
		const header = dom.append(section, dom.$('h4.insrc-brainstorm-discussion-header'));
		header.textContent = 'Discussion';
		for (const msg of messages) {
			const msgEl = dom.append(section, dom.$(`.insrc-brainstorm-discussion-msg.msg-${msg.role}`));
			const labelEl = dom.append(msgEl, dom.$('strong'));
			labelEl.textContent = msg.role === 'user' ? 'You: ' : 'Agent: ';
			const textEl = dom.append(msgEl, dom.$('span'));
			textEl.textContent = msg.content;
		}
	}

	// ---------------------------------------------------------------------------
	// Rendering -- actions
	// ---------------------------------------------------------------------------

	private _renderActions(): void {
		dom.clearNode(this._actionContainer);
		this._container.classList.remove('submitting');

		const singleShot: string[] = [];
		const inputRequiring: string[] = [];
		for (const action of this._actions) {
			if (INPUT_REQUIRING_ACTIONS.has(action)) {
				inputRequiring.push(action);
			} else {
				singleShot.push(action);
			}
		}

		if (singleShot.length > 0) {
			this._renderActionRow(singleShot, false);
		}
		if (inputRequiring.length > 0) {
			this._renderActionRow(inputRequiring, true);
		}
	}

	private _renderActionRow(actions: string[], suffixEllipsis: boolean): void {
		const row = dom.append(this._actionContainer, dom.$('.insrc-brainstorm-action-row'));
		for (const action of actions) {
			const btn = dom.append(row, dom.$('button.insrc-brainstorm-action-btn')) as HTMLButtonElement;
			btn.classList.add(`action-${action}`);
			btn.textContent = suffixEllipsis
				? `${this._actionLabel(action)}...`
				: this._actionLabel(action);
			btn.title = this._actionTooltip(action);
			this._register(dom.addDisposableListener(btn, 'click', () => {
				if (this._dispatched) {
					this.logService.info(`[brainstorm:card] click action=${action} IGNORED (already dispatched)`);
					return;
				}
				this.logService.info(`[brainstorm:card] click action=${action} needsInput=${INPUT_REQUIRING_ACTIONS.has(action)}`);
				if (INPUT_REQUIRING_ACTIONS.has(action)) {
					this._showPromptPanel(action);
				} else {
					this._dispatch(action, undefined);
				}
			}));
		}
	}

	private _showPromptPanel(action: string): void {
		this.logService.info(`[brainstorm:card] prompt panel opened action=${action}`);
		dom.clearNode(this._actionContainer);

		const panel = dom.append(this._actionContainer, dom.$('.insrc-brainstorm-prompt-panel'));

		const label = dom.append(panel, dom.$('.insrc-brainstorm-prompt-label'));
		label.textContent = PROMPT_LABELS[action] ?? 'Your input';

		const textarea = dom.append(panel, dom.$('textarea.insrc-brainstorm-prompt-textarea')) as HTMLTextAreaElement;
		textarea.rows = 3;
		textarea.placeholder = PROMPT_PLACEHOLDERS[action] ?? 'Type your message...';

		const btnRow = dom.append(panel, dom.$('.insrc-brainstorm-prompt-actions'));
		const cancelBtn = dom.append(btnRow, dom.$('button.insrc-brainstorm-btn')) as HTMLButtonElement;
		cancelBtn.textContent = 'Cancel';
		const sendBtn = dom.append(btnRow, dom.$('button.insrc-brainstorm-btn.primary')) as HTMLButtonElement;
		sendBtn.textContent = 'Send';

		const submit = () => {
			if (this._dispatched) {
				this.logService.info(`[brainstorm:card] prompt submit action=${action} IGNORED (already dispatched)`);
				return;
			}
			const text = textarea.value.trim();
			this.logService.info(`[brainstorm:card] prompt submit action=${action} textLen=${text.length}`);
			this._dispatch(action, text.length > 0 ? text : undefined);
		};
		const cancel = () => {
			this.logService.info(`[brainstorm:card] prompt cancelled action=${action}`);
			this._renderActions();
		};

		this._register(dom.addDisposableListener(cancelBtn, 'click', cancel));
		this._register(dom.addDisposableListener(sendBtn, 'click', submit));
		this._register(dom.addDisposableListener(textarea, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				cancel();
			} else if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				submit();
			}
		}));

		// Focus on next tick so the element is in the DOM.
		setTimeout(() => textarea.focus(), 0);
	}

	// ---------------------------------------------------------------------------
	// Submitting state
	// ---------------------------------------------------------------------------

	private _dispatch(action: string, feedback: string | undefined): void {
		this.logService.info(`[brainstorm:card] _dispatch action=${action} feedbackLen=${feedback?.length ?? 0}`);
		this._dispatched = true;
		this._enterSubmittingState();
		this.onAction(action, feedback);
	}

	private _enterSubmittingState(): void {
		dom.clearNode(this._actionContainer);
		this._container.classList.add('submitting');

		const el = dom.append(this._actionContainer, dom.$('.insrc-brainstorm-submitting'));
		const spinner = dom.append(el, dom.$('span.insrc-brainstorm-submitting-spinner'));
		spinner.classList.add(...ThemeIcon.asClassNameArray(Codicon.loading), 'codicon-modifier-spin');
		const text = dom.append(el, dom.$('span'));
		text.textContent = 'Thinking...';
		// No auto-timeout: LLM calls with reasoning / tool-use can take
		// minutes. The card unlocks when the next gate arrives, or when the
		// daemon surfaces a stream error (handled separately).
	}

	// ---------------------------------------------------------------------------
	// Labels
	// ---------------------------------------------------------------------------

	private _actionLabel(action: string): string {
		switch (action) {
			case 'approve': return 'Approve';
			case 'reject': return 'Reject';
			case 'diverge': return 'Diverge';
			case 'skip': return 'Skip';
			case 'park': return 'Park';
			case 'discuss': return 'Discuss';
			case 'respond': return 'Respond';
			case 'refine': return 'Refine';
			case 'reopen': return 'Reopen';
			case 'split': return 'Split';
			case 'edit': return 'Edit';
			case 'accept': return 'Accept';
			case 'back': return 'Back';
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
			case 'discuss': return 'Open a focused discussion with the agent';
			case 'respond': return 'Send a follow-up message';
			case 'refine': return 'Refine with guidance';
			case 'reopen': return 'Re-open this decided idea for review';
			case 'split': return 'Break this theme into smaller themes';
			case 'edit': return 'Edit this theme';
			case 'accept': return 'Accept';
			case 'back': return 'Back to the previous view';
			default: return '';
		}
	}
}

/**
 * Only render references whose `path` looks like a real file path. LLM output
 * sometimes includes bare entity names ("MyClass") that the agent couldn't
 * resolve; opening them would navigate to `file:///.../MyClass` and fail.
 */
function isOpenableRef(ref: IdeaRef): boolean {
	// URLs are openable when path looks like an http(s) URL.
	if (ref.type === 'url') {
		return !!ref.path && /^https?:\/\//i.test(ref.path);
	}
	// Code/doc refs need an absolute path -- the daemon's entity-index
	// resolver emits absolute paths when it finds a match, and empty-string
	// paths when it couldn't resolve the name (Item 9). Empty path means
	// unresolved; the UI renders it as a non-clickable chip.
	if (!ref.path) { return false; }
	return ref.path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(ref.path);
}
