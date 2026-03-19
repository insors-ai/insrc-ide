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
import { IInsrcRepoService } from '../../common/repoService.js';
import { IInsrcDaemonService } from '../../common/daemonService.js';
import { IInsrcDiffService, extractDiffFromResponse, parseDiff, applyHunks } from '../../common/diffService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { URI } from '../../../../../base/common/uri.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { clearNode } from '../../../../../base/browser/dom.js';
import { createTrustedTypesPolicy } from '../../../../../base/browser/trustedTypes.js';

// ---------------------------------------------------------------------------
// SVG icon helpers (avoid innerHTML for CSP)
// ---------------------------------------------------------------------------

function createSvg(viewBox: string, paths: Array<{ d: string; fill?: string; stroke?: string; strokeWidth?: string }>): SVGElement {
	const ns = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(ns, 'svg');
	svg.setAttribute('viewBox', viewBox);
	for (const p of paths) {
		const path = document.createElementNS(ns, 'path');
		path.setAttribute('d', p.d);
		if (p.fill) { path.setAttribute('fill', p.fill); }
		if (p.stroke) { path.setAttribute('stroke', p.stroke); }
		if (p.strokeWidth) { path.setAttribute('stroke-width', p.strokeWidth); }
		svg.appendChild(path);
	}
	return svg;
}

const SEND_ICON = () => createSvg('0 0 16 16', [{ d: 'M1.724 1.053a.5.5 0 01.553-.05l12.5 7a.5.5 0 010 .874l-12.5 7A.5.5 0 011 15.382V9.5h6a.5.5 0 000-1H1V2.618a.5.5 0 01.724-.565z', fill: 'currentColor' }]);
const CANCEL_ICON = () => createSvg('0 0 16 16', [{ d: 'M8 1a7 7 0 100 14A7 7 0 008 1zM5.146 5.146a.5.5 0 01.708 0L8 7.293l2.146-2.147a.5.5 0 01.708.708L8.707 8l2.147 2.146a.5.5 0 01-.708.708L8 8.707l-2.146 2.147a.5.5 0 01-.708-.708L7.293 8 5.146 5.854a.5.5 0 010-.708z', fill: 'currentColor' }]);
const ATTACH_ICON = () => createSvg('0 0 16 16', [{ d: 'M14 8.5L7.5 15a3.54 3.54 0 01-5-5L9 3.5a2.36 2.36 0 013.33 3.33L6 13.17a1.18 1.18 0 01-1.67-1.67L10.5 5.33', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5' }]);

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

	// Tracks the last assistant message element for streaming updates
	private _streamingMessageEl: HTMLElement | undefined;

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService, hoverService);

		this._register(this.chatService.onDidReceiveEvent(e => this._handleChatEvent(e)));
		this._register(this.chatService.onDidChangeSession(() => this._onSessionChanged()));
		this._register(this.daemonService.onDidChangeState(() => {
			this._updateHeader();
			this._updateState();
		}));
		this._register(this.repoService.onDidChangeRepos(() => this._updateHeader()));
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

		const intentSelect = dom.append(toolbar, dom.$('select.insrc-chat-intent-select')) as HTMLSelectElement;
		for (const intent of ['Auto', 'Implement', 'Refactor', 'Debug', 'Test', 'Design', 'Brainstorm', 'Plan', 'Review', 'Research']) {
			const opt = dom.append(intentSelect, dom.$('option')) as HTMLOptionElement;
			opt.value = intent.toLowerCase();
			opt.textContent = intent;
		}

		const attachBtn = dom.append(toolbar, dom.$('button.insrc-chat-attach-btn')) as HTMLButtonElement;
		attachBtn.title = 'Attach files';
		attachBtn.appendChild(ATTACH_ICON());
		this._register(dom.addDisposableListener(attachBtn, 'click', () => this._pickAttachFiles()));

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
				this._renderMessage(event.message);
				break;
			case 'gate':
				this._renderGate(event.gate);
				break;
			case 'progress':
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

		const content = dom.append(el, dom.$('.insrc-chat-message-content'));

		if (isUser) {
			// User messages are plain text
			content.textContent = msg.content;
		} else {
			// Assistant messages contain HTML from the daemon -- render as trusted HTML
			this._setTrustedHtml(content, msg.content);
			// Wire copy buttons for code-viewer blocks
			this._wireCopyButtons(content);
			// Make collapsible if long
			this._makeCollapsible(el, content);
		}

		return el;
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
					navigator.clipboard.writeText(pre.textContent ?? '');
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

		this._sendBtn.style.display = '';
		this._cancelBtn.style.display = 'none';
		this._sendBtn.disabled = false;
		this._input.disabled = false;
		this._input.focus();
	}

	// ---------------------------------------------------------------------------
	// Actions
	// ---------------------------------------------------------------------------

	private async _send(): Promise<void> {
		const text = this._input.value.trim();
		if (!text) {
			return;
		}

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

		// Prepend attached file paths to message
		let fullMessage = text;
		if (this._attachedFiles.length > 0) {
			const refs = this._attachedFiles.map(f => `@${f}`).join(' ');
			fullMessage = `${refs}\n${text}`;
			this._attachedFiles = [];
			this._renderAttachedFiles();
		}

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
