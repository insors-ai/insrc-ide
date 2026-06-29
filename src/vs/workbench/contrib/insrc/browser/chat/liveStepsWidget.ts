/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * LiveStepsWidget -- per-run structured progress display.
 *
 * Replaces U1's rolling-text progress bubble with a vertical list of
 * step rows. Each row tracks one of:
 *   - a pipeline stage         (classify / plan / execute)
 *   - a per-task event         (taskId + template) inside the execute
 *     stage. Nested task paths (parentTaskPath set) indent under their
 *     ancestor row.
 *
 * Rows update in place as events arrive: a task-started event flips a
 * row from idle to in-progress (spinning icon); a task-completed
 * event flips it to ok / failed / skipped with the matching codicon.
 *
 * One widget instance per runId. The chat pane creates a fresh
 * widget when a new run kicks off + drops it when the stream ends.
 *
 * Pure DOM (no Monaco / no list virtualization). Plans are at most a
 * few dozen tasks, and we render one row per task -- well under the
 * threshold where virtualization matters.
 */

import * as dom from '../../../../../base/browser/dom.js';

/** Inputs the widget surfaces -- a normalised shape so the chat pane
 *  doesn't have to know about the daemon's raw progress-frame field
 *  names. */
export interface LiveStepsEvent {
	/** From the daemon's progress frame -- 'classify' / 'plan' /
	 *  'execute' / 'task-N/M' / 'task-<taskId>'. */
	readonly step: string;
	/** From the frame -- 'started' / 'completed' / 'ok' / 'failed' /
	 *  'skipped-dependency-unavailable' / 'accepted' / etc. */
	readonly status: string;
	readonly taskId?: string;
	readonly template?: string;
	readonly index?: number;
	readonly total?: number;
	readonly parentTaskPath?: string;
}

type RowState = 'idle' | 'in-progress' | 'ok' | 'failed' | 'skipped';

interface RowHandle {
	readonly element: HTMLElement;
	readonly iconEl: HTMLElement;
	readonly titleEl: HTMLElement;
	readonly statusEl: HTMLElement;
	/** Stable key for dedup: stage name OR `${parentTaskPath ?? ''}:${taskId}`. */
	readonly key: string;
}

export class LiveStepsWidget {
	readonly element: HTMLElement;

	private readonly _rows = new Map<string, RowHandle>();

	constructor(parent: HTMLElement) {
		this.element = dom.append(parent, dom.$('div.insrc-chat-live-steps'));
		this.element.style.display = 'flex';
		this.element.style.flexDirection = 'column';
		this.element.style.gap = '2px';
		this.element.style.padding = '6px 10px';
		this.element.style.fontSize = '12px';
		this.element.style.fontFamily = 'var(--vscode-editor-font-family)';
		this.element.style.border = '1px solid var(--vscode-panel-border)';
		this.element.style.borderRadius = '4px';
		this.element.style.background = 'var(--vscode-editorWidget-background)';
		this.element.style.maxWidth = '95%';
		this.element.style.alignSelf = 'flex-start';
	}

	update(event: LiveStepsEvent): void {
		const key = this._keyFor(event);
		const row = this._rows.get(key) ?? this._createRow(key, event);
		this._applyEvent(row, event);
	}

	/**
	 * Called when the stream's terminal frame has arrived. Drops any
	 * still-in-progress rows to an "unknown" state -- they'll never
	 * tick to ok/failed otherwise. (The daemon's invariant is that
	 * every task-started gets a paired task-completed, but if a
	 * stream errors mid-run, leftover in-progress rows would mislead.)
	 */
	finalize(): void {
		for (const row of this._rows.values()) {
			if (row.iconEl.dataset['state'] === 'in-progress') {
				this._setState(row, 'failed', 'stream ended before completion');
			}
		}
	}

	// -------------------------------------------------------------------------
	// Row lifecycle
	// -------------------------------------------------------------------------

	private _createRow(key: string, event: LiveStepsEvent): RowHandle {
		const element = dom.append(this.element, dom.$('div.insrc-chat-live-step'));
		element.style.display = 'flex';
		element.style.alignItems = 'baseline';
		element.style.gap = '6px';
		element.style.lineHeight = '1.6';
		// Indent rows that belong to a child plan.
		if (event.parentTaskPath !== undefined) {
			const depth = event.parentTaskPath.split('.').length;
			element.style.paddingLeft = `${depth * 14}px`;
			element.style.opacity = '0.92';
		}

		const iconEl = dom.append(element, dom.$('span.insrc-chat-live-step-icon.codicon'));
		iconEl.style.fontSize = '13px';
		iconEl.style.opacity = '0.85';

		const titleEl = dom.append(element, dom.$('span.insrc-chat-live-step-title'));
		titleEl.style.flex = '0 0 auto';

		const statusEl = dom.append(element, dom.$('span.insrc-chat-live-step-status'));
		statusEl.style.flex = '1 1 auto';
		statusEl.style.opacity = '0.7';
		statusEl.style.fontSize = '11px';
		statusEl.style.overflow = 'hidden';
		statusEl.style.textOverflow = 'ellipsis';
		statusEl.style.whiteSpace = 'nowrap';
		statusEl.style.minWidth = '0';

		titleEl.textContent = this._titleFor(event);

		const row: RowHandle = { element, iconEl, titleEl, statusEl, key };
		this._rows.set(key, row);
		this._setState(row, 'idle', '');
		return row;
	}

	private _applyEvent(row: RowHandle, event: LiveStepsEvent): void {
		// Map the daemon's status verbs onto row states.
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
			// Unknown verb -- treat as in-progress with the raw status text.
			this._setState(row, 'in-progress', this._statusTextFor(event));
		}
	}

	private _setState(row: RowHandle, state: RowState, statusText: string): void {
		row.iconEl.dataset['state'] = state;
		// Remove any previous codicon-* class + apply the new one.
		row.iconEl.classList.forEach(c => {
			if (c.startsWith('codicon-')) { row.iconEl.classList.remove(c); }
		});
		switch (state) {
			case 'idle':
				row.iconEl.classList.add('codicon-circle-large-outline');
				row.iconEl.style.color = '';
				break;
			case 'in-progress':
				row.iconEl.classList.add('codicon-loading');
				row.iconEl.classList.add('codicon-modifier-spin');
				row.iconEl.style.color = '';
				break;
			case 'ok':
				row.iconEl.classList.add('codicon-pass-filled');
				row.iconEl.style.color = 'var(--vscode-charts-green, var(--vscode-testing-iconPassed))';
				break;
			case 'failed':
				row.iconEl.classList.add('codicon-error');
				row.iconEl.style.color = 'var(--vscode-errorForeground)';
				break;
			case 'skipped':
				row.iconEl.classList.add('codicon-circle-slash');
				row.iconEl.style.color = 'var(--vscode-disabledForeground)';
				break;
		}
		row.statusEl.textContent = statusText;
	}

	// -------------------------------------------------------------------------
	// Naming
	// -------------------------------------------------------------------------

	private _keyFor(event: LiveStepsEvent): string {
		if (event.taskId !== undefined) {
			// Tasks may appear at different recursion depths; the parent
			// path disambiguates a child-plan t01 from a root-plan t01.
			return `task:${event.parentTaskPath ?? ''}:${event.taskId}`;
		}
		// Stage-level row -- the step string IS the stage name.
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
		// Stage row -- title is just the stage name capitalised.
		return capitalise(event.step);
	}

	private _statusTextFor(event: LiveStepsEvent): string {
		// For task events the status is short ('ok', 'failed', ...) --
		// don't echo that as the status text since the icon already
		// conveys it. Use the template instead, or blank for terminal
		// states.
		if (event.taskId !== undefined) {
			if (event.status === 'ok' || event.status === 'failed' || event.status === 'skipped-dependency-unavailable') {
				return '';
			}
			// in-progress -- show template + 'running' verb
			return 'running…';
		}
		// Stage row -- pass the status text through.
		return event.status;
	}
}

function capitalise(s: string): string {
	if (s.length === 0) { return s; }
	return s.charAt(0).toUpperCase() + s.slice(1);
}
