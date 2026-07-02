/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Sidebar chat view that drives analyze.run.start.
 *
 * Visual language preserved from the pre-cleanup chat panel
 * (rebuilt in commits 8a5ad7823d9 / 98b3384e8d9): asymmetric
 * speech bubbles, sticky progress strip above the input, live-
 * console widget for streaming step output. The original was an
 * editor pane; this sidebar-form-factor version drops the
 * multi-select toolbar + session dropdown + attachment chips that
 * would crowd a narrow column. The rest of the look + feel
 * matches the recovered design.
 *
 * Per-step granular streaming continues to render via
 * LiveStepsWidget; the pane embeds it inline within the message
 * list during a run, then leaves it visible after the run
 * completes so users can scroll back through what executed.
 *
 * Visual tokens come from browser/chat/media/chat.css; this file
 * is structure-only (DOM building + event wiring) so the original
 * theme can be tweaked without rebuilding the pane class.
 */

import './media/chat.css';

import * as dom from '../../../../../base/browser/dom.js';
import { localize } from '../../../../../nls.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
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
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IInsrcChatService, type IChatMessage } from '../../common/chatService.js';

import { AnalyzeReportInput } from './analyzeReportInput.js';
import { formatAggregateReport, type AggregateReportLike } from './aggregateReportMarkdown.js';
import { LiveStepsWidget, type LiveStepsEvent } from './liveStepsWidget.js';

export const INSRC_CHAT_VIEW_ID = 'insrc.chatView';

interface MessageNode {
	readonly runId: string;
	readonly role: 'user' | 'assistant' | 'system' | 'error';
	readonly element: HTMLElement;
}

export class InsrcChatViewPane extends ViewPane {

	private _scopeBadge!: HTMLElement;
	private _messagesEl!: HTMLElement;
	private _emptyHint!: HTMLElement;
	private _progressEl!: HTMLElement;
	private _progressTextEl!: HTMLElement;
	private _progressIntentBadge!: HTMLElement;
	private _progressScopeBadge!: HTMLElement;
	private _inputEl!: HTMLTextAreaElement;
	private _sendBtn!: HTMLButtonElement;

	/** Per-runId live-steps widget. One run = one structured progress
	 *  block embedded between the user prompt + the terminal assistant
	 *  bubble. */
	private readonly _liveStepsByRun = new Map<string, LiveStepsWidget>();

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
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@IEditorService private readonly editorService: IEditorService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService,
			viewDescriptorService, instantiationService, openerService, themeService, telemetryService,
			hoverService);

		// Workspace folder set changed (rare): just refresh the badge --
		// the chatService's own listener handles message reload.
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this._renderScopeBadge();
		}));

		// Active scope changed (workspace folder OR active editor moved
		// to a different root). Refresh the badge; the chatService fires
		// onDidChangeMessages separately if the message list changed.
		this._register(this.chatService.onDidChangeActiveScope(() => {
			this._renderScopeBadge();
		}));

		this._register(this.chatService.onDidReceiveEvent(e => this._handleServiceEvent(e)));

		// History rehydration: re-render the message list from
		// persisted storage when the chat service signals a change
		// (workspace switch / explicit clear). Skip the rehydrate
		// while a stream is in flight -- the live frame handler is
		// already updating the DOM + we'd double-render.
		this._register(this.chatService.onDidChangeMessages(() => {
			if (!this.chatService.isStreaming) {
				this._rehydrateFromHistory();
			}
		}));
	}

	// -------------------------------------------------------------------------
	// ViewPane lifecycle
	// -------------------------------------------------------------------------

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		container.classList.add('insrc-chat-pane');

		// Header: folder icon + clickable scope badge (pick from multi-root)
		// + clear-history affordance.
		const header = dom.append(container, dom.$('.insrc-chat-header'));
		const scopeBtn = dom.append(header, dom.$('button.insrc-chat-scope-btn')) as HTMLButtonElement;
		dom.append(scopeBtn, dom.$('span.codicon.codicon-folder'));
		this._scopeBadge = dom.append(scopeBtn, dom.$('span.insrc-chat-scope'));
		dom.append(scopeBtn, dom.$('span.codicon.codicon-chevron-down.insrc-chat-scope-chevron'));
		scopeBtn.title = localize('chatPickScope', 'Pick the workspace folder this chat is scoped to');
		this._register(dom.addDisposableListener(scopeBtn, 'click', () => this._onScopePick()));

		const clearBtn = dom.append(header, dom.$('span.insrc-chat-clear.codicon.codicon-clear-all'));
		clearBtn.title = localize('chatClearHistory', 'Clear chat history for this workspace');
		this._register(dom.addDisposableListener(clearBtn, 'click', () => this._onClearHistory()));
		this._renderScopeBadge();

		// Scrollable message list.
		this._messagesEl = dom.append(container, dom.$('.insrc-chat-messages'));
		this._emptyHint = dom.append(this._messagesEl, dom.$('div.insrc-chat-empty'));
		const hintTitle = dom.append(this._emptyHint, dom.$('div.insrc-chat-empty-title'));
		hintTitle.textContent = localize('chatEmpty',
			'Type a prompt below and press Send (⌘/Ctrl+↩︎) to start an analyze run.');
		const hintSlash = dom.append(this._emptyHint, dom.$('div.insrc-chat-empty-slash'));
		hintSlash.textContent = localize('chatEmptySlash', 'Force a target with a slash command at the start: /code, /data, /infra, /generic. Add :xs|s|m|l|xl to pin scope (e.g. /code:l map the architecture).');

		// Sticky progress strip above the input. Hidden by default; the
		// streaming handler toggles `show` when a run is live.
		this._progressEl = dom.append(container, dom.$('.insrc-chat-progress'));
		dom.append(this._progressEl, dom.$('span.codicon.codicon-loading.codicon-modifier-spin'));
		this._progressTextEl = dom.append(this._progressEl, dom.$('span.insrc-chat-progress-text'));
		this._progressTextEl.textContent = localize('chatProgressIdle', 'Starting…');
		this._progressIntentBadge = dom.append(this._progressEl, dom.$('span.insrc-chat-progress-badge'));
		this._progressScopeBadge = dom.append(this._progressEl, dom.$('span.insrc-chat-progress-badge.scope'));
		this._progressIntentBadge.style.display = 'none';
		this._progressScopeBadge.style.display = 'none';

		// Input area.
		const inputArea = dom.append(container, dom.$('.insrc-chat-input-area'));
		const inputRow = dom.append(inputArea, dom.$('.insrc-chat-input-row'));
		this._inputEl = dom.append(inputRow, dom.$('textarea.insrc-chat-input')) as HTMLTextAreaElement;
		this._inputEl.rows = 1;
		this._inputEl.placeholder = localize('chatPlaceholder', 'What would you like to analyze?');
		this._sendBtn = dom.append(inputRow, dom.$('button.insrc-chat-icon-btn')) as HTMLButtonElement;
		dom.append(this._sendBtn, dom.$('span.codicon.codicon-send'));
		this._sendBtn.title = localize('chatSendTooltip', 'Send (⌘/Ctrl+↩︎)');

		const hint = dom.append(inputArea, dom.$('div.insrc-chat-input-hint'));
		hint.textContent = localize('chatInputHint', '⌘/Ctrl+↩︎ to send · Shift+↩︎ for newline');

		this._register(dom.addDisposableListener(this._sendBtn, 'click', () => this._onSendClicked()));
		this._register(dom.addDisposableListener(this._inputEl, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this._onSendClicked();
			}
		}));
		this._register(dom.addDisposableListener(this._inputEl, 'input', () => this._autosizeInput()));

		// First-render restore from persisted history.
		this._rehydrateFromHistory();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	// -------------------------------------------------------------------------
	// Send handler
	// -------------------------------------------------------------------------

	private _onSendClicked(): void {
		const text = this._inputEl.value;
		if (text.trim().length === 0) { return; }
		if (this.chatService.isStreaming) {
			this.notificationService.warn(localize('chatBusy',
				'A run is already in progress. Wait for it to finish before starting a new one.'));
			return;
		}
		this._inputEl.value = '';
		this._autosizeInput();
		this._hideEmptyHint();
		this._showProgress(localize('chatProgressStarting', 'Starting analyze run…'));
		this.chatService.sendMessage(text).catch(err => {
			this.logService.error('[insrc-chat] sendMessage failed', err);
			this._hideProgress();
			this._appendMessage({
				runId: 'unknown',
				role: 'error',
				element: this._buildErrorBubble(String(err)),
			});
		});
	}

	private async _onScopePick(): Promise<void> {
		const workspace = this.workspaceService.getWorkspace();
		const folders = workspace.folders;
		if (folders.length === 0) {
			this.notificationService.info(localize('chatNoFoldersToPick',
				'No workspace folder open. Open a folder + try again.'));
			return;
		}

		const currentPath = this.chatService.activeScopePath;
		const items: (IQuickPickItem & { path?: string | undefined })[] = folders.map(f => ({
			label: f.name,
			description: f.uri.fsPath,
			path: f.uri.fsPath,
			picked: f.uri.fsPath === currentPath,
		}));

		// "Auto" lets the user clear an existing pin + go back to
		// active-editor-driven scope.
		const hasPin = this.chatService.pinnedScopePath !== undefined;
		if (hasPin) {
			items.unshift({
				label: localize('chatScopeAuto', '$(sync) Auto (follow active editor)'),
				description: localize('chatScopeAutoDescription', 'Track whichever folder the focused editor belongs to'),
				path: undefined,
			});
		}

		const pick = await this.quickInputService.pick(items, {
			placeHolder: localize('chatPickScopePlaceholder',
				'Pick the workspace folder this chat is scoped to'),
		});
		if (!pick) {
			return;
		}
		this.chatService.setPinnedScope((pick as { path?: string }).path);
	}

	private _onClearHistory(): void {
		if (this.chatService.isStreaming) {
			this.notificationService.warn(localize('chatClearBusy',
				'A run is in progress; wait for it to finish before clearing history.'));
			return;
		}
		this.chatService.clearMessages();
	}

	private _autosizeInput(): void {
		const el = this._inputEl;
		// Reset height to recalc scrollHeight; cap via CSS max-height.
		el.style.height = '0px';
		const next = Math.min(el.scrollHeight, 160);
		el.style.height = `${Math.max(next, 32)}px`;
	}

	// -------------------------------------------------------------------------
	// Service-event dispatcher
	// -------------------------------------------------------------------------

	private _handleServiceEvent(e: { type: string;[key: string]: unknown }): void {
		const runId = typeof e['runId'] === 'string' ? e['runId'] as string : 'unknown';
		switch (e.type) {
			case 'userMessage':
				this._hideEmptyHint();
				this._appendMessage({
					runId,
					role: 'user',
					element: this._buildBubble({
						role: 'user',
						content: String(e['content'] ?? ''),
						timestamp: new Date().toISOString(),
					}),
				});
				return;
			case 'progress':
				this._updateLiveSteps(runId, this._eventToStepsEvent(e));
				this._updateProgressStrip(e);
				return;
			case 'analyze-result':
				this._handleAnalyzeResult(runId, e['result']);
				return;
			case 'streamEnd':
				this._liveStepsByRun.get(runId)?.finalize();
				this._hideProgress();
				return;
			case 'streamError':
				this._appendMessage({
					runId,
					role: 'error',
					element: this._buildErrorBubble(String(e['message'] ?? 'Stream error.')),
				});
				this._hideProgress();
				return;
			default:
				return;
		}
	}

	private _updateLiveSteps(runId: string, event: LiveStepsEvent): void {
		let widget = this._liveStepsByRun.get(runId);
		if (widget === undefined) {
			this._hideEmptyHint();
			widget = new LiveStepsWidget(this._messagesEl);
			this._liveStepsByRun.set(runId, widget);
			this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
		}
		widget.update(event);
	}

	private _eventToStepsEvent(e: { type: string;[key: string]: unknown }): LiveStepsEvent {
		const out: LiveStepsEvent = {
			step: String(e['step'] ?? ''),
			status: String(e['status'] ?? ''),
		};
		if (typeof e['taskId'] === 'string') { (out as { taskId?: string }).taskId = e['taskId'] as string; }
		if (typeof e['template'] === 'string') { (out as { template?: string }).template = e['template'] as string; }
		if (typeof e['index'] === 'number') { (out as { index?: number }).index = e['index'] as number; }
		if (typeof e['total'] === 'number') { (out as { total?: number }).total = e['total'] as number; }
		if (typeof e['parentTaskPath'] === 'string') { (out as { parentTaskPath?: string }).parentTaskPath = e['parentTaskPath'] as string; }
		if (typeof e['substep'] === 'string') { (out as { substep?: string }).substep = e['substep'] as string; }
		if (typeof e['detail'] === 'string') { (out as { detail?: string }).detail = e['detail'] as string; }
		return out;
	}

	private async _handleAnalyzeResult(runId: string, resultRaw: unknown): Promise<void> {
		const result = resultRaw as {
			ok: boolean;
			runId?: string;
			intent?: { target?: string; scope?: string };
			finalReport?: unknown;
			error?: { code: string; message: string };
			stage?: string;
		};

		if (result.ok === true) {
			const report = result.finalReport as AggregateReportLike | undefined;
			const markdown = formatAggregateReport(report);
			try {
				await this._openReportEditor(runId, markdown);
			} catch (err) {
				this.logService.error('[insrc-chat] failed to open report editor', err);
				this.notificationService.error(localize('chatReportOpenFailed',
					'Analysis complete but the report editor could not open: {0}',
					(err as Error).message));
			}
			this._appendMessage({
				runId,
				role: 'assistant',
				element: this._buildBubble({
					role: 'assistant',
					content: localize('chatComplete', 'Analysis complete. See the report editor tab.'),
					timestamp: new Date().toISOString(),
					reportRunId: runId,
				}),
			});
		} else {
			const code = result.error?.code ?? 'unknown';
			const message = result.error?.message ?? 'Run failed without a structured error.';
			this._appendMessage({
				runId,
				role: 'error',
				element: this._buildErrorBubble(
					`${localize('chatFailedAt', 'Failed at stage')} '${result.stage ?? '?'}' (${code}): ${message}`,
				),
			});
		}
	}

	private async _openReportEditor(runId: string, markdown: string): Promise<void> {
		const input = new AnalyzeReportInput(runId);
		await input.ensureBackingFile(this.fileService);
		await this.fileService.writeFile(input.resource, VSBuffer.fromString(markdown));
		await this.editorService.openEditor(input);
	}

	// -------------------------------------------------------------------------
	// Progress strip
	// -------------------------------------------------------------------------

	private _showProgress(text: string): void {
		this._progressEl.classList.add('show');
		this._progressTextEl.textContent = text;
		this._progressIntentBadge.style.display = 'none';
		this._progressScopeBadge.style.display = 'none';
	}

	private _updateProgressStrip(e: { [key: string]: unknown }): void {
		if (!this._progressEl.classList.contains('show')) {
			this._progressEl.classList.add('show');
		}
		const step = String(e['step'] ?? '');
		const status = String(e['status'] ?? '');
		this._progressTextEl.textContent = this._formatProgressText(e, step, status);

		// Capture target + scope off the classified event to pin the
		// run's nature on the strip. Once set, badges stick for the
		// rest of the run.
		if (e['intent'] !== undefined && typeof e['intent'] === 'object' && e['intent'] !== null) {
			const intent = e['intent'] as { target?: string; scope?: string };
			if (typeof intent.target === 'string' && intent.target.length > 0) {
				this._progressIntentBadge.textContent = intent.target;
				this._progressIntentBadge.style.display = '';
			}
			if (typeof intent.scope === 'string' && intent.scope.length > 0) {
				this._progressScopeBadge.textContent = intent.scope;
				this._progressScopeBadge.style.display = '';
			}
		}
	}

	private _formatProgressText(e: { [key: string]: unknown }, step: string, status: string): string {
		const template = typeof e['template'] === 'string' ? e['template'] as string : undefined;
		const index = typeof e['index'] === 'number' ? e['index'] as number : undefined;
		const total = typeof e['total'] === 'number' ? e['total'] as number : undefined;
		if (template !== undefined && index !== undefined && total !== undefined) {
			return `${template}  ·  ${index}/${total}`;
		}
		// stage-substep events break the silence between stage-started
		// and the next stage-completed. Prefer the detail line -- e.g.
		// "plan: building code/M run bundle" -- over the raw wire
		// status "substep-bundle-shaper".
		const substep = typeof e['substep'] === 'string' ? e['substep'] as string : undefined;
		if (substep !== undefined) {
			const detail = typeof e['detail'] === 'string' ? e['detail'] as string : undefined;
			return `${step}: ${detail !== undefined && detail.length > 0 ? detail : substep}`;
		}
		return `${step}: ${status}`;
	}

	private _hideProgress(): void {
		this._progressEl.classList.remove('show');
		this._progressIntentBadge.style.display = 'none';
		this._progressScopeBadge.style.display = 'none';
	}

	// -------------------------------------------------------------------------
	// Message bubbles
	// -------------------------------------------------------------------------

	private _appendMessage(node: MessageNode): void {
		this._hideEmptyHint();
		this._messagesEl.appendChild(node.element);
		this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
	}

	private _buildBubble(opts: {
		role: 'user' | 'assistant';
		content: string;
		timestamp: string;
		reportRunId?: string | undefined;
	}): HTMLElement {
		const bubble = dom.$(`div.insrc-chat-message.msg-${opts.role}`);

		const header = dom.append(bubble, dom.$('div.insrc-chat-message-header'));
		const author = dom.append(header, dom.$('span.insrc-chat-message-author'));
		author.textContent = opts.role === 'user'
			? localize('chatYou', 'You')
			: localize('chatAgent', 'Agent');
		const time = dom.append(header, dom.$('span.insrc-chat-message-time'));
		time.textContent = this._formatTimestamp(opts.timestamp);

		const body = dom.append(bubble, dom.$('div.insrc-chat-message-body'));
		body.textContent = opts.content;

		if (opts.role === 'assistant' && opts.reportRunId !== undefined) {
			const runIdRef = opts.reportRunId;
			const link = dom.append(bubble, dom.$('a.insrc-chat-report-link'));
			link.textContent = localize('chatOpenReport', 'Open report');
			this._register(dom.addDisposableListener(link, 'click', e => {
				e.preventDefault();
				this._reopenReportEditor(runIdRef).catch(err => {
					this.logService.error('[insrc-chat] failed to re-open report editor', err);
					this.notificationService.warn(localize('chatReportReopenFailed',
						'Could not re-open the report editor: {0}', (err as Error).message));
				});
			}));
		}
		return bubble;
	}

	private _buildErrorBubble(text: string): HTMLElement {
		const bubble = dom.$('div.insrc-chat-message.msg-error');
		const header = dom.append(bubble, dom.$('div.insrc-chat-message-header'));
		const author = dom.append(header, dom.$('span.insrc-chat-message-author'));
		author.textContent = localize('chatError', 'Error');
		const time = dom.append(header, dom.$('span.insrc-chat-message-time'));
		time.textContent = this._formatTimestamp(new Date().toISOString());
		const body = dom.append(bubble, dom.$('div.insrc-chat-message-body'));
		body.textContent = text;
		return bubble;
	}

	private _formatTimestamp(iso: string): string {
		try {
			const d = new Date(iso);
			const hh = String(d.getHours()).padStart(2, '0');
			const mm = String(d.getMinutes()).padStart(2, '0');
			return `${hh}:${mm}`;
		} catch {
			return '';
		}
	}

	// -------------------------------------------------------------------------
	// Scope badge / empty hint
	// -------------------------------------------------------------------------

	private _renderScopeBadge(): void {
		const path = this.chatService.activeScopePath;
		if (path === undefined) {
			this._scopeBadge.textContent = localize('chatNoFolder', '(no workspace folder)');
			this._scopeBadge.title = '';
			return;
		}
		// Look the folder up to get its display name.
		const workspace = this.workspaceService.getWorkspace();
		const folder = workspace.folders.find(f => f.uri.fsPath === path);
		if (folder !== undefined) {
			this._scopeBadge.textContent = folder.name;
			this._scopeBadge.title = folder.uri.fsPath;
		} else {
			// Folder not in the multi-root set; show the basename of the
			// path as a best-effort label.
			const slash = path.lastIndexOf('/');
			this._scopeBadge.textContent = slash >= 0 ? path.slice(slash + 1) : path;
			this._scopeBadge.title = path;
		}
	}

	private _hideEmptyHint(): void {
		if (this._emptyHint?.style.display !== 'none') {
			this._emptyHint.style.display = 'none';
		}
	}

	// -------------------------------------------------------------------------
	// History rehydration
	// -------------------------------------------------------------------------

	private _rehydrateFromHistory(): void {
		if (!this._messagesEl) { return; }
		while (this._messagesEl.firstChild !== null && this._messagesEl.firstChild !== this._emptyHint) {
			this._messagesEl.removeChild(this._messagesEl.firstChild);
		}
		while (this._messagesEl.lastChild !== null && this._messagesEl.lastChild !== this._emptyHint) {
			this._messagesEl.removeChild(this._messagesEl.lastChild);
		}
		this._liveStepsByRun.clear();

		const messages = this.chatService.getMessages();
		if (messages.length === 0) {
			this._emptyHint.style.display = '';
			return;
		}
		this._hideEmptyHint();
		for (const m of messages) {
			this._appendMessage({
				runId: m.runId ?? 'history',
				role: m.role,
				element: this._buildHistoryBubble(m),
			});
		}
		this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
	}

	private _buildHistoryBubble(m: IChatMessage): HTMLElement {
		if (m.role === 'error') {
			return this._buildErrorBubble(m.content);
		}
		return this._buildBubble({
			role: m.role,
			content: m.content,
			timestamp: m.timestamp,
			...(m.role === 'assistant' && m.status === 'completed' && m.reportRunId !== undefined
				? { reportRunId: m.reportRunId } : {}),
		});
	}

	private async _reopenReportEditor(runId: string): Promise<void> {
		const input = new AnalyzeReportInput(runId);
		await input.ensureBackingFile(this.fileService);
		await this.editorService.openEditor(input);
	}
}
