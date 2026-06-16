/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatHandoff.css';
import * as dom from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import {
	IInsrcHandoffService,
	type HandoffChunk,
	type HandoffSessionState,
	type HandoffStage,
} from '../../common/handoffService.js';

/**
 * Callback chatView injects so the widget can route an "Open report"
 * click to the report-pane open command. The pane is the post-final
 * surface for the full deliverable, diff summary, and re-run actions;
 * the in-chat card is the in-flight progress view.
 */
export type HandoffOpenReportHandler = (state: HandoffSessionState) => void;

/**
 * Inline chat widget (plans/external-agent-integration.md Phase 2b Day 3).
 *
 * Renders one card per in-flight / recently-finished handoff. Lives
 * inside the chat transcript so multiple handoffs in a chained
 * workflow accumulate as separate cards in scroll order.
 *
 * Card content evolves with the handoff stage:
 *
 *   - In-flight stages: header (template / intent / stage label)
 *     plus a scrollable monospace terminal viewport that streams
 *     `handoffService.onChunk` chunks for this specId in real time
 *     (64 KB rolling buffer, oldest dropped).
 *
 *   - `final` stage: terminal viewport collapses into a small
 *     "Live output" disclosure; main body shows deliverable
 *     preview (~500 chars) and an "Open report" link that opens
 *     the dedicated `HandoffReportPane` editor.
 *
 *   - `error` stage: terminal viewport stays open (debugging
 *     context); error stage + message shown above.
 *
 * NO action buttons live on the card. All user actions
 * (Accept / Reject after final, Mode A / Mode B during run) flow
 * through the chat's standard inline-gate framework rendered in
 * `_gateContainer`, NOT through buttons baked into the widget.
 *
 * Subscribes to `IInsrcHandoffService`:
 *   - `onDidChangeSession(state)` -- (re)paint a single card.
 *   - `onDidRemoveSession(id)`    -- drop a single card.
 *   - `onDidChange()`             -- full reconcile (covers session
 *                                    flips that purge the cache).
 *   - `onChunk(chunk)`            -- stream into the matching
 *                                    card's terminal viewport.
 *
 * The widget mounts inside chatView's `_messageList` (same parent as
 * todos / artifact cards) so it scrolls with the transcript. Self-
 * heals if the parent gets `clearNode`-ed on a chat session change.
 */

const TERMINAL_BUFFER_LIMIT_BYTES = 64 * 1024;
const DELIVERABLE_PREVIEW_LIMIT = 500;

interface HandoffCardHandles {
	readonly root: HTMLElement;
	readonly template: HTMLElement;
	readonly intent: HTMLElement;
	readonly stage: HTMLElement;
	readonly body: HTMLElement;
	/** Terminal viewport: monospace, scrollable, max-height capped. */
	readonly terminal: HTMLPreElement;
	/** Wrapper around the terminal that we can hide / show + style. */
	readonly terminalWrap: HTMLDetailsElement;
	/** In-memory rolling buffer for the terminal viewport. */
	terminalBuffer: string;
}

export class ChatHandoffWidget extends Disposable {

	private _container: HTMLElement | undefined;
	/**
	 * Parent passed to `mount()`. Stored for self-heal: chatView's
	 * `_onSessionChanged` calls `clearNode(_messageList)` which
	 * detaches every widget container mounted under it. Without this
	 * reference the first `/handoff` after a fresh chat would render
	 * into an off-document div.
	 */
	private _originalParent: HTMLElement | undefined;
	private _cards = new Map<string, HandoffCardHandles>();

	constructor(
		private readonly handoffService: IInsrcHandoffService,
		private readonly logService: ILogService,
		private readonly openReportHandler: HandoffOpenReportHandler,
	) {
		super();
	}

	/** Mount the widget into `parent`. Subsequent calls re-attach if needed. */
	mount(parent: HTMLElement): void {
		this._originalParent = parent;
		if (this._container !== undefined && this._container.isConnected) {
			return;
		}
		if (this._container !== undefined && !this._container.isConnected) {
			parent.appendChild(this._container);
			return;
		}
		this._container = dom.append(parent, dom.$('.insrc-chat-handoff'));

		this._register(this.handoffService.onDidChangeSession(state => this._applyState(state)));
		this._register(this.handoffService.onDidRemoveSession(id => this._removeCard(id)));
		this._register(this.handoffService.onDidChange(() => this._reconcile()));
		this._register(this.handoffService.onChunk(chunk => this._handleChunk(chunk)));

		this._reconcile();
	}

	/** Re-attach the container if it got orphaned. Cheap; called at every render entrypoint. */
	private _ensureMounted(): void {
		if (this._container === undefined || this._originalParent === undefined) {
			return;
		}
		if (this._container.isConnected) {
			return;
		}
		this._originalParent.appendChild(this._container);
	}

	// -- Reconcile full state set (session changes + initial paint) ----------

	private _reconcile(): void {
		this._ensureMounted();
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
		this._ensureMounted();
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
		const body = dom.append(root, dom.$('.insrc-chat-handoff-body'));

		// Terminal viewport sits at the bottom of the card and stays
		// mounted throughout the handoff lifecycle (chunks may arrive
		// before any stage event, e.g. on agent restart). It's wrapped
		// in <details> so the user can collapse it; we auto-collapse
		// once the handoff hits `final` to keep the deliverable
		// preview visible without scrolling.
		const terminalWrap = dom.append(root, dom.$('details.insrc-chat-handoff-terminal-wrap')) as HTMLDetailsElement;
		terminalWrap.open = true;
		const summary = dom.append(terminalWrap, dom.$('summary.insrc-chat-handoff-terminal-summary'));
		summary.textContent = 'Live output';
		const terminal = dom.append(terminalWrap, dom.$('pre.insrc-chat-handoff-terminal')) as HTMLPreElement;

		return { root, template, intent, stage, body, terminal, terminalWrap, terminalBuffer: '' };
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

		dom.clearNode(handles.body);

		if (state.stage === 'error') {
			const err = dom.append(handles.body, dom.$('div.insrc-chat-handoff-error'));
			err.textContent = state.errorStage !== undefined
				? `${state.errorStage}: ${state.errorMessage ?? '(no detail)'}`
				: (state.errorMessage ?? '(unknown error)');
			handles.terminalWrap.open = true;
			return;
		}

		// In-flight metadata rows -- compact + scannable.
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

		// Spec-ready preview: short snippet of the assembled spec
		// markdown so the user can confirm the right scope without
		// opening the worktree.
		if (state.preview !== undefined && state.preview.length > 0 && state.stage === 'spec-ready') {
			const preview = dom.append(handles.body, dom.$('div.insrc-chat-handoff-preview'));
			preview.textContent = state.preview;
		}

		// At final stage: show the agent's deliverable preview if it
		// reached us (via state.diff today; a future TodoList wiring
		// will populate a richer deliverable field). Then offer an
		// "Open report" link to the dedicated pane.
		if (state.stage === 'final') {
			const previewSrc = this._derivePreviewForFinal(state);
			if (previewSrc.length > 0) {
				const previewLabel = dom.append(handles.body, dom.$('div.insrc-chat-handoff-row-label'));
				previewLabel.textContent = 'output';
				const previewBlock = dom.append(handles.body, dom.$('pre.insrc-chat-handoff-deliverable'));
				previewBlock.textContent = previewSrc.length > DELIVERABLE_PREVIEW_LIMIT
					? `${previewSrc.slice(0, DELIVERABLE_PREVIEW_LIMIT)}\n...`
					: previewSrc;
			}
			const openRow = dom.append(handles.body, dom.$('div.insrc-chat-handoff-actions'));
			const openLink = dom.append(openRow, dom.$('a.insrc-chat-handoff-open-report')) as HTMLAnchorElement;
			openLink.textContent = 'Open report';
			openLink.href = '#';
			this._register(dom.addDisposableListener(openLink, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				try {
					this.openReportHandler(state);
				} catch (err) {
					this.logService.warn(`[insrc-handoff-widget] open-report failed: ${(err as Error).message}`);
				}
			}));

			// Auto-collapse the live output once the handoff is done.
			// The user can still expand it to inspect; we just keep
			// the deliverable preview as the at-a-glance answer.
			handles.terminalWrap.open = false;
		} else {
			handles.terminalWrap.open = true;
		}
	}

	// -- Streaming terminal output (Phase 2c) --------------------------------

	/**
	 * Append a stdout / stderr chunk to the matching card's terminal
	 * viewport. Out-of-order chunks (no card yet) are dropped --
	 * `<persistRoot>/<sid>/<specId>.trace.jsonl` is the source of
	 * truth for full transcripts; the viewport is live-feedback only.
	 */
	private _handleChunk(chunk: HandoffChunk): void {
		const handles = this._cards.get(chunk.specId);
		if (handles === undefined) {
			return;
		}
		handles.terminalBuffer = handles.terminalBuffer + chunk.chunk;
		if (handles.terminalBuffer.length > TERMINAL_BUFFER_LIMIT_BYTES) {
			handles.terminalBuffer = handles.terminalBuffer.slice(handles.terminalBuffer.length - TERMINAL_BUFFER_LIMIT_BYTES);
		}
		// textContent (not innerHTML) -- agent output is untrusted
		// arbitrary bytes; never inject it as HTML.
		handles.terminal.textContent = handles.terminalBuffer;
		// Auto-scroll only if the user hasn't manually scrolled away.
		// (`scrollHeight - clientHeight - scrollTop < 40` -- within
		// ~2 lines of the bottom we treat as "follow live".)
		const nearBottom = (handles.terminal.scrollHeight - handles.terminal.clientHeight - handles.terminal.scrollTop) < 40;
		if (nearBottom) {
			handles.terminal.scrollTop = handles.terminal.scrollHeight;
		}
	}

	// -- Helpers -------------------------------------------------------------

	/**
	 * At `final` stage the daemon-side TodoList integration (next
	 * todo) will surface a rich deliverable. For the interim, we
	 * derive a best-effort preview from whatever's already on the
	 * HandoffSessionState: the spec preview (always present) plus the
	 * first chunk of the diff body (if present). The pane will show
	 * the full version.
	 */
	private _derivePreviewForFinal(state: HandoffSessionState): string {
		const segments: string[] = [];
		if (state.preview !== undefined && state.preview.length > 0) {
			segments.push(state.preview.trim());
		}
		if (state.diff !== undefined && state.diff.length > 0) {
			segments.push('');
			segments.push('--- diff ---');
			segments.push(state.diff);
		}
		return segments.join('\n');
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
