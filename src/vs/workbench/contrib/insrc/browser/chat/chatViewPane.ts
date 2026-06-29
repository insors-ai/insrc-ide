/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ChatViewPane -- sidebar view that drives analyze.run.start.
 *
 * U1 surface:
 *   - A scope badge at the top showing the active workspace folder
 *     (the analyze pipeline uses { kind: 'workspace', value: <path> }).
 *   - A scrollable message list (user prompt + assistant progress + a
 *     final "report ready" affordance).
 *   - A textarea + Send button at the bottom.
 *
 * On Send, calls IInsrcChatService.sendMessage(text). The service
 * fires onDidReceiveEvent events as the daemon's streaming RPC emits
 * frames; this pane subscribes + appends to the message list. When
 * the terminal `analyze-result` frame arrives, this pane writes the
 * formatted markdown to the AnalyzeReportInput's backing file and
 * opens it in the editor area (per the user's stated UX: final
 * output renders in the editor panel).
 *
 * Per-step granular streaming (the live "steps + step outputs" widget)
 * lands in U2 and replaces the simple text rendering this commit uses.
 * U2 will swap _appendProgress() for a structured component without
 * touching the service layer or the report-opening flow.
 */

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
	private _inputEl!: HTMLTextAreaElement;
	private _sendBtn!: HTMLButtonElement;
	private _emptyHint!: HTMLElement;

	/** Per-runId live-steps widget (U2). Each run gets its own
	 *  structured progress display embedded in the message list. */
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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService,
			viewDescriptorService, instantiationService, openerService, themeService, telemetryService,
			hoverService);

		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this._renderScopeBadge();
			this._rehydrateFromHistory();
		}));

		this._register(this.chatService.onDidReceiveEvent(e => this._handleServiceEvent(e)));

		// Rerender history when chat service signals it (e.g. clear, or
		// workspace switch). The pane stays in sync without explicit
		// callers re-reading the storage.
		this._register(this.chatService.onDidChangeMessages(() => {
			// Don't rehydrate when the pane's already showing a live
			// stream -- in that case onDidChangeMessages fires because
			// we just appended an event, and the live frame handler is
			// already updating the DOM. Only re-render from history
			// when no run is in progress.
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
		container.style.display = 'flex';
		container.style.flexDirection = 'column';
		container.style.height = '100%';
		container.style.minHeight = '0';

		// Scope badge -- small row showing the active workspace folder.
		const header = dom.append(container, dom.$('.insrc-chat-header'));
		header.style.padding = '4px 8px';
		header.style.fontSize = '11px';
		header.style.opacity = '0.75';
		header.style.borderBottom = '1px solid var(--vscode-panel-border)';

		const icon = dom.append(header, dom.$('span.codicon.codicon-folder'));
		icon.style.marginRight = '4px';
		this._scopeBadge = dom.append(header, dom.$('span.insrc-chat-scope'));
		this._renderScopeBadge();

		// Message list (scrollable).
		this._messagesEl = dom.append(container, dom.$('.insrc-chat-messages'));
		this._messagesEl.style.flex = '1 1 auto';
		this._messagesEl.style.minHeight = '0';
		this._messagesEl.style.overflowY = 'auto';
		this._messagesEl.style.padding = '8px';
		this._messagesEl.style.display = 'flex';
		this._messagesEl.style.flexDirection = 'column';
		this._messagesEl.style.gap = '8px';

		this._emptyHint = dom.append(this._messagesEl, dom.$('div.insrc-chat-empty'));
		this._emptyHint.textContent = localize('chatEmpty', 'Type a prompt below to start an analyze run.');
		this._emptyHint.style.opacity = '0.6';
		this._emptyHint.style.fontSize = '12px';
		this._emptyHint.style.padding = '16px 8px';
		this._emptyHint.style.textAlign = 'center';

		// Input row.
		const inputRow = dom.append(container, dom.$('.insrc-chat-input-row'));
		inputRow.style.display = 'flex';
		inputRow.style.flexDirection = 'column';
		inputRow.style.gap = '4px';
		inputRow.style.padding = '8px';
		inputRow.style.borderTop = '1px solid var(--vscode-panel-border)';

		this._inputEl = dom.append(inputRow, dom.$('textarea.insrc-chat-input')) as HTMLTextAreaElement;
		this._inputEl.rows = 3;
		this._inputEl.placeholder = localize('chatPlaceholder', 'What would you like to analyze?');
		this._inputEl.style.resize = 'vertical';
		this._inputEl.style.fontFamily = 'var(--vscode-font-family)';
		this._inputEl.style.fontSize = '13px';
		this._inputEl.style.padding = '6px 8px';
		this._inputEl.style.background = 'var(--vscode-input-background)';
		this._inputEl.style.color = 'var(--vscode-input-foreground)';
		this._inputEl.style.border = '1px solid var(--vscode-input-border)';
		this._inputEl.style.borderRadius = '2px';

		const sendRow = dom.append(inputRow, dom.$('.insrc-chat-send-row'));
		sendRow.style.display = 'flex';
		sendRow.style.justifyContent = 'flex-end';

		this._sendBtn = dom.append(sendRow, dom.$('button.insrc-chat-send')) as HTMLButtonElement;
		this._sendBtn.textContent = localize('chatSend', 'Send');
		this._sendBtn.style.padding = '4px 12px';
		this._sendBtn.style.cursor = 'pointer';
		this._sendBtn.style.background = 'var(--vscode-button-background)';
		this._sendBtn.style.color = 'var(--vscode-button-foreground)';
		this._sendBtn.style.border = 'none';
		this._sendBtn.style.borderRadius = '2px';

		this._register(dom.addDisposableListener(this._sendBtn, 'click', () => this._onSendClicked()));
		this._register(dom.addDisposableListener(this._inputEl, 'keydown', (e: KeyboardEvent) => {
			// Cmd/Ctrl + Enter submits.
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this._onSendClicked();
			}
		}));

		// U4: restore persisted history on first render (and on every
		// workspace switch via onDidChangeMessages).
		this._rehydrateFromHistory();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		// The flex layout handles internal sizing; nothing to do here beyond
		// letting the browser reflow.
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
		this._hideEmptyHint();
		// Fire-and-forget. chatService dispatches user-message events
		// back through onDidReceiveEvent which renders the bubble.
		this.chatService.sendMessage(text).catch(err => {
			this.logService.error('[insrc-chat] sendMessage failed', err);
			this._appendMessage({
				runId: 'unknown', role: 'error',
				element: this._buildBubble('error', String(err))
			});
		});
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
					element: this._buildBubble('user', String(e['content'] ?? '')),
				});
				return;
			case 'progress':
				this._updateLiveSteps(runId, this._eventToStepsEvent(e));
				return;
			case 'analyze-result':
				this._handleAnalyzeResult(runId, e['result']);
				return;
			case 'streamEnd':
				// Flip any leftover in-progress rows to a terminal state
				// so the user doesn't see an indefinite spinner if the
				// stream dropped mid-run.
				this._liveStepsByRun.get(runId)?.finalize();
				return;
			case 'streamError':
				this._appendMessage({
					runId,
					role: 'error',
					element: this._buildBubble('error', String(e['message'] ?? 'Stream error.')),
				});
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
			// Scroll into view when the widget first appears.
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
		return out;
	}

	private async _handleAnalyzeResult(runId: string, resultRaw: unknown): Promise<void> {
		const result = resultRaw as {
			ok: boolean;
			runId?: string;
			intent?: unknown;
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
				element: this._buildBubble('assistant',
					localize('chatComplete', 'Analysis complete. See the report editor tab.')),
			});
		} else {
			const code = result.error?.code ?? 'unknown';
			const message = result.error?.message ?? 'Run failed without a structured error.';
			this._appendMessage({
				runId,
				role: 'error',
				element: this._buildBubble('error', `Failed at stage='${result.stage ?? '?'}' (${code}): ${message}`),
			});
		}
	}

	private async _openReportEditor(runId: string, markdown: string): Promise<void> {
		const input = new AnalyzeReportInput(runId);
		// Ensure the backing file exists, then overwrite it with the
		// formatted markdown. EphemeralEditorInput.ensureBackingFile is
		// idempotent + creates the seed content; we always overwrite
		// after.
		await input.ensureBackingFile(this.fileService);
		await this.fileService.writeFile(input.resource, VSBuffer.fromString(markdown));
		await this.editorService.openEditor(input);
	}

	// -------------------------------------------------------------------------
	// DOM helpers
	// -------------------------------------------------------------------------

	private _appendMessage(node: MessageNode): void {
		this._hideEmptyHint();
		this._messagesEl.appendChild(node.element);
		// Scroll to bottom so the newest bubble is visible.
		this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
	}

	private _buildBubble(role: 'user' | 'assistant' | 'error', text: string): HTMLElement {
		const bubble = dom.$(`div.insrc-chat-bubble.insrc-chat-bubble-${role}`);
		bubble.style.padding = '6px 10px';
		bubble.style.borderRadius = '4px';
		bubble.style.fontSize = '13px';
		bubble.style.lineHeight = '1.4';
		bubble.style.whiteSpace = 'pre-wrap';
		bubble.style.wordBreak = 'break-word';
		switch (role) {
			case 'user':
				bubble.style.background = 'var(--vscode-textBlockQuote-background)';
				bubble.style.alignSelf = 'flex-end';
				bubble.style.maxWidth = '80%';
				break;
			case 'assistant':
				bubble.style.background = 'var(--vscode-editor-background)';
				bubble.style.border = '1px solid var(--vscode-panel-border)';
				bubble.style.alignSelf = 'flex-start';
				bubble.style.maxWidth = '80%';
				break;
			case 'error':
				bubble.style.background = 'var(--vscode-inputValidation-errorBackground)';
				bubble.style.color = 'var(--vscode-inputValidation-errorForeground)';
				bubble.style.alignSelf = 'flex-start';
				bubble.style.maxWidth = '90%';
				break;
		}
		bubble.textContent = text;
		return bubble;
	}

	private _renderScopeBadge(): void {
		const workspace = this.workspaceService.getWorkspace();
		const folder = workspace.folders[0];
		if (folder !== undefined) {
			this._scopeBadge.textContent = folder.name;
			this._scopeBadge.title = folder.uri.fsPath;
		} else {
			this._scopeBadge.textContent = localize('chatNoFolder', '(no workspace folder)');
			this._scopeBadge.title = '';
		}
	}

	private _hideEmptyHint(): void {
		if (this._emptyHint?.style.display !== 'none') {
			this._emptyHint.style.display = 'none';
		}
	}

	// -------------------------------------------------------------------------
	// U4: history rehydration
	// -------------------------------------------------------------------------

	/**
	 * Wipe the messages list + repopulate from chatService.getMessages().
	 * Called on first render, on workspace switch, and whenever the
	 * service signals onDidChangeMessages while no run is in flight.
	 *
	 * Live progress (LiveStepsWidget) is intentionally NOT restored --
	 * those events are ephemeral per run; the persisted history only
	 * carries the user prompt + the terminal assistant / error
	 * message. Past runs that completed show a clickable "Open report"
	 * affordance so the user can re-open the markdown editor tab
	 * without re-running.
	 */
	private _rehydrateFromHistory(): void {
		if (!this._messagesEl) {
			// Not rendered yet; renderBody calls us again on mount.
			return;
		}
		// Tear down existing bubbles + reset the empty hint visibility.
		while (this._messagesEl.firstChild !== null && this._messagesEl.firstChild !== this._emptyHint) {
			this._messagesEl.removeChild(this._messagesEl.firstChild);
		}
		// Same for elements after the hint (the hint sits at the top).
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
	}

	/**
	 * Build a persisted-message bubble. Differs from _buildBubble in
	 * that completed assistant messages get a clickable "Open report"
	 * link (re-opens the AnalyzeReportInput editor tab for that run).
	 */
	private _buildHistoryBubble(m: IChatMessage): HTMLElement {
		const role = m.role === 'error' ? 'error' : (m.role === 'user' ? 'user' : 'assistant');
		const bubble = this._buildBubble(role, m.content);

		if (m.status === 'completed' && m.reportRunId !== undefined) {
			const openLink = dom.append(bubble, dom.$('a.insrc-chat-report-link'));
			openLink.textContent = localize('chatOpenReport', 'Open report');
			openLink.style.display = 'block';
			openLink.style.marginTop = '6px';
			openLink.style.fontSize = '12px';
			openLink.style.color = 'var(--vscode-textLink-foreground)';
			openLink.style.cursor = 'pointer';
			openLink.style.textDecoration = 'underline';
			const runId = m.reportRunId;
			this._register(dom.addDisposableListener(openLink, 'click', e => {
				e.preventDefault();
				this._reopenReportEditor(runId).catch(err => {
					this.logService.error('[insrc-chat] failed to re-open report editor', err);
					this.notificationService.warn(localize('chatReportReopenFailed',
						'Could not re-open the report editor: {0}', (err as Error).message));
				});
			}));
		}
		return bubble;
	}

	private async _reopenReportEditor(runId: string): Promise<void> {
		const input = new AnalyzeReportInput(runId);
		// If the user purged the run from disk after closing the
		// editor, ensureBackingFile recreates the placeholder template
		// (not the original report). We don't have a way to detect
		// that case here -- the report's content is lost. Best-effort
		// open + surface a notice if the file is the placeholder.
		await input.ensureBackingFile(this.fileService);
		await this.editorService.openEditor(input);
	}
}
