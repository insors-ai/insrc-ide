/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatHandoffTerminal.css';
import * as dom from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import {
	IInsrcHandoffService,
	type HandoffChunk,
	type HandoffSessionState,
} from '../../common/handoffService.js';

/**
 * Maximum bytes the terminal panel retains for a single specId.
 * Oldest bytes are trimmed (FIFO) once we exceed this so the DOM
 * node + in-memory buffer don't grow unbounded for a long-running
 * agent. The full transcript persists at
 * `<persistRoot>/<sessionId>/<specId>.deliverable.md` (audit) and
 * is recoverable from disk; the panel is for live feedback only.
 */
const BUFFER_LIMIT_BYTES = 64 * 1024;

/** Per-handoff buffer entry. */
interface BufferEntry {
	readonly intent: string | undefined;
	readonly templateId: string | undefined;
	readonly agent: string | undefined;
	readonly startedAt: number;
	text: string;
}

const SETTING_UX_MODE = 'insrc.handoff.uxMode';

/**
 * Pinned chat widget that surfaces live external-agent stdout/stderr
 * outside the regular chat transcript scroll context
 * (plans/external-agent-integration.md Phase 2c -- v2 design).
 *
 * Architectural distinction from the inline `ChatHandoffWidget`:
 *
 *   - That widget mounts INSIDE `.insrc-chat-messages` and scrolls
 *     with the transcript. It renders compact per-handoff metadata
 *     cards (stage, verdict, diff size).
 *
 *   - This panel mounts as a SIBLING of `.insrc-chat-messages`,
 *     between the message list and `.insrc-chat-gate-container`,
 *     so it stays pinned in view even as the transcript scrolls.
 *     It's the dedicated home for high-volume live output that
 *     would otherwise drown the transcript flow.
 *
 * Behavior:
 *
 *   - Subscribes to `IInsrcHandoffService.onChunk` and accumulates
 *     a rolling 64 KB buffer per specId. The buffer keeps accruing
 *     even when `uxMode = 'headless'` (so a runtime flip to terminal
 *     shows the back-history) and when the panel is collapsed.
 *
 *   - When `uxMode = 'terminal'` and a chunk arrives for a spec we
 *     don't already have an entry for, we open the panel and pin
 *     to that spec.
 *
 *   - On `handoff-final` / `handoff-error` for the pinned spec, the
 *     panel keeps the buffer visible (with a completed/errored
 *     badge) but auto-collapses to the 28px header strip so the
 *     user can review without losing real estate. Closing the
 *     panel via its `x` clears the active spec; flipping back on
 *     happens on the next live chunk for a new spec.
 *
 *   - Header has: chevron (collapse toggle), template badge,
 *     intent text, agent name, elapsed timer (live during run,
 *     frozen on terminal stages), and a close button.
 */
export class ChatHandoffTerminalPanel extends Disposable {

	private _container: HTMLElement | undefined;
	private _root: HTMLElement | undefined;
	private _chevron: HTMLElement | undefined;
	private _template: HTMLElement | undefined;
	private _intent: HTMLElement | undefined;
	private _agent: HTMLElement | undefined;
	private _elapsed: HTMLElement | undefined;
	private _statusBadge: HTMLElement | undefined;
	private _close: HTMLButtonElement | undefined;
	private _body: HTMLPreElement | undefined;

	/** Per-spec aggregated stdout/stderr buffer. */
	private readonly _buffers = new Map<string, BufferEntry>();
	/** Spec currently pinned in the panel. `undefined` => closed. */
	private _activeSpecId: string | undefined;
	private _collapsed = false;
	private _elapsedTimer: ReturnType<typeof mainWindow.setInterval> | undefined;

	constructor(
		private readonly handoffService: IInsrcHandoffService,
		private readonly configurationService: IConfigurationService,
		private readonly logService: ILogService,
	) {
		super();
	}

	/** Mount the panel into `parent`. Subsequent calls are a no-op. */
	mount(parent: HTMLElement): void {
		if (this._container !== undefined) {
			return;
		}
		this._container = dom.append(parent, dom.$('.insrc-chat-handoff-terminal-host'));
		this._container.classList.add('hidden');

		this._buildDom();

		this._register(this.handoffService.onChunk(chunk => this._handleChunk(chunk)));
		this._register(this.handoffService.onDidChangeSession(state => this._handleSessionChange(state)));
		this._register(this.handoffService.onDidRemoveSession(id => this._handleSessionRemove(id)));
		this._register(this.handoffService.onDidChange(() => this._maybeAutoClose()));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SETTING_UX_MODE)) {
				this._applyModeSetting();
			}
		}));
		this._applyModeSetting();
	}

	override dispose(): void {
		this._clearElapsedTimer();
		super.dispose();
	}

	// -- DOM construction ---------------------------------------------------

	private _buildDom(): void {
		if (this._container === undefined) {
			return;
		}
		const root = dom.append(this._container, dom.$('.insrc-chat-handoff-terminal-panel'));
		this._root = root;

		// Header strip (always visible when the panel is mounted).
		const header = dom.append(root, dom.$('.insrc-chat-handoff-terminal-header'));
		this._register(dom.addDisposableListener(header, 'click', e => {
			// Toggle only on chrome clicks; the close + actions stopProp.
			if ((e.target as HTMLElement).closest('.insrc-chat-handoff-terminal-action')) {
				return;
			}
			this._setCollapsed(!this._collapsed);
		}));

		this._chevron = dom.append(header, dom.$('span.insrc-chat-handoff-terminal-chevron'));
		this._chevron.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown));

		this._template = dom.append(header, dom.$('span.insrc-chat-handoff-terminal-template'));
		this._template.textContent = 'HANDOFF';

		this._intent = dom.append(header, dom.$('span.insrc-chat-handoff-terminal-intent'));
		this._intent.textContent = '';

		const spacer = dom.append(header, dom.$('span.insrc-chat-handoff-terminal-spacer'));
		spacer.style.flex = '1';

		this._agent = dom.append(header, dom.$('span.insrc-chat-handoff-terminal-agent'));
		this._agent.textContent = '';

		this._elapsed = dom.append(header, dom.$('span.insrc-chat-handoff-terminal-elapsed'));
		this._elapsed.textContent = '';

		this._statusBadge = dom.append(header, dom.$('span.insrc-chat-handoff-terminal-status'));
		this._statusBadge.textContent = '';
		this._statusBadge.style.display = 'none';

		this._close = dom.append(header, dom.$('button.insrc-chat-handoff-terminal-action.insrc-chat-handoff-terminal-close')) as HTMLButtonElement;
		this._close.textContent = 'x';
		this._close.title = 'Close terminal output';
		this._register(dom.addDisposableListener(this._close, 'click', e => {
			e.stopPropagation();
			this._closePanel();
		}));

		// Body: scrollable monospace pre.
		this._body = dom.append(root, dom.$('pre.insrc-chat-handoff-terminal-body')) as HTMLPreElement;
	}

	// -- Subscriptions -------------------------------------------------------

	private _handleChunk(chunk: HandoffChunk): void {
		this._appendToBuffer(chunk.specId, chunk.chunk);

		if (!this._isTerminalModeEnabled()) {
			return;
		}
		// First chunk for a fresh spec opens / swaps the panel.
		if (this._activeSpecId !== chunk.specId) {
			this._activeSpecId = chunk.specId;
			this._showPanel();
			this._renderHeader();
		}
		this._renderBody();
	}

	private _handleSessionChange(state: HandoffSessionState): void {
		const entry = this._buffers.get(state.specId);
		if (entry !== undefined) {
			// Refresh the cached metadata for future renders.
			(entry as { intent: string | undefined }).intent = state.intent;
			(entry as { templateId: string | undefined }).templateId = state.templateId;
			(entry as { agent: string | undefined }).agent = state.agent;
		}
		if (this._activeSpecId === state.specId) {
			this._renderHeader();
			// Terminal stages auto-collapse the panel but keep it visible
			// so the user can scroll the buffer at their leisure.
			if (state.stage === 'final' || state.stage === 'error') {
				this._clearElapsedTimer();
				this._setCollapsed(true);
			}
		}
	}

	private _handleSessionRemove(specId: string): void {
		this._buffers.delete(specId);
		if (this._activeSpecId === specId) {
			this._closePanel();
		}
	}

	/**
	 * Garbage-collect orphaned buffers (e.g. chat session change purged
	 * the handoff service cache). When the active spec is gone, close.
	 */
	private _maybeAutoClose(): void {
		if (this._activeSpecId === undefined) {
			return;
		}
		if (!this.handoffService.sessions.has(this._activeSpecId)) {
			this._closePanel();
		}
	}

	// -- Buffer management ---------------------------------------------------

	private _appendToBuffer(specId: string, chunk: string): void {
		let entry = this._buffers.get(specId);
		if (entry === undefined) {
			const state = this.handoffService.sessions.get(specId);
			entry = {
				intent: state?.intent,
				templateId: state?.templateId,
				agent: state?.agent,
				startedAt: Date.now(),
				text: '',
			};
			this._buffers.set(specId, entry);
		}
		entry.text += chunk;
		if (entry.text.length > BUFFER_LIMIT_BYTES) {
			entry.text = entry.text.slice(entry.text.length - BUFFER_LIMIT_BYTES);
		}
	}

	// -- Visibility / collapse ----------------------------------------------

	private _showPanel(): void {
		if (this._container === undefined) {
			return;
		}
		this._container.classList.remove('hidden');
		this._collapsed = false;
		this._applyCollapseClasses();
		this._startElapsedTimer();
		this.logService.info(`[insrc-handoff-terminal] open specId=${this._activeSpecId}`);
	}

	private _closePanel(): void {
		this._activeSpecId = undefined;
		if (this._container !== undefined) {
			this._container.classList.add('hidden');
		}
		this._clearElapsedTimer();
		if (this._body !== undefined) {
			this._body.textContent = '';
		}
	}

	private _setCollapsed(collapsed: boolean): void {
		if (this._collapsed === collapsed) {
			return;
		}
		this._collapsed = collapsed;
		this._applyCollapseClasses();
	}

	private _applyCollapseClasses(): void {
		if (this._root === undefined || this._chevron === undefined) {
			return;
		}
		this._root.classList.toggle('collapsed', this._collapsed);
		const removeIcon = this._collapsed ? Codicon.chevronDown : Codicon.chevronRight;
		const addIcon = this._collapsed ? Codicon.chevronRight : Codicon.chevronDown;
		this._chevron.classList.remove(...ThemeIcon.asClassNameArray(removeIcon));
		this._chevron.classList.add(...ThemeIcon.asClassNameArray(addIcon));
		// Auto-scroll to bottom when re-expanding so the latest output
		// is visible immediately.
		if (!this._collapsed && this._body !== undefined) {
			this._body.scrollTop = this._body.scrollHeight;
		}
	}

	// -- Render --------------------------------------------------------------

	private _renderHeader(): void {
		if (this._activeSpecId === undefined || this._template === undefined || this._intent === undefined
			|| this._agent === undefined || this._statusBadge === undefined || this._root === undefined) {
			return;
		}
		const state = this.handoffService.sessions.get(this._activeSpecId);
		const entry = this._buffers.get(this._activeSpecId);
		this._template.textContent = state?.templateId ?? entry?.templateId ?? 'HANDOFF';
		this._intent.textContent = state?.intent ?? entry?.intent ?? '(spec)';
		this._agent.textContent = state?.agent ?? entry?.agent ?? '';

		this._root.classList.remove('stage-final', 'stage-error');
		if (state?.stage === 'final') {
			this._root.classList.add('stage-final');
			this._statusBadge.textContent = state.verdict ?? 'final';
			this._statusBadge.style.display = '';
		} else if (state?.stage === 'error') {
			this._root.classList.add('stage-error');
			this._statusBadge.textContent = 'error';
			this._statusBadge.style.display = '';
		} else {
			this._statusBadge.style.display = 'none';
		}
	}

	private _renderBody(): void {
		if (this._body === undefined || this._activeSpecId === undefined) {
			return;
		}
		const entry = this._buffers.get(this._activeSpecId);
		if (entry === undefined) {
			return;
		}
		// textContent (not innerHTML) -- agent output is untrusted
		// arbitrary bytes; never inject it as HTML.
		this._body.textContent = entry.text;
		if (!this._collapsed) {
			this._body.scrollTop = this._body.scrollHeight;
		}
	}

	// -- Elapsed timer (live during in-flight stages) -----------------------

	private _startElapsedTimer(): void {
		this._clearElapsedTimer();
		this._tickElapsed();
		this._elapsedTimer = mainWindow.setInterval(() => this._tickElapsed(), 1000);
	}

	private _clearElapsedTimer(): void {
		if (this._elapsedTimer !== undefined) {
			mainWindow.clearInterval(this._elapsedTimer);
			this._elapsedTimer = undefined;
		}
	}

	private _tickElapsed(): void {
		if (this._activeSpecId === undefined || this._elapsed === undefined) {
			return;
		}
		const entry = this._buffers.get(this._activeSpecId);
		if (entry === undefined) {
			this._elapsed.textContent = '';
			return;
		}
		const elapsedMs = Date.now() - entry.startedAt;
		this._elapsed.textContent = formatElapsed(elapsedMs);
	}

	// -- Settings ------------------------------------------------------------

	private _isTerminalModeEnabled(): boolean {
		return this.configurationService.getValue<string>(SETTING_UX_MODE) === 'terminal';
	}

	private _applyModeSetting(): void {
		// Flipping to headless force-closes the panel; future chunks
		// won't auto-open it. Flipping to terminal does nothing
		// proactively -- the next chunk for a new handoff will open
		// the panel.
		if (!this._isTerminalModeEnabled()) {
			this._closePanel();
		}
	}
}

function formatElapsed(ms: number): string {
	const sec = Math.floor(ms / 1000);
	const min = Math.floor(sec / 60);
	const rem = sec % 60;
	if (min === 0) {
		return `${rem}s`;
	}
	return `${min}m ${rem.toString().padStart(2, '0')}s`;
}
