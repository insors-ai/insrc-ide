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
import { IInsrcChatService, type ChatEvent, type ChatMessage, type GateInfo, type GateActionDetail, type LiveStepInfo } from '../../common/chatService.js';
import { IInsrcBrainstormSessionService } from '../../common/brainstormSessionService.js';
import { IInsrcTodosService } from '../../common/todosService.js';
import { IInsrcHandoffService, type HandoffModeAPrompt, type HandoffModeBPrompt, type HandoffSessionState } from '../../common/handoffService.js';
import { InsrcHandoffRunner } from '../handoff/handoffRunner.js';
import { ChatTodosWidget } from './chatTodosWidget.js';
import { ChatArtifactWidget } from './chatArtifactWidget.js';
import { ChatHandoffWidget } from './chatHandoffWidget.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IInsrcRepoService } from '../../common/repoService.js';
import { IInsrcDaemonService } from '../../common/daemonService.js';
import { IInsrcDiffService, extractDiffFromResponse, parseDiff, applyHunks } from '../../common/diffService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IFileDialogService, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { clearNode } from '../../../../../base/browser/dom.js';
import { createTrustedTypesPolicy } from '../../../../../base/browser/trustedTypes.js';
import { SLASH_COMMANDS } from '../../common/slashCommands.js';

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

/**
 * Intents offered in the chat-panel intent-confirm gate's dropdown
 * (Item 12). Matches the daemon's VALID_INTENTS in chat-handler.ts.
 */
const CHAT_GATE_INTENTS: readonly string[] = [
	'implement', 'refactor', 'test', 'debug', 'review', 'document',
	'research', 'code-analysis', 'plan', 'requirements', 'design',
	'brainstorm', 'deploy', 'release', 'infra',
];

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


	/**
	 * Mode B prompt queue (Phase 3). Per-modal we await the user's
	 * verdict before showing the next; the daemon serializes prompts
	 * inside a single agent run but a burst from a concurrent
	 * background handoff could otherwise stack overlapping dialogs.
	 *
	 * The cancel hook for each in-flight modal lives here too so the
	 * `onModeBResolution` event (timeout / cancel from the daemon
	 * side) can dismiss the dialog without waiting for the user.
	 * Each cancel is a one-shot; ignored once the modal has settled.
	 */
	private _modeBPromptChain: Promise<void> = Promise.resolve();
	private readonly _modeBPromptCancels = new Map<string, () => void>();

	/** Mode A modal cancels (Phase 3). Each in-flight Mode A dialog
	 *  registers its cancel hook here keyed by gateId so the
	 *  `onModeAResolution` event (timeout / cancel) can dismiss it. */
	private readonly _modeAPromptCancels = new Map<string, () => void>();

	/**
	 * Test-harness runner that translates `/handoff <intent>` into a
	 * daemon `handoff.run` stream and forwards events into the
	 * existing IInsrcHandoffService dispatch. Built lazily on first
	 * use so chatView creation cost is unchanged in the normal path.
	 */
	private _handoffRunnerInstance: InsrcHandoffRunner | undefined;
	private get _handoffRunner(): InsrcHandoffRunner {
		if (this._handoffRunnerInstance === undefined) {
			this._handoffRunnerInstance = this._register(
				this._instantiationService.createInstance(InsrcHandoffRunner),
			);
		}
		return this._handoffRunnerInstance;
	}
	private readonly _instantiationService: IInstantiationService;

	private _container!: HTMLElement;
	private _header!: HTMLElement;
	private _repoLabel!: HTMLElement;
	private _sessionLabel!: HTMLElement;
	private _sessionDropdown!: HTMLElement;
	private _progressBar!: HTMLElement;
	private _selectionBar!: HTMLElement;
	private _progressText!: HTMLElement;
	private _intentBadge!: HTMLElement;
	private _scopeBadge!: HTMLElement;
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

	// Item 32b: active live-step bubbles keyed by `<agent>:<step>`. Each
	// bubble accumulates tokens from one LLM call and is removed when
	// the daemon emits the matching `{ done: true }` event.
	private _liveStepBubbles = new Map<string, { el: HTMLElement; body: HTMLElement; text: string }>();

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
		@IDialogService private readonly dialogService: IDialogService,
		@IInsrcDiffService private readonly diffService: IInsrcDiffService,
		@IFileService private readonly fileService: IFileService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ICommandService private readonly commandService: ICommandService,
		@IInsrcBrainstormSessionService private readonly brainstormSession: IInsrcBrainstormSessionService,
		@IInsrcTodosService private readonly _todosService: IInsrcTodosService,
		@IInsrcHandoffService private readonly _handoffService: IInsrcHandoffService,
		@IEditorService private readonly _editorService: IEditorService,
		@ILogService private readonly _logService: ILogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService, hoverService);
		this._instantiationService = instantiationService;

		this._register(this.chatService.onDidReceiveEvent(e => this._handleChatEvent(e)));
		this._register(this.chatService.onDidChangeSession(() => this._onSessionChanged()));
		// External-agent handoff: when a handoff reaches `final`, open
		// the diff view (if there are file changes) AND render an
		// acceptance gate inline in `_gateContainer` via the standard
		// chat gate framework. The card itself carries no action
		// buttons -- accept / reject lives in the same gate surface
		// Mode A / Mode B use, so the user's mental model is uniform
		// across every handoff decision point.
		this._register(this._handoffService.onDidFinalize(state => {
			void this._openDiffFromHandoff(state);
			this._showHandoffAcceptanceGate(state);
		}));
		// Phase 3 Mode A: pre-flight permission gate. Fires once per
		// handoff before the worktree is created. Rendered INLINE in
		// `_gateContainer` (same chat surface regular gates use) so
		// the approval UX matches the rest of the chat instead of
		// popping a system modal.
		this._register(this._handoffService.onModeAPrompt(prompt => {
			this._showModeAPrompt(prompt);
		}));
		this._register(this._handoffService.onModeAResolution(res => {
			this._cancelModeAPromptIfPending(res.gateId);
		}));
		// Phase 3 Mode B: PreToolUse hook prompts. Same inline-gate
		// surface as Mode A; queued via `_modeBPromptChain` so a
		// burst of prompts renders sequentially in the single gate
		// slot rather than racing each other.
		this._register(this._handoffService.onModeBPrompt(prompt => {
			void this._enqueueModeBPrompt(prompt);
		}));
		// If the daemon resolves a prompt out-from-under us (default-deny
		// timeout, session cancel), drop any UI we still have open for it.
		this._register(this._handoffService.onModeBResolution(res => {
			this._cancelModeBPromptIfPending(res.gateId);
		}));
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
			// Item 22: when the brainstorm session flips from active to
			// inactive (user cancelled / closed / session ended), clear the
			// progress chrome so the "Clustering ideas into themes..." style
			// text doesn't linger after the flow is gone.
			if (!this.brainstormSession.isSessionActive && !this._progressBar.classList.contains('hidden')) {
				this._progressBar.classList.add('hidden');
				this._progressText.textContent = '';
			}
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

		// Inline todos widget (plans/todo-framework.md Phase 5b). Mounts
		// inside the transcript so agent-authored TODO lists surface
		// alongside the chat messages. Subscribes to IInsrcTodosService
		// directly; chatView doesn't need to route 'todos' events through
		// the main event handler.
		const todosWidget = this._register(new ChatTodosWidget(this._todosService, this._editorService, this._logService));
		todosWidget.mount(this._messageList);

		// Inline handoff widget (plans/external-agent-integration.md Phase 2b).
		// Renders one card per external-agent handoff session with live
		// streaming stdout/stderr embedded in the card body. The card
		// has NO action buttons -- accept/reject runs through the
		// chat's standard inline gate framework (rendered in
		// `_gateContainer` when handoff reaches `final`). The "Open
		// report" link routes to the HandoffReportPane (next phase).
		const openReportHandler = (state: HandoffSessionState): void => {
			// TODO(handoff-report-pane): wire to `insrc.handoff.openReport`
			// command once the pane lands. Logging the click for now
			// keeps the user-visible affordance correct without
			// blocking on the pane wiring.
			this._logService.info(`[insrc-chat] open-report click specId=${state.specId} (pane not wired yet)`);
		};
		const handoffWidget = this._register(new ChatHandoffWidget(this._handoffService, this._logService, openReportHandler));
		handoffWidget.mount(this._messageList);

		// Inline artifact widget (plans/artifact-tasks.md section 1.6). Renders
		// artifact items (Mermaid diagrams, wireframe SVG) into sandboxed
		// iframes per-card. Partitions the todos stream with
		// chatTodosWidget via `isArtifactList` so each list shows up in
		// exactly one surface.
		const artifactWidget = this._register(new ChatArtifactWidget(this._todosService, this.clipboardService, this._logService));
		artifactWidget.mount(this._messageList);

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
		this._progressText = dom.append(this._progressBar, dom.$('span.insrc-chat-progress-text'));
		// Item 8b: sticky intent badge. Rendered as a separate span inside
		// the progress bar so it stays visible even when the progress
		// text cycles through subsequent steps. Cleared on streamEnd /
		// session reset. Hidden by default (display:none via CSS class).
		this._intentBadge = dom.append(this._progressBar, dom.$('span.insrc-chat-progress-intent.hidden'));
		// Scope badge -- classifier's size estimate (S / M / L / ...)
		// shown alongside the intent so the user can see the agent's
		// read of how big the work is.
		this._scopeBadge = dom.append(this._progressBar, dom.$('span.insrc-chat-progress-scope.hidden'));

		// Input area (matches extension chat layout: rounded border, textarea + icon buttons, toolbar below)
		this._inputArea = dom.append(this._container, dom.$('.insrc-chat-input-area'));

		// Row: textarea + send/cancel buttons
		const inputRow = dom.append(this._inputArea, dom.$('.insrc-chat-input-row'));

		this._input = dom.append(inputRow, dom.$('textarea.insrc-chat-input')) as HTMLTextAreaElement;
		this._input.placeholder = 'Type a message... (@local, @sonnet for provider; / for commands)';
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
			// Slash-command autocomplete: trigger when `/` is typed
			// at the start of an empty input. setTimeout 0 so the `/`
			// has landed in the input.value before we read it / pop
			// the quick-pick.
			if (e.key === '/' && this._input.value.length === 0) {
				setTimeout(() => this._showSlashAutocomplete(), 0);
			}
		}));
		this._register(dom.addDisposableListener(this._input, 'input', () => this._autoResize()));

		// Send button (arrow icon)
		this._sendBtn = dom.append(inputRow, dom.$('button.insrc-chat-icon-btn')) as HTMLButtonElement;
		this._sendBtn.title = 'Send';
		this._sendBtn.appendChild(SEND_ICON());
		this._register(dom.addDisposableListener(this._sendBtn, 'click', () => this._send()));

		// Cancel button (circle-X icon). Behaviour depends on what's running:
		//   - Mid brainstorm session: cancel stream AND close the brainstorm
		//     session so the UI unlocks (same as closing the brainstorm tab).
		//     This is Item 21 -- the chat-panel Stop button used to only
		//     cancel the stream, leaving the composer locked.
		//   - Plain chat stream: just cancel the stream.
		this._cancelBtn = dom.append(inputRow, dom.$('button.insrc-chat-cancel-btn')) as HTMLButtonElement;
		this._cancelBtn.title = 'Cancel';
		this._cancelBtn.appendChild(CANCEL_ICON());
		this._cancelBtn.style.display = 'none';
		this._register(dom.addDisposableListener(this._cancelBtn, 'click', async () => {
			const wasBrainstorm = this.brainstormSession.isSessionActive;
			if (wasBrainstorm) {
				// Item 25: same confirmation dialog the pane-close handler uses,
				// then the unified teardown path. No more divergent flows.
				const { confirmed } = await this.dialogService.confirm({
					type: 'warning',
					message: 'Close brainstorm and end the session?',
					detail: 'Closing this pane will cancel the in-progress brainstorm. '
						+ 'The daemon stream will be terminated and any uncommitted '
						+ 'decisions will be lost.',
					primaryButton: 'End Session',
					cancelButton: 'Keep Open',
				});
				if (!confirmed) { return; }
				try {
					// User explicitly ended the session from the chat panel --
					// decision F1 says the checkpoint goes so the Runs sidebar
					// doesn't keep listing it.
					await this.chatService.cancelBrainstormSession('user-cancel-chat-panel', { discardCheckpoint: true });
				} catch {
					// Cancel / close race with an already-dead stream is harmless.
				}
				return;
			}
			// Non-brainstorm turn -- just cancel the in-flight stream.
			try {
				await this.chatService.cancelStream();
			} catch {
				// harmless
			}
		}));

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
				// The session-active flag is the primary gate; the phase check
				// below used to be a belt-and-suspenders fallback but was also
				// incorrectly suppressing OTHER agents' gates that happened to
				// share phase names like `specify` / `finalize`. Item 30: only
				// suppress when a brainstorm session is actually active.
				//
				// EXCEPTION (Item 12): the `intent-confirm` gate is intentionally
				// rendered in the chat panel itself so the user can confirm /
				// override the classified intent inline, without being thrown into
				// a dedicated editor pane. The daemon tags it via
				// `structured.itemType = 'intent-confirm'`.
				const gateCtx = event.gate.context as Record<string, unknown> | undefined;
				const gateItemType = gateCtx?.['itemType'] as string | undefined;
				// Gate kinds that always render inline in the chat panel,
				// regardless of whether a brainstorm session is active:
				//   - intent-confirm (Item 12): classifier confirmation.
				//   - resume-confirm (Item 7 / Phase C): retry / abandon
				//     choice after resume from mid-LLM checkpoint.
				const inlineInChat = gateItemType === 'intent-confirm' || gateItemType === 'resume-confirm' || gateItemType === 'handoff-proposal';
				if (this.brainstormSession.isSessionActive && !inlineInChat) {
					break;
				}
				this._renderGate(event.gate);
				break;
			}
			case 'progress':
				// Item 45: OpenPane:<kind> markers are internal signals
				// for the flow contribution, not user-facing progress
				// steps. Swallow them so the chat panel doesn't render
				// the raw marker as a pill.
				if (event.progress.step.startsWith('OpenPane:')) {
					break;
				}
				this._ingestIntentAnnouncement(event.progress.step);
				this._showProgress(event.progress.step, event.progress.status);
				break;
			case 'liveStep':
				// Item 32b: surface LLM token stream as a transient
				// dimmed bubble in the transcript so the user sees
				// presence during multi-minute agent steps.
				this._handleLiveStep(event.liveStep);
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
		if (!detected) { return; }
		// Dedup on just the primary/sub intent (not the full string) so
		// the plain secondary emission ("Intent: brainstorm/general"
		// from pipeline activation) doesn't fire a duplicate persistent
		// chat message after the detailed one ("Intent: brainstorm/
		// general [Quadruple-XL] (reasoning)"). We key off the headline
		// portion before the `[...]` scope tag + before the `(reasoning)`.
		const parenForDedup = detected.indexOf(' (');
		const bracketForDedup = detected.indexOf(' [');
		const dedupEnd = [parenForDedup, bracketForDedup]
			.filter(i => i > 0)
			.reduce((a, b) => Math.min(a, b), detected.length);
		const dedupKey = detected.slice(0, dedupEnd).trim();
		if (dedupKey === this._lastAnnouncedIntent) { return; }
		this._lastAnnouncedIntent = dedupKey;

		// Split the progress string into intent / scope / reasoning parts.
		// Format emitted by the daemon:
		//   "brainstorm/design [Large] (The text focuses on ...)"
		// Scope tag + parenthetical reasoning are both optional.
		const parenIdx = detected.indexOf(' (');
		const headlineRaw = parenIdx > 0 ? detected.slice(0, parenIdx).trim() : detected;
		const reasoning = parenIdx > 0 && detected.endsWith(')')
			? detected.slice(parenIdx + 2, -1).trim()
			: undefined;
		const scopeMatch = headlineRaw.match(/\s*\[([^\]]+)\]\s*$/);
		const scopeLabel = scopeMatch ? scopeMatch[1]!.trim() : undefined;
		const headline = scopeMatch ? headlineRaw.slice(0, scopeMatch.index).trim() : headlineRaw;

		// Item 8b: pin the detected intent on the progress bar as a sticky
		// badge so it stays visible while the agent grinds through
		// downstream steps. Cleared on streamEnd (see `_onStreamEnd`) and
		// when the session resets.
		if (this._intentBadge) {
			this._intentBadge.textContent = headline;
			this._intentBadge.classList.remove('hidden');
		}
		// Dedicated scope badge alongside the intent badge so the size
		// estimate is readable without being crammed into brackets in
		// the intent text.
		if (this._scopeBadge) {
			if (scopeLabel) {
				this._scopeBadge.textContent = scopeLabel;
				this._scopeBadge.classList.remove('hidden');
			} else {
				this._scopeBadge.textContent = '';
				this._scopeBadge.classList.add('hidden');
			}
		}

		// Keep the dropdown honest. `brainstorm/<category>` lands under the
		// top-level Brainstorm option.
		const [primary] = headline.split('/');
		if (primary) { this._selectIntent(primary); }

		// Item 24: render the classification as a persistent assistant
		// message in the chat transcript -- even during brainstorm lock.
		// Previously this was suppressed while brainstorm was active so the
		// user lost the record of HOW the turn was routed once the intent
		// pill scrolled past.
		const slashIdx = headline.indexOf('/');
		const primaryIntent = slashIdx > 0 ? headline.slice(0, slashIdx) : headline;
		const subIntent = slashIdx > 0 ? headline.slice(slashIdx + 1) : undefined;
		const intentLine = subIntent
			? `**Detected intent:** ${primaryIntent} → ${subIntent}`
			: `**Detected intent:** ${primaryIntent}`;
		const formatted = scopeLabel
			? `${intentLine}  ·  **Scope:** ${scopeLabel}`
			: intentLine;
		const content = reasoning
			? `${formatted}\n\n_${reasoning}_`
			: formatted;

		const message: ChatMessage = {
			role: 'assistant',
			content,
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
					this._wireMarkdownLinks(content as HTMLElement);
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
			// Wire markdown link clicks (path: citations etc.) through openerService
			this._wireMarkdownLinks(content);
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

	/**
	 * Route clicks on markdown-rendered anchors through the IOpenerService.
	 * Without this delegate, `<a href="path:...">` (citation links emitted
	 * by the code-analyzer's synthesise prompt) and other custom-scheme
	 * URIs would just call the browser's default-navigation, which webview
	 * sandboxing blocks silently. With it, clicks reach the registered
	 * openers (e.g. PathUriOpenerContribution -> open file at line range).
	 *
	 * Uses event delegation on the message-content container so we don't
	 * have to reattach per-anchor every re-render. Idempotent via a data
	 * flag so repeated _setTrustedHtml updates during streaming don't
	 * stack listeners.
	 */
	private _wireMarkdownLinks(container: HTMLElement): void {
		if (container.dataset['linksWired'] === '1') {
			return;
		}
		container.dataset['linksWired'] = '1';
		this._register(dom.addDisposableListener(container, 'click', (e) => {
			const target = e.target as HTMLElement | null;
			const anchor = target?.closest('a') as HTMLAnchorElement | null;
			if (!anchor) {
				return;
			}
			const href = anchor.getAttribute('href');
			if (!href) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			// `command:` URIs from chat HTML come from our daemon
			// (controlled source) -- e.g., the code-analyzer's "Open
			// Report Pane" summary card. openerService blocks these by
			// default unless the markdown is marked trusted, so route
			// straight through commandService for our chat content.
			if (href.startsWith('command:')) {
				const qIdx = href.indexOf('?');
				const cmdId = decodeURIComponent(qIdx < 0 ? href.slice('command:'.length) : href.slice('command:'.length, qIdx));
				let args: unknown;
				if (qIdx >= 0) {
					try {
						args = JSON.parse(decodeURIComponent(href.slice(qIdx + 1)));
					} catch {
						args = undefined;
					}
				}
				void this.commandService.executeCommand(cmdId, args);
				return;
			}
			void this.openerService.open(href, { fromUserGesture: true, allowContributedOpeners: true });
		}));
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

		// If gate contains diff content, show it in the main editor.
		const hasDiff = gate.content && (gate.content.includes('--- a/') || gate.content.includes('+++ b/') || gate.content.includes('@@ -'));
		if (hasDiff) {
			this._openDiffFromGate(gate);
		} else if (gate.content) {
			// gate.content is daemon-rendered HTML (from renderMarkdown at
			// gateTaskResult). Use trusted types so markdown formats as
			// headings / lists / code blocks instead of showing raw <h2>
			// <p> <ul> tags as literal text (Item 44 -- resume-confirm
			// gate + any other gate that lands inline in the chat panel).
			const body = dom.append(card, dom.$('.insrc-chat-gate-body'));
			if (ttPolicy) {
				(body as HTMLElement).innerHTML = ttPolicy.createHTML(gate.content) as unknown as string;
			} else {
				body.textContent = gate.content;
			}
		}

		// Build action bar. Prefer rich action metadata (labels, hints,
		// needsInput) when available; fall back to bare action names.
		const details: readonly GateActionDetail[] = gate.actionDetails && gate.actionDetails.length > 0
			? gate.actionDetails
			: gate.actions.map(name => ({ name, label: name }));

		// For actions with needsInput=true, render an input field below the
		// action row. On click, the button reads the field and passes it as
		// feedback. For the intent-confirm gate's `use-intent` action we
		// render a dropdown of known intents instead of a free-text field.
		const inputRow = dom.append(card, dom.$('.insrc-chat-gate-input-row'));
		inputRow.style.display = 'none';

		const gateCtx = gate.context as Record<string, unknown> | undefined;
		const isIntentConfirm = gateCtx && gateCtx['itemType'] === 'intent-confirm';

		let activeInput: HTMLInputElement | HTMLSelectElement | undefined;
		const openInput = (detail: GateActionDetail): void => {
			clearNode(inputRow);
			inputRow.style.display = '';

			if (isIntentConfirm && detail.name === 'use-intent') {
				const label = dom.append(inputRow, dom.$('.insrc-chat-gate-input-label'));
				label.textContent = 'Use intent:';
				const select = dom.append(inputRow, dom.$('select.insrc-chat-gate-select')) as HTMLSelectElement;
				for (const intent of CHAT_GATE_INTENTS) {
					const opt = dom.append(select, dom.$('option')) as HTMLOptionElement;
					opt.value = intent;
					opt.textContent = intent;
				}
				activeInput = select;
				setTimeout(() => select.focus(), 0);
			} else {
				const input = dom.append(inputRow, dom.$('input.insrc-chat-gate-input')) as HTMLInputElement;
				input.type = 'text';
				input.placeholder = detail.hint ?? 'Enter input...';
				activeInput = input;
				setTimeout(() => input.focus(), 0);
			}
		};

		const actions = dom.append(card, dom.$('.insrc-chat-gate-actions'));
		for (let i = 0; i < details.length; i++) {
			const detail = details[i]!;
			const btn = dom.append(actions, dom.$(`.insrc-chat-gate-btn${i === 0 ? '.primary' : ''}`)) as HTMLButtonElement;
			btn.textContent = detail.label ?? detail.name;
			if (detail.hint && !detail.needsInput) {
				btn.title = detail.hint;
			}
			this._register(dom.addDisposableListener(btn, 'click', () => {
				if (detail.needsInput) {
					if (!activeInput || (inputRow.style.display === 'none')) {
						// First click on a needsInput button opens the input
						// field; user edits, then clicks the button again to
						// submit.
						openInput(detail);
						btn.textContent = detail.label ? `${detail.label} (submit)` : `${detail.name} (submit)`;
						return;
					}
					const value = activeInput.value.trim();
					clearNode(this._gateContainer);
					this.chatService.replyToGate(gate.gateId, detail.name, value || undefined);
					return;
				}
				clearNode(this._gateContainer);
				// Phase 5 of plans/access-gate.md: an `approve-prefix`
				// action carries the parent-dir / provider-scope payload
				// the daemon pre-computed. Pass it through so the
				// dispatcher can call AccessStore.approvePrefix and
				// cascade the grant to descendants.
				this.chatService.replyToGate(gate.gateId, detail.name, undefined, detail.prefix);
				// Item 53: post-save handoff. When the user picks an
				// action on the handoff-proposal gate, lift the
				// brainstorm lock so the composer re-enables for the
				// next turn and close the brainstorm pane so the user
				// lands back on the chat panel. For "Continue with X"
				// also pre-fill the composer with a draft `/<intent>`
				// message.
				const isHandoffProposal = (gate.context as Record<string, unknown> | undefined)?.['itemType'] === 'handoff-proposal';
				if (isHandoffProposal) {
					this.brainstormSession.markBrainstormFinished();
					this.chatService.closeBrainstormPanes();
					if (detail.name.startsWith('continue-')) {
						this._stageHandoffPrompt(detail.name, gate);
					}
				}
			}));
		}

		this._scrollToBottom();
	}

	/**
	 * Item 53 (post-save handoff): after the user accepts the
	 * handoff-proposal gate, pre-fill the composer with a draft message
	 * like `/design Continue from the brainstorm spec we just saved
	 * (path/to/spec.md).` so they can review + send it to the downstream
	 * agent without retyping.
	 *
	 * `actionName` is `continue-<intent>` (e.g. `continue-design`); the
	 * intent suffix maps directly onto the slash-command the decomposer
	 * already understands.
	 */
	private _stageHandoffPrompt(actionName: string, gate: GateInfo): void {
		const intent = actionName.slice('continue-'.length);
		if (!intent) { return; }
		const ctx = gate.context as Record<string, unknown> | undefined;
		const item = ctx?.['item'] as Record<string, unknown> | undefined;
		const savedPath = typeof item?.['savedPath'] === 'string' ? item!['savedPath'] as string : '';
		const suffix = savedPath ? ` we just saved (${savedPath})` : ' we just saved';
		const draft = `/${intent} Continue from the brainstorm spec${suffix}.`;
		this._input.value = draft;
		// Bump the textarea height so the draft doesn't stay single-row +
		// clipped; mirror what _onInputEvent normally does.
		this._input.style.height = 'auto';
		this._input.style.height = Math.min(this._input.scrollHeight, 120) + 'px';
		setTimeout(() => {
			this._input.focus();
			this._input.setSelectionRange(this._input.value.length, this._input.value.length);
		}, 0);
	}

	/**
	 * Prefill the chat input with externally-supplied text (e.g. a
	 * "Send to chat" action from the analysis report pane). When
	 * `append` is true, the new text is added below any existing draft
	 * separated by a blank line so the user's in-progress question is
	 * preserved; otherwise the input is replaced.
	 *
	 * Auto-resizes the textarea (same as the handoff-prompt path) and
	 * focuses with the caret AT THE END so the user can keep typing
	 * their question after the quoted block.
	 */
	public prefillInput(text: string, opts?: { readonly append?: boolean }): void {
		if (text.length === 0) { return; }
		const existing = this._input.value;
		const next = opts?.append && existing.length > 0
			? `${existing}\n\n${text}`
			: text;
		this._input.value = next;
		this._input.style.height = 'auto';
		this._input.style.height = Math.min(this._input.scrollHeight, 200) + 'px';
		setTimeout(() => {
			this._input.focus();
			this._input.setSelectionRange(this._input.value.length, this._input.value.length);
		}, 0);
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

	/**
	 * Open the diff view for a finalized external-agent handoff.
	 *
	 * The daemon emits the unified diff body on `handoff-final`; we
	 * parse it, resolve paths against the active repo, and route into
	 * the existing IInsrcDiffService.showDiffs surface so accept/reject
	 * runs through the same codelens pipeline as agent-authored diffs.
	 *
	 * The `gateId` we use is a synthetic `handoff:<specId>` token --
	 * accept/reject actions show up on `diffService.onDidAction` with
	 * that tag. The daemon-side `handoff.accept` / `handoff.reject`
	 * IPC wiring lands in a follow-up phase; today the actions are
	 * logged and the user can manually apply changes.
	 */
	private async _openDiffFromHandoff(state: HandoffSessionState): Promise<void> {
		if (state.diff === undefined || state.diff.length === 0) {
			return;
		}
		// Failed handoffs don't carry a usable diff -- show nothing.
		if (state.verdict !== 'accept' && state.verdict !== 'revise-edits') {
			return;
		}
		try {
			const parsedFiles = parseDiff(state.diff);
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

				fileDiffs.push({ filePath, originalContent, proposedContent, diffText: state.diff!, isNew: fd.isNew });
			}

			const gateId = `handoff:${state.specId}`;
			this._logService.info(`[insrc-chat] opening handoff diff specId=${state.specId} files=${fileDiffs.length} verdict=${state.verdict}`);
			await this.diffService.showDiffs(fileDiffs, gateId);
		} catch (err) {
			this._logService.warn(`[insrc-chat] _openDiffFromHandoff failed: ${(err as Error).message}`);
		}
	}

	/**
	 * Mode A (Phase 3): show a pre-flight approval modal. Runs OUTSIDE
	 * the Mode B queue -- pre-flight is one-shot per handoff and
	 * blocks the orchestrator on the daemon side; we don't want it
	 * to serialise behind a queue of in-flight tool prompts.
	 */
	/**
	 * Mode A pre-flight gate rendered INLINE in `_gateContainer` --
	 * the same chat surface regular gates use. This follows the
	 * chat's existing gate-rendering framework instead of opening
	 * a system modal via dialogService, so the approval UX matches
	 * the rest of the chat. The cancel hook in `_modeAPromptCancels`
	 * lets `onModeAResolution` dismiss the gate if the daemon
	 * settles under us (timeout, cancel).
	 */
	private _showModeAPrompt(prompt: HandoffModeAPrompt): void {
		const dismiss = (): void => {
			this._dismissHandoffGate(prompt.gateId);
			this._modeAPromptCancels.delete(prompt.gateId);
		};
		this._modeAPromptCancels.set(prompt.gateId, dismiss);

		this._renderHandoffGate({
			gateId: prompt.gateId,
			title: `Approve handoff: ${prompt.templateId} (risk: ${prompt.riskTag})`,
			bodyText: this._formatModeAPromptDetail(prompt),
			severity: prompt.riskTag === 'high' ? 'warning' : 'info',
			buttons: [
				{
					label: 'Allow', primary: true, onClick: () => {
						dismiss();
						void this._handoffService.resolveModeAPrompt(prompt.gateId, 'allow');
					},
				},
				{
					label: 'Cancel', onClick: () => {
						dismiss();
						void this._handoffService.resolveModeAPrompt(prompt.gateId, 'deny');
					},
				},
			],
		});
	}

	private _cancelModeAPromptIfPending(gateId: string): void {
		const cancel = this._modeAPromptCancels.get(gateId);
		if (cancel !== undefined) {
			cancel();
		}
	}

	private _formatModeAPromptDetail(prompt: HandoffModeAPrompt): string {
		const lines: string[] = [];
		const allow = prompt.permissions.allow.length;
		const promptC = prompt.permissions.prompt.length;
		const deny = prompt.permissions.deny.length;
		lines.push(`Permissions: ${allow} allowed, ${promptC} prompt, ${deny} denied`);
		lines.push(`Spec: ${prompt.specId}`);
		lines.push('');
		lines.push('Preview:');
		lines.push(prompt.preview.trim());
		return lines.join('\n');
	}

	/**
	 * Mode B (Phase 3): in-flight tool-call gate rendered inline in
	 * `_gateContainer`. Sequential via `_modeBPromptChain` so a
	 * burst of prompts queues rather than stomping the gate
	 * container. Each gate's promise resolves when the user clicks
	 * a button OR `onModeBResolution` fires for the same gateId
	 * (daemon-side timeout / cancel).
	 */
	private _enqueueModeBPrompt(prompt: HandoffModeBPrompt): Promise<void> {
		const next = this._modeBPromptChain.then(() => this._showModeBPrompt(prompt));
		this._modeBPromptChain = next;
		return next;
	}

	private _showModeBPrompt(prompt: HandoffModeBPrompt): Promise<void> {
		return new Promise<void>(resolve => {
			const finish = (): void => {
				this._dismissHandoffGate(prompt.gateId);
				this._modeBPromptCancels.delete(prompt.gateId);
				resolve();
			};
			this._modeBPromptCancels.set(prompt.gateId, finish);

			const finishWith = (verdict: 'allow' | 'deny', scope?: 'once' | 'session'): void => {
				finish();
				const opts = scope !== undefined ? { scope } : {};
				void this._handoffService.resolveModeBPrompt(prompt.gateId, verdict, opts);
			};

			this._renderHandoffGate({
				gateId: prompt.gateId,
				title: `External agent wants to run \`${prompt.tool}\``,
				bodyText: this._formatModeBPromptDetail(prompt),
				severity: 'warning',
				buttons: [
					{ label: 'Allow', primary: true, onClick: () => finishWith('allow', 'once') },
					{ label: 'Allow this session', onClick: () => finishWith('allow', 'session') },
					{ label: 'Deny', onClick: () => finishWith('deny') },
				],
			});
		});
	}

	private _cancelModeBPromptIfPending(gateId: string): void {
		const cancel = this._modeBPromptCancels.get(gateId);
		if (cancel !== undefined) {
			cancel();
		}
	}

	/**
	 * Render a handoff gate (Mode A or Mode B) inline in
	 * `_gateContainer` using the chat's existing gate CSS. Replaces
	 * any currently-rendered gate. The card is stamped with
	 * `data-handoff-gate="<gateId>"` so the dismiss path can verify
	 * the gate is still the active one before clearing -- otherwise
	 * a delayed resolution could nuke a NEW gate that took over the
	 * slot.
	 */
	private _renderHandoffGate(args: {
		readonly gateId: string;
		readonly title: string;
		readonly bodyText: string;
		readonly severity: 'info' | 'warning';
		readonly buttons: ReadonlyArray<{ label: string; primary?: boolean; onClick: () => void }>;
	}): void {
		clearNode(this._gateContainer);
		const card = dom.append(this._gateContainer, dom.$('.insrc-chat-gate')) as HTMLElement;
		card.setAttribute('data-handoff-gate', args.gateId);
		if (args.severity === 'warning') {
			card.classList.add('insrc-chat-gate-warning');
		}
		const title = dom.append(card, dom.$('.insrc-chat-gate-title'));
		title.textContent = args.title;
		const body = dom.append(card, dom.$('.insrc-chat-gate-body'));
		body.style.whiteSpace = 'pre-wrap';
		body.style.fontFamily = 'var(--monaco-monospace-font, monospace)';
		body.style.fontSize = '11px';
		body.textContent = args.bodyText;
		const actions = dom.append(card, dom.$('.insrc-chat-gate-actions'));
		for (const b of args.buttons) {
			const btn = dom.append(actions, dom.$('button.insrc-chat-gate-btn')) as HTMLButtonElement;
			btn.textContent = b.label;
			if (b.primary === true) {
				btn.classList.add('primary');
			}
			this._register(dom.addDisposableListener(btn, 'click', () => b.onClick()));
		}
	}

	/**
	 * Remove a handoff gate from `_gateContainer` ONLY if it is
	 * still the active card. We stamp the gate id when rendering;
	 * resolution paths check it here so a delayed timer can't
	 * nuke a newer gate that already took the slot.
	 */
	private _dismissHandoffGate(gateId: string): void {
		const card = this._gateContainer.querySelector(`[data-handoff-gate="${CSS.escape(gateId)}"]`);
		if (card !== null) {
			clearNode(this._gateContainer);
		}
	}

	/**
	 * Acceptance gate rendered when a handoff hits `final`. Uses the
	 * same chat inline-gate framework as Mode A / Mode B so all
	 * user-facing handoff decisions land in `_gateContainer` rather
	 * than as buttons baked into the card widget. Buttons:
	 *   [Accept]   -- applies the diff (diffService.acceptAll) and
	 *                 RPCs handoff.cleanup with outcome 'accept'.
	 *   [Reject]   -- rejects the diff and RPCs with 'reject'.
	 *
	 * Failure / error states don't get this gate -- nothing to accept.
	 * If a subsequent gate (Mode A from a chained handoff, regular
	 * chat gate) takes the slot, the dismiss helper's id check stops
	 * us from clearing the newer gate. The `handoff-final:<specId>`
	 * gateId namespace keeps acceptance gates from colliding with
	 * Mode A (`modea-<random>`) / Mode B (`gate-<...>`) ids.
	 */
	private _showHandoffAcceptanceGate(state: HandoffSessionState): void {
		// Skip non-acceptance verdicts -- nothing useful for the user
		// to act on (and no diff has been applied / staged).
		if (state.verdict !== 'accept' && state.verdict !== 'revise-edits') {
			return;
		}
		const gateId = `handoff-final:${state.specId}`;
		const finish = (): void => {
			this._dismissHandoffGate(gateId);
		};
		const sessionId = this.chatService.activeSessionId ?? '';
		const applyAndCleanup = async (outcome: 'accept' | 'reject'): Promise<void> => {
			try {
				if (outcome === 'accept') {
					await this.diffService.acceptAll();
				} else {
					this.diffService.rejectAll();
				}
			} catch (err) {
				this._logService.warn(`[insrc-chat] handoff acceptance ${outcome} (diff phase) failed: ${(err as Error).message}`);
			}
			if (sessionId.length === 0) {
				this._logService.warn('[insrc-chat] handoff acceptance: no active session; skipping daemon RPC');
				return;
			}
			await this._handoffService.cleanupHandoff(sessionId, state.specId, outcome);
		};

		const titleSuffix = state.verdict === 'revise-edits' ? ' (audit suggests revisions)' : '';
		const bodyLines: string[] = [];
		bodyLines.push(`Template: ${state.templateId ?? 'HANDOFF'}    Agent: ${state.agent ?? '?'}`);
		if (state.durationMs !== undefined) {
			bodyLines.push(`Run time: ${Math.round(state.durationMs / 1000)}s`);
		}
		if (state.diffBytes !== undefined && state.diffBytes > 0) {
			bodyLines.push(`Diff: ${state.diffBytes} bytes`);
		} else {
			bodyLines.push('Diff: (empty -- agent produced a report-only handoff)');
		}
		if (state.auditReason !== undefined && state.auditReason.length > 0) {
			bodyLines.push('');
			bodyLines.push(`Audit: ${state.auditReason}`);
		}

		this._renderHandoffGate({
			gateId,
			title: `Accept handoff: ${state.intent ?? '(spec)'}${titleSuffix}`,
			bodyText: bodyLines.join('\n'),
			severity: 'info',
			buttons: [
				{
					label: 'Accept', primary: true, onClick: () => {
						finish();
						void applyAndCleanup('accept');
					},
				},
				{
					label: 'Reject', onClick: () => {
						finish();
						void applyAndCleanup('reject');
					},
				},
			],
		});
	}

	private _formatModeBPromptDetail(prompt: HandoffModeBPrompt): string {
		const lines: string[] = [];
		lines.push(`Tool: ${prompt.tool}`);
		lines.push(`Spec: ${prompt.specId}`);
		const inputJson = (() => {
			try { return JSON.stringify(prompt.input, null, 2); }
			catch { return String(prompt.input); }
		})();
		// Trim huge inputs so the modal doesn't blow up.
		const TRUNCATE = 1500;
		const trimmed = inputJson.length > TRUNCATE
			? `${inputJson.slice(0, TRUNCATE)}\n...(${inputJson.length - TRUNCATE} more bytes)`
			: inputJson;
		lines.push('');
		lines.push('Input:');
		lines.push(trimmed);
		return lines.join('\n');
	}

	private _renderError(error: string): void {
		const el = dom.$('.insrc-chat-message');
		el.style.color = 'var(--vscode-errorForeground)';
		const content = dom.append(el, dom.$('.insrc-chat-message-content'));
		content.textContent = `Error: ${error}`;
		this._messageList.appendChild(el);
		this._scrollToBottom();
	}

	private _showProgress(step: string, status: string): void {
		const label = status ? `${step}: ${status}` : step;

		// Top progress bar -- the always-visible "live" indicator.
		// Per-event historical record now flows through the
		// brainstorm-style `liveStep` bubbles (see `_handleLiveStep`)
		// emitted by the daemon's analyzer + content-gen paths; the
		// F13 inline trail this method used to maintain was removed
		// after user feedback (2026-04-29) preferring the brainstorm
		// pattern. Intent announcements still get a persistent
		// assistant message via `_ingestIntentAnnouncement`.
		this._progressBar.classList.remove('hidden');
		this._progressText.textContent = label;
	}

	/**
	 * Items 32b + 55: handle an incoming live-step token chunk. First
	 * chunk for a given `(agent, step)` pair creates a dedicated
	 * "activity console" bubble -- distinct DOM + styling from regular
	 * chat messages so the user reads it as a live indicator, not an
	 * answer. Subsequent chunks append to the body and auto-scroll the
	 * bubble's internal overflow. `done: true` removes the bubble --
	 * it was presence-only, never persisted.
	 */
	private _handleLiveStep(info: LiveStepInfo): void {
		const key = `${info.agent}:${info.step}`;
		let bubble = this._liveStepBubbles.get(key);
		if (info.done) {
			if (bubble) {
				bubble.el.remove();
				this._liveStepBubbles.delete(key);
			}
			return;
		}
		if (!bubble) {
			// Activity-console shell: dedicated class (NOT `.insrc-chat-message`)
			// so chat-bubble styling doesn't bleed in. Structure is
			// header(spinner + label) / body(scrolling monospace text).
			const el = dom.append(this._messageList, dom.$('.insrc-chat-live-console'));
			const header = dom.append(el, dom.$('.insrc-chat-live-console-header'));
			const spinner = dom.append(header, dom.$('.insrc-chat-live-console-spinner'));
			spinner.setAttribute('aria-hidden', 'true');
			const label = dom.append(header, dom.$('span.insrc-chat-live-console-label'));
			label.textContent = `${info.agent} / ${info.step}`;
			const body = dom.append(el, dom.$('.insrc-chat-live-console-body'));
			bubble = { el, body, text: '' };
			this._liveStepBubbles.set(key, bubble);
			this._emptyState.style.display = 'none';
			this._messageList.style.display = '';
		}
		bubble.text += info.text;
		bubble.body.textContent = bubble.text;
		// Item 55: auto-scroll the bubble's INNER overflow to keep the
		// most recent tokens visible without the user having to scroll.
		bubble.body.scrollTop = bubble.body.scrollHeight;
		this._scrollToBottom();
	}

	/** Clear every open live-step bubble -- called on streamEnd / error. */
	private _clearLiveStepBubbles(): void {
		for (const bubble of this._liveStepBubbles.values()) {
			bubble.el.remove();
		}
		this._liveStepBubbles.clear();
	}

	private _onStreamEnd(): void {
		this._streamingMessageEl = undefined;
		this._progressBar.classList.add('hidden');
		// Item 8b: drop the sticky intent badge when the turn ends.
		if (this._intentBadge) {
			this._intentBadge.textContent = '';
			this._intentBadge.classList.add('hidden');
		}
		if (this._scopeBadge) {
			this._scopeBadge.textContent = '';
			this._scopeBadge.classList.add('hidden');
		}
		// Item 32b: drop any orphan live-step bubbles left over from an
		// LLM step that ended without emitting its `done` event (abort,
		// connection lost, etc.).
		this._clearLiveStepBubbles();

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

		// `/handoff` test-harness intercept (plans/external-agent-integration.md).
		// Routes the chat message through the external-agent pipeline
		// (classify -> templateId -> handoff.run stream -> existing
		// progress card / modals / diff view). Skips the normal chat
		// send so the daemon's intent funnel doesn't double-process
		// the message. M.2 swaps this for full intent-driven routing.
		const handoffMatch = /^\s*\/handoff\b\s*(.*)$/s.exec(text);
		if (handoffMatch !== null) {
			const intent = (handoffMatch[1] ?? '').trim();
			this._input.value = '';
			this._autoResize();
			// Reveal the message list (the handoff widget mounts inside
			// it) and hide the empty-state placeholder so the progress
			// card is actually visible. Normal chat messages do this in
			// `_renderMessage`, but /handoff bypasses that path.
			this._emptyState.style.display = 'none';
			this._messageList.style.display = '';
			try {
				const summary = await this._handoffRunner.run(intent);
				this._logService.info(`[insrc-chat] ${summary}`);
			} catch (err) {
				this._renderError(`/handoff failed: ${(err as Error).message}`);
			}
			return;
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
		// Clear handoff cards from the prior session. The handoff
		// service no longer self-subscribes to chat session changes
		// (would create a cyclic service dependency); we drive the
		// purge from here, the same place that re-paints the
		// transcript on session flip.
		this._handoffService.clearAll();

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

	/**
	 * Slash-command autocomplete. Pops a QuickPick listing the
	 * registered chat slash commands (today: just `/code-analyze`).
	 * Selection inserts `${command} ` into the input + focuses;
	 * Esc / dismiss leaves the typed `/` so the user can keep typing
	 * a free-text message.
	 *
	 * Trigger: `/` typed as the first character of an empty input
	 * (see the keydown handler in `createEditor`). Re-entrant safe --
	 * picking once dismisses the picker; the next `/` keystroke
	 * triggers a fresh open.
	 *
	 * QuickPick takes focus while open, which is acceptable for the
	 * "I want to discover commands" UX and matches VS Code's own
	 * Ctrl+Shift+P pattern. A future inline suggestion widget could
	 * replace this for a smoother feel; out of scope for the slice
	 * landing slash discovery.
	 */
	private async _showSlashAutocomplete(): Promise<void> {
		const items = SLASH_COMMANDS.map(cmd => ({
			label: `/${cmd.id}`,
			description: cmd.description,
			detail: cmd.example,
			id: cmd.id,
		}));
		const pick = await this.quickInputService.pick(items, {
			placeHolder: 'Slash commands -- pick one or press Esc to keep typing',
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (pick === undefined) {
			// User dismissed -- leave the `/` in the input so they
			// can keep typing a free-text message.
			this._input.focus();
			this._input.setSelectionRange(this._input.value.length, this._input.value.length);
			return;
		}
		this._input.value = `/${pick.id} `;
		this._input.focus();
		this._input.setSelectionRange(this._input.value.length, this._input.value.length);
		this._autoResize();
	}
}
