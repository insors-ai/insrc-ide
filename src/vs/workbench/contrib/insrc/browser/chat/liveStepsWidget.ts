/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * LiveStepsWidget -- per-run structured progress display.
 *
 * Matches the deleted chat panel's "live console" treatment: a
 * bordered box with a small uppercase header (spinning icon +
 * "Steps") and a scrollable monospace body of step rows. Each
 * row tracks one of:
 *   - a pipeline stage         (classify / plan / execute)
 *   - a per-task event         (taskId + template) inside the
 *     execute stage. Nested task paths indent under their
 *     ancestor row.
 *
 * Rows update in place as events arrive: a task-started event
 * flips a row from idle to in-progress (spinning icon); a
 * task-completed event flips it to ok / failed / skipped.
 *
 * One widget instance per runId. Styling lives in
 * browser/chat/media/chat.css under .insrc-chat-live-console*
 * and .insrc-chat-live-step* selectors.
 */

import * as dom from '../../../../../base/browser/dom.js';
import { localize } from '../../../../../nls.js';

/** Normalised inputs the widget surfaces -- frees the caller from
 *  the daemon's raw progress-frame field names. */
export interface LiveStepsEvent {
	/** From the daemon's progress frame -- 'classify' / 'plan' /
	 *  'execute' / 'task-N/M' / 'task-<taskId>'. */
	readonly step: string;
	/** From the frame -- 'started' / 'completed' / 'ok' / 'failed' /
	 *  'skipped-dependency-unavailable' / 'accepted' / 'substep-<id>' /
	 *  etc. */
	readonly status: string;
	readonly taskId?: string;
	readonly template?: string;
	readonly index?: number;
	readonly total?: number;
	readonly parentTaskPath?: string;
	/** Sub-step id when the daemon emits a stage-substep event
	 *  (e.g. 'bundle-shaper' / 'planner'). Undefined for stage-started
	 *  and task-* events. */
	readonly substep?: string;
	/** Human-readable detail for stage-substep events, appended to the
	 *  parent row's status text. */
	readonly detail?: string;
}

type RowState = 'idle' | 'in-progress' | 'ok' | 'failed' | 'skipped';

interface RowHandle {
	readonly element: HTMLElement;
	readonly iconEl: HTMLElement;
	readonly titleEl: HTMLElement;
	readonly statusEl: HTMLElement;
	readonly key: string;
}

export class LiveStepsWidget {
	readonly element: HTMLElement;

	private readonly _headerSpinner: HTMLElement;
	private readonly _bodyEl: HTMLElement;
	private readonly _rows = new Map<string, RowHandle>();

	constructor(parent: HTMLElement) {
		this.element = dom.append(parent, dom.$('div.insrc-chat-live-console'));

		const header = dom.append(this.element, dom.$('div.insrc-chat-live-console-header'));
		this._headerSpinner = dom.append(header, dom.$('span.codicon.codicon-loading.codicon-modifier-spin'));
		const label = dom.append(header, dom.$('span'));
		label.textContent = localize('chatLiveSteps', 'Steps');

		this._bodyEl = dom.append(this.element, dom.$('div.insrc-chat-live-console-body'));
	}

	update(event: LiveStepsEvent): void {
		const key = this._keyFor(event);
		const row = this._rows.get(key) ?? this._createRow(key, event);
		this._applyEvent(row, event);
		// Auto-scroll the body so the newest step stays visible.
		this._bodyEl.scrollTop = this._bodyEl.scrollHeight;
	}

	/**
	 * Called when the stream's terminal frame has arrived. Stops the
	 * header spinner + flips any still-in-progress rows to a failed
	 * state with an explanatory note. The widget itself stays mounted
	 * so the user can scroll through what executed.
	 */
	finalize(): void {
		this._headerSpinner.classList.remove('codicon-loading', 'codicon-modifier-spin');
		this._headerSpinner.classList.add('codicon-pass-filled');
		for (const row of this._rows.values()) {
			if (row.iconEl.dataset['state'] === 'in-progress') {
				this._setState(row, 'failed', localize('chatLiveStepInterrupted',
					'stream ended before completion'));
			}
		}
	}

	// -------------------------------------------------------------------------
	// Row lifecycle
	// -------------------------------------------------------------------------

	private _createRow(key: string, event: LiveStepsEvent): RowHandle {
		const element = dom.append(this._bodyEl, dom.$('div.insrc-chat-live-step'));
		// Indent rows that belong to a child plan; each ancestor level
		// adds 14px of left padding.
		if (event.parentTaskPath !== undefined) {
			const depth = event.parentTaskPath.split('.').length;
			element.style.paddingLeft = `${depth * 14}px`;
		}

		const iconEl = dom.append(element, dom.$('span.codicon'));
		const titleEl = dom.append(element, dom.$('span.insrc-chat-live-step-title'));
		const statusEl = dom.append(element, dom.$('span.insrc-chat-live-step-status'));

		titleEl.textContent = this._titleFor(event);

		const row: RowHandle = { element, iconEl, titleEl, statusEl, key };
		this._rows.set(key, row);
		this._setState(row, 'idle', '');
		return row;
	}

	private _applyEvent(row: RowHandle, event: LiveStepsEvent): void {
		const s = event.status;
		if (s === 'completed' || s === 'ok' || s === 'accepted') {
			this._setState(row, 'ok', this._statusTextFor(event));
		} else if (s === 'failed') {
			this._setState(row, 'failed', this._statusTextFor(event));
		} else if (s === 'skipped-dependency-unavailable' || s === 'skipped') {
			this._setState(row, 'skipped', this._statusTextFor(event));
		} else if (s === 'started' || s.startsWith('started:') || s.startsWith('attempt-')) {
			this._setState(row, 'in-progress', this._statusTextFor(event));
		} else {
			this._setState(row, 'in-progress', this._statusTextFor(event));
		}
	}

	private _setState(row: RowHandle, state: RowState, statusText: string): void {
		row.iconEl.dataset['state'] = state;
		row.iconEl.classList.forEach(c => {
			if (c.startsWith('codicon-')) { row.iconEl.classList.remove(c); }
		});
		row.iconEl.classList.add('codicon');
		switch (state) {
			case 'idle':
				row.iconEl.classList.add('codicon-circle-large-outline');
				break;
			case 'in-progress':
				row.iconEl.classList.add('codicon-loading', 'codicon-modifier-spin');
				break;
			case 'ok':
				row.iconEl.classList.add('codicon-pass-filled');
				break;
			case 'failed':
				row.iconEl.classList.add('codicon-error');
				break;
			case 'skipped':
				row.iconEl.classList.add('codicon-circle-slash');
				break;
		}
		row.statusEl.textContent = statusText;
	}

	// -------------------------------------------------------------------------
	// Naming
	// -------------------------------------------------------------------------

	private _keyFor(event: LiveStepsEvent): string {
		if (event.taskId !== undefined) {
			return `task:${event.parentTaskPath ?? ''}:${event.taskId}`;
		}
		return `stage:${event.step}`;
	}

	private _titleFor(event: LiveStepsEvent): string {
		if (event.taskId !== undefined) {
			const prefix = event.parentTaskPath !== undefined
				? `${event.parentTaskPath}.${event.taskId}`
				: event.taskId;
			const template = event.template !== undefined ? ` ${event.template}` : '';
			const indexed = (event.index !== undefined && event.total !== undefined)
				? ` (${event.index}/${event.total})`
				: '';
			return `${prefix}${template}${indexed}`;
		}
		return capitalise(event.step);
	}

	private _statusTextFor(event: LiveStepsEvent): string {
		if (event.taskId !== undefined) {
			if (event.status === 'ok' || event.status === 'failed' || event.status === 'skipped-dependency-unavailable') {
				return '';
			}
			return localize('chatLiveStepRunning', 'running…');
		}
		// Stage-substep events carry a stable id in `substep` and an
		// optional human-readable line in `detail`. Prefer detail when
		// present so the row shows "building code/M run bundle" rather
		// than the raw "substep-bundle-shaper" wire status.
		if (event.substep !== undefined) {
			return event.detail !== undefined && event.detail.length > 0
				? event.detail
				: event.substep;
		}
		return event.status;
	}
}

function capitalise(s: string): string {
	if (s.length === 0) { return s; }
	return s.charAt(0).toUpperCase() + s.slice(1);
}
