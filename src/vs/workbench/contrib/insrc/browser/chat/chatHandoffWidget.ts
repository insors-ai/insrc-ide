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
	type HandoffSessionState,
	type HandoffStage,
} from '../../common/handoffService.js';

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
 * The card body holds stage / preview / verdict / diff-bytes metadata
 * ONLY. Live agent stdout/stderr lives in a separate pinned widget
 * (`ChatHandoffTerminalPanel`) that doesn't scroll with the
 * transcript -- the card just signals when streaming is active.
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
}

export class ChatHandoffWidget extends Disposable {

	private _container: HTMLElement | undefined;
	private _cards = new Map<string, HandoffCardHandles>();

	constructor(
		private readonly handoffService: IInsrcHandoffService,
		private readonly logService: ILogService,
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
		return { root, template, intent, stage, dismiss, body };
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
