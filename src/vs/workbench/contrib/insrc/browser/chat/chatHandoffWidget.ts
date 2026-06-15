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
 * Resolver supplied by chatView so the widget can fire the
 * Phase 5 cleanup IPC with the right (sessionId, specId, outcome)
 * tuple AFTER it's applied / rejected the in-flight diffs in the
 * editor. The widget doesn't own the diff pipeline -- only the
 * button surface that triggers it.
 */
export type HandoffCleanupHandler = (specId: string, outcome: 'accept' | 'reject' | 'dismissed') => Promise<void>;

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
	readonly accept: HTMLButtonElement;
	readonly reject: HTMLButtonElement;
	readonly dismiss: HTMLButtonElement;
	readonly body: HTMLElement;
}

export class ChatHandoffWidget extends Disposable {

	private _container: HTMLElement | undefined;
	private _cards = new Map<string, HandoffCardHandles>();

	constructor(
		private readonly handoffService: IInsrcHandoffService,
		private readonly logService: ILogService,
		private readonly cleanupHandler: HandoffCleanupHandler,
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
		// Phase 5 user-driven cleanup. Accept / Reject buttons fire
		// on the final card; the cleanup handler chatView injects
		// applies the diff (or rejects all files) then calls the
		// daemon's handoff.cleanup IPC to remove the worktree.
		const accept = dom.append(header, dom.$('button.insrc-chat-handoff-accept')) as HTMLButtonElement;
		accept.textContent = 'Accept';
		accept.title = 'Accept the proposed changes';
		accept.style.display = 'none';
		this._register(dom.addDisposableListener(accept, 'click', e => {
			e.stopPropagation();
			void this._runCleanup(state.specId, 'accept');
		}));
		const reject = dom.append(header, dom.$('button.insrc-chat-handoff-reject')) as HTMLButtonElement;
		reject.textContent = 'Reject';
		reject.title = 'Reject the proposed changes';
		reject.style.display = 'none';
		this._register(dom.addDisposableListener(reject, 'click', e => {
			e.stopPropagation();
			void this._runCleanup(state.specId, 'reject');
		}));
		const dismiss = dom.append(header, dom.$('button.insrc-chat-handoff-dismiss')) as HTMLButtonElement;
		dismiss.textContent = 'x';  // close button
		dismiss.title = 'Dismiss this handoff';
		dismiss.style.display = 'none';  // shown only on terminal states
		this._register(dom.addDisposableListener(dismiss, 'click', e => {
			e.stopPropagation();
			// Errored handoffs only have a dismiss button; record as
			// `dismissed` so the daemon still cleans up the (possibly
			// half-built) worktree.
			void this._runCleanup(state.specId, 'dismissed');
		}));
		const body = dom.append(root, dom.$('.insrc-chat-handoff-body'));
		return { root, template, intent, stage, accept, reject, dismiss, body };
	}

	private async _runCleanup(specId: string, outcome: 'accept' | 'reject' | 'dismissed'): Promise<void> {
		try {
			await this.cleanupHandler(specId, outcome);
		} catch (err) {
			this.logService.warn(`[insrc-handoff-widget] cleanup(${specId}, ${outcome}) failed: ${(err as Error).message}`);
		}
		// Whatever happened on the daemon side, drop the card from the
		// UI -- the user's already moved on.
		this.handoffService.clear(specId);
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

		// `final` -> show Accept / Reject (the only meaningful actions).
		// `error` -> show Dismiss (no diff to act on).
		// in-flight stages -> nothing (the user can't act yet).
		const showAcceptReject = state.stage === 'final';
		const showDismiss = state.stage === 'error';
		handles.accept.style.display = showAcceptReject ? '' : 'none';
		handles.reject.style.display = showAcceptReject ? '' : 'none';
		handles.dismiss.style.display = showDismiss ? '' : 'none';

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
