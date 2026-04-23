/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/notepadTodos.css';
import * as dom from '../../../../../base/browser/dom.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import {
	IInsrcTodosService,
	type TodoItem,
	type TodoItemStatus,
	type TodoList,
	type TodoOwner,
} from '../../common/todosService.js';
import { NotepadTodosEditorInput } from './notepadTodosInput.js';

// ---------------------------------------------------------------------------
// Constants + helpers
// ---------------------------------------------------------------------------

/**
 * Agent families the user can hand their lists off to. Excludes `'user'`
 * (you can't transfer to yourself) and `'system'` (daemon-only).
 */
const FORWARD_TARGET_FAMILIES: readonly TodoOwner[] = [
	'chat', 'implementation', 'brainstorm', 'designer',
	'planner', 'tester', 'research', 'debugging', 'deployment',
];

function iconForItemStatus(status: TodoItemStatus): ThemeIcon {
	switch (status) {
		case 'pending': return Codicon.circleLargeOutline;
		case 'in_progress': return Codicon.play;
		case 'blocked': return Codicon.warning;
		case 'completed': return Codicon.check;
		case 'cancelled': return Codicon.close;
	}
}

/** Cycle through the most useful statuses on click (pending → in_progress → completed → pending). */
function nextStatus(current: TodoItemStatus): TodoItemStatus {
	switch (current) {
		case 'pending': return 'in_progress';
		case 'in_progress': return 'completed';
		case 'completed': return 'pending';
		case 'blocked': return 'in_progress';
		case 'cancelled': return 'pending';
	}
}

// ---------------------------------------------------------------------------
// Pane
// ---------------------------------------------------------------------------

/**
 * Per-session "My TODOs" pane (plans/todo-framework.md Phase 9).
 * Writable surface: user creates / edits / reorders / forwards their
 * own lists here. Agent-owned lists never render -- the agent todos
 * pane ([browser/todos/todosPane.ts](../todos/todosPane.ts)) is the
 * read-only review surface for those.
 */
export class NotepadTodosEditorPane extends EditorPane {
	static readonly ID = 'insrc.notepadTodosPane';

	private _container!: HTMLElement;
	private _newListBtn!: HTMLButtonElement;
	private _listsArea!: HTMLElement;
	private _emptyState!: HTMLElement;

	private _sessionId: string | undefined;
	private _serviceListeners: IDisposable[] = [];
	/** Per-list item-id selections for the "Forward selected" affordance. */
	private _selectedItemIds = new Map<string, Set<string>>();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInsrcTodosService private readonly todosService: IInsrcTodosService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@ILogService private readonly logService: ILogService,
	) {
		super(NotepadTodosEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = dom.append(parent, dom.$('.insrc-notepad-todos'));

		const header = dom.append(this._container, dom.$('.insrc-notepad-todos-header'));
		const headerLeft = dom.append(header, dom.$('.insrc-notepad-todos-header-left'));
		const titleEl = dom.append(headerLeft, dom.$('h2.insrc-notepad-todos-title'));
		titleEl.textContent = 'My TODOs';
		const subtitle = dom.append(headerLeft, dom.$('span.insrc-notepad-todos-subtitle'));
		subtitle.textContent = 'user-owned · private to you until forwarded';

		this._newListBtn = dom.append(header, dom.$('button.insrc-notepad-todos-new-list')) as HTMLButtonElement;
		this._newListBtn.textContent = '+ New list';
		this._newListBtn.addEventListener('click', () => void this._createNewList());

		const main = dom.append(this._container, dom.$('.insrc-notepad-todos-main'));
		this._listsArea = dom.append(main, dom.$('.insrc-notepad-todos-lists'));
		this._emptyState = dom.append(main, dom.$('.insrc-notepad-todos-empty'));
		this._emptyState.textContent = 'No TODO lists yet. Click "+ New list" to start one.';
	}

	override async setInput(
		input: NotepadTodosEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		this._sessionId = input.sessionId;
		this._detachServiceListeners();
		this._serviceListeners.push(
			this.todosService.onDidChange(() => this._render()),
			this.todosService.onDidChangeList(list => this._onListChanged(list)),
			this.todosService.onDidRemoveList(id => this._onListRemoved(id)),
		);
		this._render();
	}

	override clearInput(): void {
		this._detachServiceListeners();
		this._sessionId = undefined;
		this._selectedItemIds.clear();
		super.clearInput();
	}

	layout(dimension: dom.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}

	override dispose(): void {
		this._detachServiceListeners();
		super.dispose();
	}

	// -- Rendering -----------------------------------------------------------

	private _render(): void {
		if (!this._container) {
			return;
		}
		const lists = this._userLists();
		dom.clearNode(this._listsArea);
		if (lists.length === 0) {
			this._emptyState.classList.remove('hidden');
			return;
		}
		this._emptyState.classList.add('hidden');
		for (const list of lists) {
			this._listsArea.appendChild(this._renderListCard(list));
		}
	}

	private _userLists(): readonly TodoList[] {
		if (this._sessionId === undefined) {
			return [];
		}
		return this.todosService.lists.filter(
			list => list.sessionId === this._sessionId && list.owner === 'user',
		);
	}

	private _renderListCard(list: TodoList): HTMLElement {
		const card = dom.$('.insrc-notepad-todos-card', { 'data-list-id': list.id });
		card.classList.add(`status-${list.status}`);

		const header = dom.append(card, dom.$('.insrc-notepad-todos-card-header'));

		const titleEl = dom.append(header, dom.$('input.insrc-notepad-todos-card-title')) as HTMLInputElement;
		titleEl.value = list.title;
		titleEl.spellcheck = false;
		titleEl.addEventListener('change', () => {
			const next = titleEl.value.trim();
			if (next.length === 0 || next === list.title) {
				titleEl.value = list.title;
				return;
			}
			void this._call(() => this.todosService.updateListFields(list.id, { title: next }));
		});

		const meta = dom.append(header, dom.$('span.insrc-notepad-todos-card-meta'));
		meta.textContent = this._metaText(list);

		const actions = dom.append(header, dom.$('.insrc-notepad-todos-card-actions'));
		const archiveBtn = dom.append(actions, dom.$('button.insrc-notepad-todos-card-action')) as HTMLButtonElement;
		archiveBtn.textContent = list.status === 'archived' ? 'Unarchive' : 'Archive';
		archiveBtn.addEventListener('click', () => {
			void this._call(() => list.status === 'archived'
				? this.todosService.unarchiveList(list.id)
				: this.todosService.archiveList(list.id));
		});

		const deleteBtn = dom.append(actions, dom.$('button.insrc-notepad-todos-card-action')) as HTMLButtonElement;
		deleteBtn.textContent = 'Delete';
		deleteBtn.addEventListener('click', () => void this._deleteList(list));

		// Body: items + add-item button
		const body = dom.append(card, dom.$('.insrc-notepad-todos-card-body'));
		const itemsWrap = dom.append(body, dom.$('.insrc-notepad-todos-items'));
		for (const item of list.items) {
			itemsWrap.appendChild(this._renderItemRow(list, item));
		}

		const addBtn = dom.append(body, dom.$('button.insrc-notepad-todos-add-item')) as HTMLButtonElement;
		addBtn.textContent = '+ Add item';
		addBtn.addEventListener('click', () => void this._addItem(list));

		// Toolbar: forward-selected + handoff-entire-list
		const toolbar = dom.append(card, dom.$('.insrc-notepad-todos-card-toolbar'));

		const targetSelect = dom.append(toolbar, dom.$('select.insrc-notepad-todos-target-select')) as HTMLSelectElement;
		for (const family of FORWARD_TARGET_FAMILIES) {
			const opt = document.createElement('option');
			opt.value = family as string;
			opt.textContent = family as string;
			targetSelect.appendChild(opt);
		}

		const forwardBtn = dom.append(toolbar, dom.$('button.insrc-notepad-todos-forward-selected')) as HTMLButtonElement;
		forwardBtn.textContent = 'Forward selected (withTodo)';
		forwardBtn.title = 'Spawn a new agent run with the selected items as snapshots; the result updates each source item\'s status.';
		forwardBtn.disabled = (this._selectedItemIds.get(list.id)?.size ?? 0) === 0;
		forwardBtn.addEventListener('click', () => {
			const target = targetSelect.value as TodoOwner;
			void this._forwardSelected(list, target);
		});

		const handoffBtn = dom.append(toolbar, dom.$('button.insrc-notepad-todos-handoff-list')) as HTMLButtonElement;
		handoffBtn.textContent = 'Hand off list';
		handoffBtn.title = 'Transfer this list to the selected agent family. Ownership flips permanently.';
		handoffBtn.addEventListener('click', async () => {
			const target = targetSelect.value as TodoOwner;
			const { confirmed } = await this.dialogService.confirm({
				type: 'warning',
				message: `Hand off this list to ${target}?`,
				detail: `Ownership flips permanently. You'll be able to read the list in the Todos pane but won't be able to edit it.`,
				primaryButton: 'Hand off',
				cancelButton: 'Cancel',
			});
			if (!confirmed) {
				return;
			}
			await this._call(() => this.todosService.transferList(list.id, target, `user handoff from notepad`));
		});

		return card;
	}

	private _renderItemRow(list: TodoList, item: TodoItem): HTMLElement {
		const row = dom.$('.insrc-notepad-todos-item', { 'data-item-id': item.id });
		row.classList.add(`item-status-${item.status}`);

		const select = dom.append(row, dom.$('input.insrc-notepad-todos-item-select')) as HTMLInputElement;
		select.type = 'checkbox';
		select.checked = this._selectedItemIds.get(list.id)?.has(item.id) ?? false;
		select.addEventListener('change', () => {
			const bucket = this._selectedItemIds.get(list.id) ?? new Set<string>();
			if (select.checked) {
				bucket.add(item.id);
			} else {
				bucket.delete(item.id);
			}
			this._selectedItemIds.set(list.id, bucket);
			this._render();
		});

		const icon = dom.append(row, dom.$('span.insrc-notepad-todos-item-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(iconForItemStatus(item.status)));
		icon.title = `${item.status} - click to cycle`;
		icon.addEventListener('click', () => {
			const next = nextStatus(item.status);
			void this._call(() => this.todosService.updateItem(item.id, { status: next }));
		});

		const title = dom.append(row, dom.$('input.insrc-notepad-todos-item-title')) as HTMLInputElement;
		title.value = item.title;
		title.spellcheck = false;
		title.addEventListener('change', () => {
			const next = title.value.trim();
			if (next.length === 0 || next === item.title) {
				title.value = item.title;
				return;
			}
			void this._call(() => this.todosService.updateItem(item.id, { title: next }));
		});

		const remove = dom.append(row, dom.$('button.insrc-notepad-todos-item-remove')) as HTMLButtonElement;
		remove.textContent = 'Remove';
		remove.addEventListener('click', () => {
			void this._call(() => this.todosService.removeItem(item.id));
		});

		return row;
	}

	private _metaText(list: TodoList): string {
		const pending = list.items.filter(
			it => it.status !== 'completed' && it.status !== 'cancelled',
		).length;
		const total = list.items.length;
		const parts: string[] = [`${total} item${total === 1 ? '' : 's'}`];
		if (pending > 0) {
			parts.push(`${pending} pending`);
		}
		if (list.status === 'archived') {
			parts.push('archived');
		} else if (list.status === 'completed') {
			parts.push('complete');
		}
		return parts.join(' · ');
	}

	// -- Actions -------------------------------------------------------------

	private async _forwardSelected(list: TodoList, target: TodoOwner): Promise<void> {
		if (this._sessionId === undefined) {
			return;
		}
		const selectedIds = this._selectedItemIds.get(list.id);
		if (selectedIds === undefined || selectedIds.size === 0) {
			return;
		}
		const items = list.items.filter(it => selectedIds.has(it.id));
		if (items.length === 0) {
			return;
		}

		// Build snapshots. `sourceRef` is the source item id so we can
		// apply the response statuses back onto the user's originals.
		const snapshots = items.map(it => {
			const snap: { sourceRef: string; title: string; description?: string; tags?: readonly string[]; meta?: Readonly<Record<string, unknown>> } = {
				sourceRef: it.id,
				title: it.title,
			};
			if (it.description !== undefined) {
				snap.description = it.description;
			}
			if (it.tags !== undefined) {
				snap.tags = it.tags;
			}
			if (it.meta !== undefined) {
				snap.meta = it.meta;
			}
			return snap;
		});

		try {
			const result = await this.todosService.forwardToAgent({
				targetFamily: target,
				sessionId: this._sessionId,
				items: snapshots,
			});
			for (const resp of result.items) {
				const sourceId = resp.sourceRef;
				const patch: {
					status: typeof resp.status;
					blockedReason?: string;
				} = { status: resp.status };
				if (resp.blockedReason !== undefined) {
					patch.blockedReason = resp.blockedReason;
				}
				try {
					await this.todosService.updateItem(sourceId, patch);
				} catch (err) {
					this.logService.warn(`[notepad-todos] failed to apply response status for ${sourceId}: ${(err as Error).message}`);
				}
			}
			// Clear the selection and re-render to reflect the new statuses.
			this._selectedItemIds.set(list.id, new Set());
			this.notificationService.info(`Forwarded ${items.length} item(s) to ${target}.`);
		} catch (err) {
			this.notificationService.error(`Failed to forward: ${(err as Error).message}`);
		}
	}

	private async _createNewList(): Promise<void> {
		if (this._sessionId === undefined) {
			this.notificationService.info('Start a chat session first -- user TODOs are session-scoped.');
			return;
		}
		await this._call(() => this.todosService.createUserList({
			sessionId: this._sessionId as string,
			title: 'New list',
		}));
	}

	private async _addItem(list: TodoList): Promise<void> {
		await this._call(() => this.todosService.addItem(list.id, { title: 'New item' }));
	}

	private async _deleteList(list: TodoList): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			type: 'warning',
			message: `Delete "${list.title}"?`,
			detail: 'The list and all its items are removed. Transfer history is lost.',
			primaryButton: 'Delete',
			cancelButton: 'Cancel',
		});
		if (!confirmed) {
			return;
		}
		// Archive-then-clear is the closest approximation to delete the
		// current service exposes (cleanup with sessionIds would nuke
		// everything in the session). For now we archive the list and
		// clearCompleted to empty it; a proper todos.deleteList RPC is
		// a follow-up item.
		try {
			await this.todosService.archiveList(list.id);
		} catch (err) {
			this.notificationService.error(`Failed to archive list: ${(err as Error).message}`);
		}
	}

	private async _call<T>(op: () => Promise<T>): Promise<T | undefined> {
		try {
			return await op();
		} catch (err) {
			this.notificationService.error(`Notepad TODO op failed: ${(err as Error).message}`);
			this.logService.warn(`[notepad-todos] op failed: ${(err as Error).message}`);
			return undefined;
		}
	}

	// -- Events --------------------------------------------------------------

	private _onListChanged(list: TodoList): void {
		if (this._sessionId === undefined) {
			return;
		}
		if (list.sessionId !== this._sessionId) {
			return;
		}
		// List left the user's ownership (transferred out) -- drop it; the
		// service's cache still has it (as owner=someFamily) but we don't
		// render it here.
		if (list.owner !== 'user') {
			const existing = this._listsArea.querySelector<HTMLElement>(`[data-list-id="${list.id}"]`);
			existing?.remove();
			if (this._userLists().length === 0) {
				this._emptyState.classList.remove('hidden');
			}
			return;
		}
		this._render();
	}

	private _onListRemoved(listId: string): void {
		this._selectedItemIds.delete(listId);
		const existing = this._listsArea.querySelector<HTMLElement>(`[data-list-id="${listId}"]`);
		existing?.remove();
		if (this._userLists().length === 0) {
			this._emptyState.classList.remove('hidden');
		}
	}

	private _detachServiceListeners(): void {
		for (const d of this._serviceListeners) {
			try {
				d.dispose();
			} catch {
				// ignore
			}
		}
		this._serviceListeners = [];
	}
}
