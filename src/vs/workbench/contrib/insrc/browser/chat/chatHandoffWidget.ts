/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatHandoff.css';
import * as dom from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import {
	IInsrcHandoffService,
	type HandoffChunk,
	type HandoffSessionState,
	type HandoffStage,
} from '../../common/handoffService.js';

/**
 * Maximum bytes the inline live-output viewport will retain. Once
 * we exceed this, oldest bytes are dropped (FIFO) so the DOM node
 * doesn't grow unbounded for a long-running agent. The user can
 * read the full transcript from `<persistRoot>/<sessionId>/` after
 * the fact -- the inline viewport is for live feedback only.
 */
const TERMINAL_VIEWPORT_LIMIT_BYTES = 64 * 1024;

/**
 * Setting key for the handoff UX mode. `headless` (default) renders
 * the standard progress card; `terminal` augments the card body
 * with a scrollable live stdout/stderr viewport.
 *
 * Note on naming: the plan (Phase 2c) calls this "terminal" mode and
 * specs a vscode.Pseudoterminal. The workbench-layer adaptation
 * renders the live output INSIDE the handoff card -- the user-
 * visible UX is unchanged (live agent output is visible during the
 * run), the implementation just doesn't allocate a real terminal
 * panel.
 */
const SETTING_UX_MODE = 'insrc.handoff.uxMode';

/**
 * Inline chat widget (plans/external-agent-integration.md Phase 2b Day 3).
 *
 * Renders one compact card per in-flight or recently-finished external
 * handoff session that the daemon emitted events for on the active
 * chat stream. Subscribes to `IInsrcHandoffService`:
 *
 *   - `onDidChangeSession(state)` -- (re)paint a single card.
 *   - `onDidRemoveSession(id)`    -- drop a single card.
 *   - `onDidChange()`             -- full reconcile (covers session
 *                                    flips that purge the cache).
 *
 * The Day 3 widget is read-only -- it displays stage / preview / verdict.
 * Day 4 wires the accept/reject buttons + diff view + Mode-A modal.
 *
 * The widget mounts inside chatView's `_messageList` (same parent as
 * the todos card) so it scrolls with the chat transcript.
 */

interface HandoffCardHandles {
	readonly root: HTMLElement;
	readonly template: HTMLElement;
	readonly intent: HTMLElement;
	readonly stage: HTMLElement;
	readonly dismiss: HTMLButtonElement;
	readonly body: HTMLElement;
	/**
	 * Live stdout/stderr viewport. Only present when terminal-mode
	 * is active (the setting is read at card-create time + on
	 * config-change). Holds the most recent
	 * `TERMINAL_VIEWPORT_LIMIT_BYTES` bytes of output.
	 */
	terminal: HTMLPreElement | undefined;
	/**
	 * In-memory running buffer for the viewport. Append-only; we
	 * trim oldest bytes when total length exceeds the limit. Kept
	 * outside the DOM so trims don't force layout reflows.
	 */
	terminalBuffer: string;
}

export class ChatHandoffWidget extends Disposable {

	private _container: HTMLElement | undefined;
	private _cards = new Map<string, HandoffCardHandles>();

	constructor(
		private readonly handoffService: IInsrcHandoffService,
		private readonly logService: ILogService,
		private readonly configurationService: IConfigurationService,
	) {
		super();
	}

	/** Mount the widget into `parent`. Subsequent calls are a no-op. */
	mount(parent: HTMLElement): void {
		if (this._container !== undefined) {
			return;
		}
		this._container = dom.append(parent, dom.$('.insrc-chat-handoff'));

		this._register(this.handoffService.onDidChangeSession(state => this._applyState(state)));
		this._register(this.handoffService.onDidRemoveSession(id => this._removeCard(id)));
		this._register(this.handoffService.onDidChange(() => this._reconcile()));
		// Phase 2c: live chunks fan out to a dedicated viewport when
		// terminal-mode is on. We always subscribe -- the handler is a
		// no-op when the card has no terminal pane (mode = headless).
		this._register(this.handoffService.onChunk(chunk => this._handleChunk(chunk)));
		// Re-evaluate the per-card terminal pane when the setting flips
		// at runtime so users get the new mode without restarting.
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SETTING_UX_MODE)) {
				this._reconcileTerminalPanes();
			}
		}));

		this._reconcile();
	}

	// -- Reconcile full state set (session changes + initial paint) ----------

	private _reconcile(): void {
		if (this._container === undefined) {
			return;
		}
		const seen = new Set<string>();
		for (const state of this.handoffService.sessions.values()) {
			seen.add(state.specId);
			this._applyState(state);
		}
		for (const id of [...this._cards.keys()]) {
			if (!seen.has(id)) {
				this._removeCard(id);
			}
		}
	}

	// -- Card lifecycle ------------------------------------------------------

	private _applyState(state: HandoffSessionState): void {
		if (this._container === undefined) {
			return;
		}
		const existing = this._cards.get(state.specId);
		if (existing === undefined) {
			const handles = this._createCard(state);
			this._cards.set(state.specId, handles);
			this._container.appendChild(handles.root);
			this._renderCard(state, handles);
			this.logService.info(`[insrc-handoff-widget] new card specId=${state.specId} stage=${state.stage}`);
			return;
		}
		this._renderCard(state, existing);
	}

	private _createCard(state: HandoffSessionState): HandoffCardHandles {
		const root = dom.$('.insrc-chat-handoff-card', { 'data-spec-id': state.specId });
		const header = dom.append(root, dom.$('.insrc-chat-handoff-card-header'));
		const template = dom.append(header, dom.$('span.insrc-chat-handoff-template'));
		const intent = dom.append(header, dom.$('span.insrc-chat-handoff-intent'));
		const stage = dom.append(header, dom.$('span.insrc-chat-handoff-stage'));
		const dismiss = dom.append(header, dom.$('button.insrc-chat-handoff-dismiss')) as HTMLButtonElement;
		dismiss.textContent = 'x';  // close button
		dismiss.title = 'Dismiss this handoff';
		dismiss.style.display = 'none';  // shown only on terminal states
		this._register(dom.addDisposableListener(dismiss, 'click', e => {
			e.stopPropagation();
			this.handoffService.clear(state.specId);
		}));
		const body = dom.append(root, dom.$('.insrc-chat-handoff-body'));
		return { root, template, intent, stage, dismiss, body, terminal: undefined, terminalBuffer: '' };
	}

	/**
	 * `true` when the user has opted into terminal-mode handoff UX.
	 * Read on every render so a runtime config flip applies on the
	 * next stage transition; `_reconcileTerminalPanes` walks every
	 * existing card to mount / unmount the viewport immediately when
	 * the setting changes.
	 */
	private _terminalModeEnabled(): boolean {
		return this.configurationService.getValue<string>(SETTING_UX_MODE) === 'terminal';
	}

	private _renderCard(state: HandoffSessionState, handles: HandoffCardHandles): void {
		handles.template.textContent = state.templateId ?? 'HANDOFF';
		handles.intent.textContent = state.intent ?? '(spec)';
		handles.stage.textContent = this._stageLabel(state.stage);

		handles.root.className = 'insrc-chat-handoff-card';
		handles.root.classList.add(`stage-${state.stage}`);
		if (state.verdict !== undefined) {
			handles.root.classList.add(`verdict-${state.verdict}`);
		}

		const isTerminal = state.stage === 'final' || state.stage === 'error';
		handles.dismiss.style.display = isTerminal ? '' : 'none';

		dom.clearNode(handles.body);

		if (state.stage === 'error') {
			const err = dom.append(handles.body, dom.$('div.insrc-chat-handoff-error'));
			err.textContent = state.errorStage !== undefined
				? `${state.errorStage}: ${state.errorMessage ?? '(no detail)'}`
				: (state.errorMessage ?? '(unknown error)');
			return;
		}

		if (state.worktreePath !== undefined) {
			this._appendRow(handles.body, 'worktree', state.worktreePath);
		}
		if (state.agent !== undefined) {
			this._appendRow(handles.body, 'agent', state.agent);
		}
		if (state.exitCode !== undefined) {
			const dur = state.durationMs !== undefined ? ` (${formatDuration(state.durationMs)})` : '';
			this._appendRow(handles.body, 'agent exit', `${state.exitCode}${dur}`);
		}
		if (state.verdict !== undefined) {
			const checks = state.machineCheckCount !== undefined
				? `, ${state.machineCheckCount} machine check${state.machineCheckCount === 1 ? '' : 's'}`
				: '';
			this._appendRow(handles.body, 'verdict', `${state.verdict}${checks}`);
			if (state.auditReason !== undefined && state.auditReason.length > 0) {
				this._appendRow(handles.body, 'reason', state.auditReason);
			}
		}
		if (state.diffBytes !== undefined && state.diffBytes > 0) {
			this._appendRow(handles.body, 'diff size', formatBytes(state.diffBytes));
		}
		if (state.preview !== undefined && state.preview.length > 0 && state.stage === 'spec-ready') {
			const preview = dom.append(handles.body, dom.$('div.insrc-chat-handoff-preview'));
			preview.textContent = state.preview;
		}

		// Phase 2c: live stdout/stderr viewport. Mounted when terminal
		// mode is on and the handoff isn't yet in a terminal stage.
		// (No point allocating a viewport for finalized/errored cards
		// the user is about to dismiss.) Headless mode leaves it off.
		if (this._terminalModeEnabled() && !isTerminal) {
			this._attachTerminalPane(handles);
			if (handles.terminal !== undefined && handles.terminalBuffer.length > 0) {
				handles.terminal.textContent = handles.terminalBuffer;
			}
		}
	}

	private _attachTerminalPane(handles: HandoffCardHandles): void {
		if (handles.terminal !== undefined && handles.terminal.isConnected) {
			return;
		}
		const pane = dom.append(handles.body, dom.$('pre.insrc-chat-handoff-terminal')) as HTMLPreElement;
		pane.textContent = handles.terminalBuffer;
		handles.terminal = pane;
	}

	private _detachTerminalPane(handles: HandoffCardHandles): void {
		if (handles.terminal === undefined) {
			return;
		}
		handles.terminal.remove();
		handles.terminal = undefined;
	}

	/**
	 * Walk every card and mount/unmount the terminal pane based on the
	 * current setting + the card's stage. Fired when the user toggles
	 * `insrc.handoff.uxMode` mid-flight.
	 */
	private _reconcileTerminalPanes(): void {
		const enabled = this._terminalModeEnabled();
		for (const [specId, handles] of this._cards) {
			const state = this.handoffService.sessions.get(specId);
			const isTerminal = state !== undefined && (state.stage === 'final' || state.stage === 'error');
			if (enabled && !isTerminal) {
				this._attachTerminalPane(handles);
				if (handles.terminal !== undefined) {
					handles.terminal.textContent = handles.terminalBuffer;
				}
			} else {
				this._detachTerminalPane(handles);
			}
		}
	}

	/**
	 * Append a stdout/stderr chunk to the matching card's viewport.
	 * Out-of-order chunks (no card yet, or card already finalized) are
	 * dropped silently -- the persistRoot file is the source of truth
	 * for full transcripts; the inline viewport is live-feedback only.
	 */
	private _handleChunk(chunk: HandoffChunk): void {
		const handles = this._cards.get(chunk.specId);
		if (handles === undefined) {
			return;
		}
		// Aggregate into the running buffer regardless of mode -- if
		// the user flips to terminal mode mid-handoff we want the
		// history to be there.
		handles.terminalBuffer = (handles.terminalBuffer + chunk.chunk);
		if (handles.terminalBuffer.length > TERMINAL_VIEWPORT_LIMIT_BYTES) {
			handles.terminalBuffer = handles.terminalBuffer.slice(handles.terminalBuffer.length - TERMINAL_VIEWPORT_LIMIT_BYTES);
		}
		if (handles.terminal !== undefined && handles.terminal.isConnected) {
			// Re-set the full text rather than appending so the trim
			// above takes effect. textContent is much cheaper than
			// innerHTML and avoids any DOM-injection footgun on agent
			// output containing arbitrary characters.
			handles.terminal.textContent = handles.terminalBuffer;
			handles.terminal.scrollTop = handles.terminal.scrollHeight;
		}
	}

	private _appendRow(parent: HTMLElement, label: string, value: string): void {
		const row = dom.append(parent, dom.$('.insrc-chat-handoff-row'));
		const labelEl = dom.append(row, dom.$('span.insrc-chat-handoff-row-label'));
		labelEl.textContent = label;
		const valueEl = dom.append(row, dom.$('span.insrc-chat-handoff-row-value'));
		valueEl.textContent = value;
		valueEl.title = value;
	}

	private _stageLabel(stage: HandoffStage): string {
		switch (stage) {
			case 'spec-assembling': return 'assembling spec...';
			case 'spec-ready': return 'spec ready';
			case 'worktree-created': return 'worktree ready';
			case 'spawned': return 'agent running...';
			case 'agent-completed': return 'agent finished';
			case 'auditing': return 'auditing...';
			case 'audit-ready': return 'audit ready';
			case 'final': return 'final';
			case 'error': return 'error';
		}
	}

	private _removeCard(specId: string): void {
		const handles = this._cards.get(specId);
		if (handles === undefined) {
			return;
		}
		this._cards.delete(specId);
		handles.root.remove();
	}
}

// -- Formatting helpers ----------------------------------------------------

function formatDuration(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	const sec = ms / 1000;
	if (sec < 60) {
		return `${sec.toFixed(1)}s`;
	}
	const min = Math.floor(sec / 60);
	const rem = Math.round(sec - min * 60);
	return `${min}m ${rem}s`;
}

function formatBytes(n: number): string {
	if (n < 1024) {
		return `${n} B`;
	}
	if (n < 1024 * 1024) {
		return `${(n / 1024).toFixed(1)} KB`;
	}
	return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
