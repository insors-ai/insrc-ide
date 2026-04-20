/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chat.css';
import * as dom from '../../../../../base/browser/dom.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInsrcChatService, type ChatEvent, type ChatMessage, type GateInfo } from '../../common/chatService.js';
import { IInsrcBrainstormSessionService } from '../../common/brainstormSessionService.js';
import { IInsrcRepoService } from '../../common/repoService.js';
import { IInsrcDaemonService } from '../../common/daemonService.js';
import { IInsrcDiffService, extractDiffFromResponse, parseDiff, applyHunks } from '../../common/diffService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { clearNode } from '../../../../../base/browser/dom.js';
import { createTrustedTypesPolicy } from '../../../../../base/browser/trustedTypes.js';

// ---------------------------------------------------------------------------
// SVG icon helpers (avoid innerHTML for CSP)
// ---------------------------------------------------------------------------

function createSvg(
	viewBox: string,
	paths: Array<{
		d: string;
		fill?: string;
		stroke?: string;
		strokeWidth?: string;
		strokeLinecap?: string;
		strokeLinejoin?: string;
	}>,
): SVGElement {
	const ns = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(ns, 'svg');
	svg.setAttribute('viewBox', viewBox);
	for (const p of paths) {
		const path = document.createElementNS(ns, 'path');
		path.setAttribute('d', p.d);
		if (p.fill) { path.setAttribute('fill', p.fill); }
		if (p.stroke) { path.setAttribute('stroke', p.stroke); }
		if (p.strokeWidth) { path.setAttribute('stroke-width', p.strokeWidth); }
		if (p.strokeLinecap) { path.setAttribute('stroke-linecap', p.strokeLinecap); }
		if (p.strokeLinejoin) { path.setAttribute('stroke-linejoin', p.strokeLinejoin); }
		svg.appendChild(path);
	}
	return svg;
}

// Send / cancel stay on the original hand-rolled silhouettes (they read
// well as solid paths at 16px). Attach / notepad use Heroicons v2
// outline (MIT, https://heroicons.com) -- path data copied verbatim
// from media/icons/heroicons/outline/paper-clip.svg and document-text.svg.
const HERO_OUTLINE = {
	fill: 'none',
	stroke: 'currentColor',
	strokeWidth: '1.5',
	strokeLinecap: 'round',
	strokeLinejoin: 'round',
} as const;
const SEND_ICON = () => createSvg('0 0 16 16', [{ d: 'M1.724 1.053a.5.5 0 01.553-.05l12.5 7a.5.5 0 010 .874l-12.5 7A.5.5 0 011 15.382V9.5h6a.5.5 0 000-1H1V2.618a.5.5 0 01.724-.565z', fill: 'currentColor' }]);
const CANCEL_ICON = () => createSvg('0 0 16 16', [{ d: 'M8 1a7 7 0 100 14A7 7 0 008 1zM5.146 5.146a.5.5 0 01.708 0L8 7.293l2.146-2.147a.5.5 0 01.708.708L8.707 8l2.147 2.146a.5.5 0 01-.708.708L8 8.707l-2.146 2.147a.5.5 0 01-.708-.708L7.293 8 5.146 5.854a.5.5 0 010-.708z', fill: 'currentColor' }]);
const ATTACH_ICON = () => createSvg('0 0 24 24', [{
	...HERO_OUTLINE,
	d: 'm18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13',
}]);
const NOTEPAD_ICON = () => createSvg('0 0 24 24', [{
	...HERO_OUTLINE,
	d: 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z',
}]);

// ---------------------------------------------------------------------------
// Trusted HTML policy for rendering daemon HTML snippets
// ---------------------------------------------------------------------------

const ttPolicy = createTrustedTypesPolicy('insrcChat', {
	createHTML: (value: string) => value,
});

// ---------------------------------------------------------------------------
// Chat View Pane
// ---------------------------------------------------------------------------

export class InsrcChatViewPane extends ViewPane {

	private _container!: HTMLElement;
	private _header!: HTMLElement;
	private _repoLabel!: HTMLElement;
	private _sessionLabel!: HTMLElement;
	private _sessionDropdown!: HTMLElement;
	private _progressBar!: HTMLElement;
	private _selectionBar!: HTMLElement;
	private _progressText!: HTMLElement;
	private _messageList!: HTMLElement;
	private _gateContainer!: HTMLElement;
	private _attachedFilesEl!: HTMLElement;
	private _attachedFiles: string[] = [];
	private _inputArea!: HTMLElement;
	private _input!: HTMLTextAreaElement;
	private _sendBtn!: HTMLButtonElement;
	private _cancelBtn!: HTMLButtonElement;
	private _emptyState!: HTMLElement;
	private _intentSelect!: HTMLSelectElement;

	// Tracks the last assistant message element for streaming updates
	private _streamingMessageEl: HTMLElement | undefined;
	// Intent announcement dedupe -- reset per turn/session so we don't spam
	// the chat panel every time the daemon re-emits "Intent: X".
	private _lastAnnouncedIntent: string | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IHoverService hoverService: IHoverService,
		@IInsrcChatService private readonly chatService: IInsrcChatService,
		@IInsrcRepoService private readonly repoService: IInsrcRepoService,
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IInsrcDiffService private readonly diffService: IInsrcDiffService,
		@IFileService private readonly fileService: IFileService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ICommandService private readonly commandService: ICommandService,
		@IInsrcBrainstormSessionService private readonly brainstormSession: IInsrcBrainstormSessionService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService, hoverService);

		this._register(this.chatService.onDidReceiveEvent(e => this._handleChatEvent(e)));
		this._register(this.chatService.onDidChangeSession(() => this._onSessionChanged()));
		this._register(this.daemonService.onDidChangeState(() => {
			this._updateHeader();
			this._updateState();
		}));
		this._register(this.repoService.onDidChangeRepos(() => this._updateHeader()));

		// Brainstorm session lock: while a brainstorm session is in flight,
		// the chat composer is dormant -- input is disabled and the send
		// button swaps to cancel so the only way to interrupt is by
		// cancelling the daemon stream. The lock tracks
		// sessionService.isSessionActive which flips the moment the
		// classifier commits to a brainstorm intent, before the first gate.
		this._register(this.brainstormSession.onDidChange(() => {
			this._updateBrainstormLock();
			this._syncIntentDropdown();
		}));
		this._register(this.brainstormSession.onDidChangeActiveGate(() => this._updateBrainstormLock()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this._container = dom.append(container, dom.$('.insrc-chat'));

		// Header
		this._header = dom.append(this._container, dom.$('.insrc-chat-header'));
		this._repoLabel = dom.append(this._header, dom.$('.insrc-chat-header-repo'));
		dom.append(this._repoLabel, dom.$('.insrc-chat-header-repo-arrow')).textContent = '\u25BE';
		this._register(dom.addDisposableListener(this._repoLabel, 'click', () => this._pickRepo()));

		// Session label + dropdown arrow (clickable, toggles recent sessions dropdown)
		const sessionWrapper = dom.append(this._header, dom.$('.insrc-chat-session-wrapper'));

		const dropdownArrow = dom.append(sessionWrapper, dom.$('span'));
		dropdownArrow.textContent = '\u25BE';
		dropdownArrow.style.fontSize = '10px';
		dropdownArrow.style.opacity = '0.5';
		dropdownArrow.style.marginRight = '2px';

		this._sessionLabel = dom.append(sessionWrapper, dom.$('.insrc-chat-header-session'));
		this._sessionLabel.title = 'Click for recent sessions';

		// Session dropdown
		this._sessionDropdown = dom.append(sessionWrapper, dom.$('.insrc-chat-session-dropdown'));
		this._register(dom.addDisposableListener(sessionWrapper, 'click', (e: MouseEvent) => {
			// Only toggle if clicking the label/arrow, not the dropdown items
			if (this._sessionDropdown.contains(e.target as Node)) {
				return;
			}
			e.stopPropagation();
			this._toggleSessionDropdown();
		}));

		// Close dropdown on click outside
		this._register(dom.addDisposableListener(this._container, 'click', (e: MouseEvent) => {
			if (!sessionWrapper.contains(e.target as Node)) {
				this._sessionDropdown.style.display = 'none';
			}
		}));

		// Empty state
		this._emptyState = dom.append(this._container, dom.$('.insrc-chat-empty'));
		this._emptyState.textContent = 'Start a conversation. Select a repo and type a message.';

		// Message list
		this._messageList = dom.append(this._container, dom.$('.insrc-chat-messages'));
		this._messageList.style.display = 'none';

		// Gate container (inline between messages and input)
		this._gateContainer = dom.append(this._container, dom.$('.insrc-chat-gate-container'));

		// Selection bar (floating bar when messages are selected)
		this._selectionBar = dom.append(this._container, dom.$('.insrc-chat-selection-bar.hidden'));
		const selCount = dom.append(this._selectionBar, dom.$('span.insrc-selection-count'));
		selCount.textContent = '0 selected';
		const saveSelBtn = dom.append(this._selectionBar, dom.$('button.insrc-selection-save')) as HTMLButtonElement;
		saveSelBtn.textContent = 'Save to File';
		this._register(dom.addDisposableListener(saveSelBtn, 'click', () => this._saveSelectedMessages()));
		const copySelBtn = dom.append(this._selectionBar, dom.$('button.insrc-selection-copy')) as HTMLButtonElement;
		copySelBtn.textContent = 'Copy';
		this._register(dom.addDisposableListener(copySelBtn, 'click', () => this._copySelectedMessages()));
		const clearSelBtn = dom.append(this._selectionBar, dom.$('button.insrc-selection-clear')) as HTMLButtonElement;
		clearSelBtn.textContent = 'Clear';
		this._register(dom.addDisposableListener(clearSelBtn, 'click', () => this._clearSelection()));

		// Progress bar (just above input)
		this._progressBar = dom.append(this._container, dom.$('.insrc-chat-progress.hidden'));
		const spinner = dom.append(this._progressBar, dom.$('.insrc-chat-progress-spinner'));
		spinner.setAttribute('aria-hidden', 'true');
		this._progressText = dom.append(this._progressBar, dom.$('span'));

		// Input area (matches extension chat layout: rounded border, textarea + icon buttons, toolbar below)
		this._inputArea = dom.append(this._container, dom.$('.insrc-chat-input-area'));

		// Row: textarea + send/cancel buttons
		const inputRow = dom.append(this._inputArea, dom.$('.insrc-chat-input-row'));

		this._input = dom.append(inputRow, dom.$('textarea.insrc-chat-input')) as HTMLTextAreaElement;
		this._input.placeholder = 'Type a message... (@local, @sonnet for provider)';
		this._input.rows = 1;
		this._register(dom.addDisposableListener(this._input, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this._send();
			}
			if (e.key === 'Escape' && this.chatService.isStreaming) {
				e.preventDefault();
				this.chatService.cancelStream();
			}
		}));
		this._register(dom.addDisposableListener(this._input, 'input', () => this._autoResize()));

		// Send button (arrow icon)
		this._sendBtn = dom.append(inputRow, dom.$('button.insrc-chat-icon-btn')) as HTMLButtonElement;
		this._sendBtn.title = 'Send';
		this._sendBtn.appendChild(SEND_ICON());
		this._register(dom.addDisposableListener(this._sendBtn, 'click', () => this._send()));

		// Cancel button (circle-X icon)
		this._cancelBtn = dom.append(inputRow, dom.$('button.insrc-chat-cancel-btn')) as HTMLButtonElement;
		this._cancelBtn.title = 'Cancel';
		this._cancelBtn.appendChild(CANCEL_ICON());
		this._cancelBtn.style.display = 'none';
		this._register(dom.addDisposableListener(this._cancelBtn, 'click', () => this.chatService.cancelStream()));

		// Toolbar: intent selector + attach button
		const toolbar = dom.append(this._inputArea, dom.$('.insrc-chat-input-toolbar'));

		this._intentSelect = dom.append(toolbar, dom.$('select.insrc-chat-intent-select')) as HTMLSelectElement;
		for (const intent of ['Auto', 'Implement', 'Refactor', 'Debug', 'Test', 'Design', 'Brainstorm', 'Plan', 'Review', 'Research']) {
			const opt = dom.append(this._intentSelect, dom.$('option')) as HTMLOptionElement;
			opt.value = intent.toLowerCase();
			opt.textContent = intent;
		}

		const attachBtn = dom.append(toolbar, dom.$('button.insrc-chat-attach-btn')) as HTMLButtonElement;
		attachBtn.title = 'Attach files';
		attachBtn.appendChild(ATTACH_ICON());
		this._register(dom.addDisposableListener(attachBtn, 'click', () => this._pickAttachFiles()));

		// Prompt Notepad icon button (next to attach)
		const notepadBtn = dom.append(toolbar, dom.$('button.insrc-chat-attach-btn')) as HTMLButtonElement;
		notepadBtn.title = 'Open Prompt Notepad';
		notepadBtn.appendChild(NOTEPAD_ICON());
		this._register(dom.addDisposableListener(notepadBtn, 'click', () => {
			this.commandService.executeCommand('insrc.promptNotepad.open');
		}));

		// Attached files badges
		this._attachedFilesEl = dom.append(toolbar, dom.$('.insrc-chat-attached-files'));

		this._updateHeader();
		this._updateState();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	// ---------------------------------------------------------------------------
	// Event handling
	// ---------------------------------------------------------------------------

	private _handleChatEvent(event: ChatEvent): void {
		switch (event.type) {
			case 'message':
				// While a brainstorm pane is driving the conversation, idea
				// discussion + per-idea prompts are rendered inside the card
				// widget itself (see BrainstormCardWidget._discussionEl). Don't
				// duplicate them in the chat panel.
				if (this._shouldSuppressMessagesForBrainstorm()) {
					break;
				}
				this._renderMessage(event.message);
				break;
			case 'gate': {
				// Skip brainstorm gates -- handled by the brainstorm editor panes.
				// The session-active flag is the primary gate; the phase check is
				// a belt-and-suspenders fallback in case a gate arrives before the
				// session-active progress event (unlikely but cheap to cover).
				if (this.brainstormSession.isSessionActive) {
					break;
				}
				const gateCtx = event.gate.context as Record<string, unknown> | undefined;
				if (gateCtx && (gateCtx['phase'] === 'ideation' || gateCtx['phase'] === 'convergence' || gateCtx['phase'] === 'specify' || gateCtx['phase'] === 'finalize')) {
					break;
				}
				this._renderGate(event.gate);
				break;
			}
			case 'progress':
				this._ingestIntentAnnouncement(event.progress.step);
				this._showProgress(event.progress.step, event.progress.status);
				break;
			case 'streamEnd':
				this._onStreamEnd();
				break;
			case 'error':
				this._renderError(event.error);
				this._onStreamEnd();
				break;
		}
	}

	/**
	 * Emit a synthesized assistant-style chat message when the daemon reports
	 * a classified intent, so the user has a persistent record of what the
	 * classifier decided (beyond the transient progress bar). Dedupes per
	 * session -- only the first Intent announcement per turn is rendered.
	 */
	private _ingestIntentAnnouncement(step: string): void {
		const match = step.match(/^Intent:\s*(.+)$/);
		if (!match) { return; }
		const detected = match[1]!.trim();
		if (!detected || detected === this._lastAnnouncedIntent) { return; }
		this._lastAnnouncedIntent = detected;

		// Keep the dropdown honest. `brainstorm/<category>` lands under the
		// top-level Brainstorm option.
		const [primary] = detected.split('/');
		if (primary) { this._selectIntent(primary); }

		// If the brainstorm pane is taking over, it already shows the
		// category badge -- no need to echo in chat too.
		if (this._shouldSuppressMessagesForBrainstorm()) { return; }

		const message: ChatMessage = {
			role: 'assistant',
			content: `Detected intent: **${detected}**. Routing accordingly.`,
			timestamp: new Date().toISOString(),
		};
		this._renderMessage(message);
	}

	/**
	 * True from the moment the classifier decides "brainstorm" until the
	 * session ends. Used to lock the chat composer: the user shouldn't be
	 * typing a new message into chat while the brainstorm flow owns the
	 * conversation -- and we want the lock BEFORE the first card arrives,
	 * not only once a gate has landed.
	 */
	private _shouldLockForBrainstorm(): boolean {
		return this.brainstormSession.isSessionActive;
	}

	/**
	 * Suppress assistant chat messages while brainstorm owns the session.
	 * The entire conversation lives in the brainstorm pane -- the chat
	 * panel should stay quiet so the user has one place to interact.
	 */
	private _shouldSuppressMessagesForBrainstorm(): boolean {
		return this.brainstormSession.isSessionActive;
	}

	/**
	 * Keep the intent dropdown in sync with the classifier's decision. The
	 * session service pulls the intent from "Intent: brainstorm/<cat>" progress
	 * events; we also listen for generic "Intent: <kind>" so non-brainstorm
	 * flows update the selector too.
	 */
	private _syncIntentDropdown(): void {
		if (!this._intentSelect) { return; }
		const phase = this.brainstormSession.phase;
		if (phase !== 'waiting') {
			this._selectIntent('brainstorm');
		}
	}

	private _selectIntent(intent: string): void {
		if (!this._intentSelect) { return; }
		const value = intent.toLowerCase();
		for (const opt of Array.from(this._intentSelect.options)) {
			if (opt.value === value) {
				this._intentSelect.value = value;
				return;
			}
		}
	}

	private _updateBrainstormLock(): void {
		const locked = this._shouldLockForBrainstorm();
		if (!this._sendBtn || !this._cancelBtn || !this._input) { return; }
		if (locked) {
			this._sendBtn.style.display = 'none';
			this._cancelBtn.style.display = '';
			this._sendBtn.disabled = true;
			this._input.disabled = true;
			this._input.placeholder = 'Brainstorm in progress -- use the pane above';
			if (this._intentSelect) { this._intentSelect.disabled = true; }
		} else if (!this.chatService.isStreaming) {
			// Don't fight with the streaming state; _onStreamEnd will restore
			// when the stream ends.
			this._sendBtn.style.display = '';
			this._cancelBtn.style.display = 'none';
			this._sendBtn.disabled = false;
			this._input.disabled = false;
			this._input.placeholder = 'Type a message... (@local, @sonnet for provider)';
			if (this._intentSelect) { this._intentSelect.disabled = false; }
		}
	}

	// ---------------------------------------------------------------------------
	// Rendering
	// ---------------------------------------------------------------------------

	private _renderMessage(msg: ChatMessage): void {
		this._emptyState.style.display = 'none';
		this._messageList.style.display = '';

		if (msg.role === 'assistant' && this.chatService.isStreaming) {
			// Update existing streaming element or create new one
			if (this._streamingMessageEl) {
				const content = this._streamingMessageEl.querySelector('.insrc-chat-message-content');
				if (content) {
					this._setTrustedHtml(content as HTMLElement, msg.content);
				}
			} else {
				this._streamingMessageEl = this._createMessageEl(msg);
				this._messageList.appendChild(this._streamingMessageEl);
			}
		} else {
			this._streamingMessageEl = undefined;
			const el = this._createMessageEl(msg);
			this._messageList.appendChild(el);
		}

		this._scrollToBottom();
	}

	private _createMessageEl(msg: ChatMessage): HTMLElement {
		const isUser = msg.role === 'user';
		const el = dom.$(`.insrc-chat-message.msg-${msg.role}`);

		const header = dom.append(el, dom.$('.insrc-chat-message-header'));
		const role = dom.append(header, dom.$(`.insrc-chat-message-role.${msg.role}`));
		role.textContent = isUser ? 'You' : 'Agent';

		if (msg.timestamp) {
			const time = dom.append(header, dom.$('.insrc-chat-message-time'));
			try {
				time.textContent = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
			} catch {
				time.textContent = '';
			}
		}

		if (msg.provider) {
			const badge = dom.append(header, dom.$('span'));
			badge.textContent = `@${msg.provider}`;
			badge.style.opacity = '0.5';
			badge.style.fontSize = '10px';
		}

		// Selection checkbox (for multi-select export)
		const checkbox = dom.append(el, dom.$('input.insrc-msg-select')) as HTMLInputElement;
		checkbox.type = 'checkbox';
		checkbox.title = 'Select for export';
		this._register(dom.addDisposableListener(checkbox, 'change', () => this._updateSelectionBar()));

		const content = dom.append(el, dom.$('.insrc-chat-message-content'));

		if (isUser) {
			// User messages: plain text with clickable file paths
			this._renderUserMessage(content, msg.content);
		} else {
			// Assistant messages contain HTML from the daemon -- render as trusted HTML
			this._setTrustedHtml(content, msg.content);
			// Wire copy buttons for code-viewer blocks
			this._wireCopyButtons(content);
			// Make collapsible if long
			this._makeCollapsible(el, content);
		}

		// Copy button (appears on hover)
		const copyBtn = dom.append(el, dom.$('.insrc-msg-copy.codicon.codicon-copy'));
		copyBtn.title = 'Copy message';
		this._register(dom.addDisposableListener(copyBtn, 'click', (e) => {
			e.stopPropagation();
			// Get text content (strip HTML tags for assistant messages)
			const text = content.textContent ?? '';
			this.clipboardService.writeText(text).then(() => {
				copyBtn.classList.remove('codicon-copy');
				copyBtn.classList.add('codicon-check');
				setTimeout(() => {
					copyBtn.classList.remove('codicon-check');
					copyBtn.classList.add('codicon-copy');
				}, 2000);
			});
		}));

		return el;
	}

	/** Render user message with clickable file paths */
	private _renderUserMessage(container: HTMLElement, text: string): void {
		// Match absolute file paths and quoted paths
		const pathPattern = /(["']?)(\/[\w./-]+\.\w{1,10})\1/g;
		let lastIdx = 0;
		let match: RegExpExecArray | null;

		while ((match = pathPattern.exec(text)) !== null) {
			// Text before the path
			if (match.index > lastIdx) {
				container.appendChild(document.createTextNode(text.substring(lastIdx, match.index)));
			}

			// Clickable file link
			const filePath = match[2]!;
			const link = dom.append(container, dom.$('a.insrc-chat-file-link'));
			link.textContent = filePath.split('/').pop() ?? filePath;
			link.title = filePath;
			link.style.cursor = 'pointer';
			link.style.color = 'var(--vscode-textLink-foreground)';
			link.style.textDecoration = 'underline';
			link.onclick = (e) => {
				e.preventDefault();
				this.openerService.open(URI.file(filePath));
			};

			lastIdx = match.index + match[0].length;
		}

		// Remaining text
		if (lastIdx < text.length) {
			container.appendChild(document.createTextNode(text.substring(lastIdx)));
		}

		// Fallback: no paths found, just plain text
		if (lastIdx === 0) {
			container.textContent = text;
		}
	}

	/** Safely set innerHTML using TrustedTypes policy */
	private _setTrustedHtml(el: HTMLElement, html: string): void {
		if (ttPolicy) {
			(el as any).innerHTML = ttPolicy.createHTML(html);
		} else {
			// Fallback: textContent only (no HTML rendering without TrustedTypes)
			el.textContent = html;
		}
	}

	/** Wire click handlers for code-viewer copy buttons */
	private _wireCopyButtons(container: HTMLElement): void {
		const copyBtns = container.querySelectorAll('.code-viewer-copy');
		for (const btn of copyBtns) {
			btn.addEventListener('click', () => {
				const viewer = btn.closest('.code-viewer');
				const pre = viewer?.querySelector('pre');
				if (pre) {
					this.clipboardService.writeText(pre.textContent ?? '');
					btn.textContent = 'Copied!';
					setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
				}
			});
		}
	}

	/** Collapse assistant messages longer than ~12 lines */
	private _makeCollapsible(msgEl: HTMLElement, contentEl: HTMLElement): void {
		// Defer to next frame so layout is computed
		dom.getWindow(msgEl).requestAnimationFrame(() => {
			const lineHeight = 18; // ~1.5 line-height * 12px
			const maxLines = 12;
			if (contentEl.scrollHeight > lineHeight * maxLines) {
				msgEl.classList.add('collapsed');

				const toggle = dom.append(msgEl, dom.$('button.insrc-chat-msg-toggle'));
				toggle.textContent = 'Show more';
				toggle.addEventListener('click', () => {
					const isCollapsed = msgEl.classList.toggle('collapsed');
					toggle.textContent = isCollapsed ? 'Show more' : 'Show less';
				});
			}
		});
	}

	private _renderGate(gate: GateInfo): void {
		clearNode(this._gateContainer);

		const card = dom.append(this._gateContainer, dom.$('.insrc-chat-gate'));
		const title = dom.append(card, dom.$('.insrc-chat-gate-title'));
		title.textContent = gate.title || gate.prompt || 'Action required';

		// If gate contains diff content, show it in the main editor
		const hasDiff = gate.content && (gate.content.includes('--- a/') || gate.content.includes('+++ b/') || gate.content.includes('@@ -'));
		if (hasDiff) {
			this._openDiffFromGate(gate);
		}

		const actions = dom.append(card, dom.$('.insrc-chat-gate-actions'));
		for (let i = 0; i < gate.actions.length; i++) {
			const action = gate.actions[i]!;
			const btn = dom.append(actions, dom.$(`.insrc-chat-gate-btn${i === 0 ? '.primary' : ''}`)) as HTMLButtonElement;
			btn.textContent = action;
			this._register(dom.addDisposableListener(btn, 'click', () => {
				clearNode(this._gateContainer);
				this.chatService.replyToGate(gate.gateId, action);
			}));
		}

		this._scrollToBottom();
	}

	private async _openDiffFromGate(gate: GateInfo): Promise<void> {
		if (!gate.content) {
			return;
		}

		try {
			const rawDiff = extractDiffFromResponse(gate.content);
			const parsedFiles = parseDiff(rawDiff);

			if (parsedFiles.length === 0) {
				return;
			}

			const repos = this.repoService.repos;
			const basePath = repos.length > 0 ? repos[0]!.path : '';

			const fileDiffs: Array<{ filePath: string; originalContent: string; proposedContent: string; diffText: string; isNew: boolean }> = [];

			for (const fd of parsedFiles) {
				const relPath = fd.isNew ? fd.newPath : fd.oldPath;
				const filePath = relPath.startsWith('/') ? relPath : `${basePath}/${relPath}`;

				let originalContent = '';
				if (!fd.isNew) {
					try {
						const content = await this.fileService.readFile(URI.file(filePath));
						originalContent = content.value.toString();
					} catch {
						originalContent = '';
					}
				}

				const proposedContent = fd.isNew
					? fd.hunks.flatMap(h => h.lines.filter(l => l.startsWith('+')).map(l => l.slice(1))).join('\n')
					: applyHunks(originalContent, fd.hunks);

				fileDiffs.push({ filePath, originalContent, proposedContent, diffText: rawDiff, isNew: fd.isNew });
			}

			await this.diffService.showDiffs(fileDiffs, gate.gateId);
		} catch {
			// Non-fatal: gate card still shows actions
		}
	}

	private _renderError(error: string): void {
		const el = dom.$('.insrc-chat-message');
		el.style.color = 'var(--vscode-errorForeground)';
		const content = dom.append(el, dom.$('.insrc-chat-message-content'));
		content.textContent = `Error: ${error}`;
		this._messageList.appendChild(el);
		this._scrollToBottom();
	}

	private _progressMsgEl: HTMLElement | undefined;

	private _showProgress(step: string, status: string): void {
		const label = status ? `${step}: ${status}` : step;

		// Show in progress bar only (no inline duplicate)
		this._progressBar.classList.remove('hidden');
		this._progressText.textContent = label;
	}

	private _onStreamEnd(): void {
		this._streamingMessageEl = undefined;
		this._progressBar.classList.add('hidden');

		// Remove inline progress message
		if (this._progressMsgEl) {
			this._progressMsgEl.remove();
			this._progressMsgEl = undefined;
		}

		// Don't re-enable input if the brainstorm pane is still driving; the
		// brainstorm lock keeps the composer dormant until the flow completes.
		if (this._shouldLockForBrainstorm()) {
			this._updateBrainstormLock();
			return;
		}

		this._sendBtn.style.display = '';
		this._cancelBtn.style.display = 'none';
		this._sendBtn.disabled = false;
		this._input.disabled = false;
		this._input.focus();
	}

	// ---------------------------------------------------------------------------
	// Message selection (multi-select export)
	// ---------------------------------------------------------------------------

	private _getSelectedMessages(): Array<{ role: string; text: string }> {
		const selected: Array<{ role: string; text: string }> = [];
		const checkboxes = this._messageList.querySelectorAll<HTMLInputElement>('input.insrc-msg-select:checked');
		for (const cb of checkboxes) {
			const msgEl = cb.closest('.insrc-chat-message');
			if (!msgEl) { continue; }
			const role = msgEl.classList.contains('user') ? 'User' : 'Assistant';
			const contentEl = msgEl.querySelector('.insrc-chat-message-content');
			const text = contentEl?.textContent ?? '';
			selected.push({ role, text });
		}
		return selected;
	}

	private _updateSelectionBar(): void {
		const count = this._messageList.querySelectorAll<HTMLInputElement>('input.insrc-msg-select:checked').length;
		const countEl = this._selectionBar.querySelector('.insrc-selection-count');
		if (countEl) { countEl.textContent = `${count} selected`; }
		if (count > 0) {
			this._selectionBar.classList.remove('hidden');
		} else {
			this._selectionBar.classList.add('hidden');
		}
	}

	private async _saveSelectedMessages(): Promise<void> {
		const selected = this._getSelectedMessages();
		if (selected.length === 0) { return; }

		const markdown = selected
			.map(m => `### ${m.role}\n\n${m.text}`)
			.join('\n\n---\n\n');

		const uri = await this.fileDialogService.showSaveDialog({
			title: 'Save Chat Messages',
			filters: [
				{ name: 'Markdown', extensions: ['md'] },
				{ name: 'Text', extensions: ['txt'] },
			],
		});
		if (!uri) { return; }

		await this.fileService.writeFile(uri, VSBuffer.fromString(markdown));
		this._clearSelection();
	}

	private async _copySelectedMessages(): Promise<void> {
		const selected = this._getSelectedMessages();
		if (selected.length === 0) { return; }

		const text = selected
			.map(m => `${m.role}:\n${m.text}`)
			.join('\n\n');

		await this.clipboardService.writeText(text);
		this._clearSelection();
	}

	private _clearSelection(): void {
		const checkboxes = this._messageList.querySelectorAll<HTMLInputElement>('input.insrc-msg-select:checked');
		for (const cb of checkboxes) { cb.checked = false; }
		this._selectionBar.classList.add('hidden');
	}

	// ---------------------------------------------------------------------------
	// Actions
	// ---------------------------------------------------------------------------

	private async _send(): Promise<void> {
		const text = this._input.value.trim();
		if (!text) {
			return;
		}
		// New turn -- let the next "Intent: X" progress event re-announce.
		this._lastAnnouncedIntent = undefined;

		// Auto-start session if needed
		if (!this.chatService.activeSessionId) {
			if (!this.daemonService.isConnected) {
				this._renderError('Not connected to daemon. Run "insrc: Connect to Daemon" from command palette.');
				return;
			}
			const repos = this.repoService.repos;
			if (repos.length === 0) {
				this._renderError('No repositories added. Run "insrc: Add Repository" first.');
				return;
			}
			try {
				await this.chatService.startSession(repos[0]!.path);
			} catch (err) {
				this._renderError(`Failed to start session: ${(err as Error).message}`);
				return;
			}
		}

		// Append file paths as absolute references (daemon reads them)
		let fullMessage = text;
		if (this._attachedFiles.length > 0) {
			// File dialog returns absolute URIs -- resolve any relative paths against active repo
			const repo = this.chatService.activeRepo ?? '';
			const resolvedPaths = this._attachedFiles.map(f =>
				f.startsWith('/') ? f : (repo ? `${repo}/${f}` : f)
			);
			const refs = resolvedPaths.map(f => `"${f}"`).join('\n');
			fullMessage = `${text}\n\n--- Referenced Files ---\n\n${refs}`;
			this._attachedFiles = [];
			this._renderAttachedFiles();
		}

		// Resolve inline relative file paths to absolute using workspace repos
		fullMessage = this._resolveInlinePaths(fullMessage);

		this._input.value = '';
		this._autoResize();
		this._sendBtn.style.display = 'none';
		this._cancelBtn.style.display = '';
		this._sendBtn.disabled = true;
		this._input.disabled = true;

		try {
			await this.chatService.sendMessage(fullMessage);
		} catch (err) {
			this._renderError((err as Error).message);
			this._onStreamEnd();
		}
	}

	private async _newSession(): Promise<void> {
		const repos = this.repoService.repos;
		if (repos.length === 0) {
			return;
		}

		// If multiple repos, could show quick pick -- for now use first
		await this.chatService.startSession(repos[0]!.path);
		clearNode(this._messageList);
		clearNode(this._gateContainer);
		this._emptyState.style.display = '';
		this._messageList.style.display = 'none';
		this._updateHeader();
	}

	// ---------------------------------------------------------------------------
	// State updates
	// ---------------------------------------------------------------------------

	private _updateHeader(): void {
		if (!this._repoLabel) {
			return;
		}

		// Repo pill label -- preserve the arrow child
		const arrow = this._repoLabel.querySelector('.insrc-chat-header-repo-arrow');
		const repo = this.chatService.activeRepo;
		let repoName: string;
		if (repo) {
			repoName = repo.split('/').pop() ?? repo;
		} else {
			const repos = this.repoService.repos;
			if (repos.length > 0) {
				repoName = repos[0]!.name;
			} else if (!this.daemonService.isConnected) {
				repoName = 'connecting...';
			} else {
				repoName = 'no repos';
			}
		}
		// Clear text nodes but keep the arrow element
		for (const child of Array.from(this._repoLabel.childNodes)) {
			if (child !== arrow) {
				this._repoLabel.removeChild(child);
			}
		}
		this._repoLabel.insertBefore(document.createTextNode(`Repo: ${repoName} `), arrow);

		// Session label (fixed text, acts as dropdown trigger)
		this._sessionLabel.textContent = 'Sessions';
	}

	private _updateState(): void {
		if (!this._input) {
			return;
		}

		if (!this.daemonService.isConnected) {
			this._input.placeholder = 'Connecting to daemon...';
			this._input.disabled = true;
			this._sendBtn.disabled = true;
		} else {
			this._input.placeholder = 'Type a message... (@local, @sonnet for provider)';
			this._input.disabled = false;
			this._sendBtn.disabled = false;
		}
	}

	// ---------------------------------------------------------------------------
	// Session changed (from sidebar click, dropdown, or new session)
	// ---------------------------------------------------------------------------

	private _onSessionChanged(): void {
		this._updateHeader();
		this._lastAnnouncedIntent = undefined;

		if (!this._messageList) {
			return;
		}

		clearNode(this._messageList);
		clearNode(this._gateContainer);
		this._streamingMessageEl = undefined;

		const messages = this.chatService.messages;
		if (messages.length > 0) {
			this._emptyState.style.display = 'none';
			this._messageList.style.display = '';
			for (const msg of messages) {
				const el = this._createMessageEl(msg);
				this._messageList.appendChild(el);
			}
			this._scrollToBottom();
		} else {
			this._emptyState.style.display = '';
			this._messageList.style.display = 'none';
		}
	}

	// ---------------------------------------------------------------------------
	// File attachment
	// ---------------------------------------------------------------------------

	/**
	 * Resolve relative file paths in the message to absolute paths.
	 * Matches quoted paths ("src/foo.ts"), @-prefixed (@src/foo.ts),
	 * and bare paths with known extensions (src/foo.ts).
	 * Resolves against all registered repos, picking the first match.
	 */
	private _resolveInlinePaths(message: string): string {
		const repos = this.repoService.repos;
		if (repos.length === 0) {
			return message;
		}

		const knownExts = /\.(ts|tsx|js|jsx|py|go|rs|yaml|yml|json|toml|sql|sh|css|html|md|xml|proto|graphql)$/;

		return message.replace(
			/(?:@|"|')?((?:\.{0,2}\/)?[\w./-]+\.\w{1,10})(?:"|')?/g,
			(match, path: string) => {
				// Skip absolute paths, URLs, and non-code files
				if (path.startsWith('/') || path.startsWith('http') || !knownExts.test(path)) {
					return match;
				}
				// Try resolving against each repo
				for (const repo of repos) {
					return `"${repo.path}/${path}"`;
				}
				return match;
			}
		);
	}

	private async _pickAttachFiles(): Promise<void> {
		const uris = await this.fileDialogService.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: true,
			title: 'Select files to attach to message',
		});

		if (!uris || uris.length === 0) {
			return;
		}

		for (const uri of uris) {
			const path = uri.fsPath;
			if (!this._attachedFiles.includes(path)) {
				this._attachedFiles.push(path);
			}
		}

		this._renderAttachedFiles();
	}

	private _renderAttachedFiles(): void {
		clearNode(this._attachedFilesEl);

		for (const filePath of this._attachedFiles) {
			const badge = dom.append(this._attachedFilesEl, dom.$('.insrc-chat-attached-file'));
			const name = filePath.split('/').pop() ?? filePath;
			badge.textContent = name;
			badge.title = filePath;

			const removeBtn = dom.append(badge, dom.$('.insrc-chat-attached-file-remove'));
			removeBtn.textContent = '\u00D7'; // x
			removeBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this._attachedFiles = this._attachedFiles.filter(f => f !== filePath);
				this._renderAttachedFiles();
			});
		}
	}

	// ---------------------------------------------------------------------------
	// Repo picker
	// ---------------------------------------------------------------------------

	private async _pickRepo(): Promise<void> {
		const repos = this.repoService.repos;
		if (repos.length === 0) {
			return;
		}

		const pick = await this.quickInputService.pick(
			repos.map(r => ({ label: r.name, description: r.path, repoPath: r.path })),
			{ placeHolder: 'Select repository for chat' }
		);

		if (!pick) {
			return;
		}

		// Start a new session on the selected repo
		try {
			await this.chatService.startSession((pick as { repoPath: string }).repoPath);
			clearNode(this._messageList);
			clearNode(this._gateContainer);
			this._emptyState.style.display = '';
			this._messageList.style.display = 'none';
			this._updateHeader();
		} catch (err) {
			this._renderError(`Failed to start session: ${(err as Error).message}`);
		}
	}

	// ---------------------------------------------------------------------------
	// Session dropdown
	// ---------------------------------------------------------------------------

	private async _toggleSessionDropdown(): Promise<void> {
		if (this._sessionDropdown.style.display === 'block') {
			this._sessionDropdown.style.display = 'none';
			return;
		}

		clearNode(this._sessionDropdown);

		// "New Session" item
		const newItem = dom.append(this._sessionDropdown, dom.$('.insrc-chat-session-item.new-session'));
		newItem.textContent = '+ New Session';
		this._register(dom.addDisposableListener(newItem, 'click', () => {
			this._sessionDropdown.style.display = 'none';
			this._newSession();
		}));

		// Load recent sessions
		if (this.daemonService.isConnected) {
			try {
				const sessions = await this.daemonService.rpc<Array<{ id: string; summary: string; createdAt: string }>>('session.list');
				if (sessions && sessions.length > 0) {
					// Show max 10 recent
					for (const s of sessions.slice(0, 10)) {
						const item = dom.append(this._sessionDropdown, dom.$('.insrc-chat-session-item'));
						const title = dom.append(item, dom.$('.insrc-chat-session-item-title'));
						title.textContent = (s.summary || s.id).substring(0, 50);

						const time = dom.append(item, dom.$('.insrc-chat-session-item-time'));
						try {
							time.textContent = new Date(s.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
						} catch {
							time.textContent = s.createdAt;
						}

						this._register(dom.addDisposableListener(item, 'click', () => {
							this._sessionDropdown.style.display = 'none';
							this._loadSession(s.id);
						}));
					}
				}
			} catch {
				// ignore
			}
		}

		this._sessionDropdown.style.display = 'block';
	}

	private async _loadSession(sessionId: string): Promise<void> {
		try {
			await this.chatService.resumeSession(sessionId);
			clearNode(this._messageList);
			clearNode(this._gateContainer);

			// Render loaded history
			for (const msg of this.chatService.messages) {
				const el = this._createMessageEl(msg);
				this._messageList.appendChild(el);
			}

			this._emptyState.style.display = 'none';
			this._messageList.style.display = '';
			this._scrollToBottom();
			this._updateHeader();
		} catch (err) {
			this._renderError(`Failed to load session: ${(err as Error).message}`);
		}
	}

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	private _scrollToBottom(): void {
		this._messageList.scrollTop = this._messageList.scrollHeight;
	}

	private _autoResize(): void {
		this._input.style.height = 'auto';
		this._input.style.height = Math.min(this._input.scrollHeight, 120) + 'px';
	}
}
