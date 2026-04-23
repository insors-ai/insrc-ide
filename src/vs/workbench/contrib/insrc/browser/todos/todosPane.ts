/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/todos.css';
import * as dom from '../../../../../base/browser/dom.js';
import { type IDisposable } from '../../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import {
	IInsrcTodosService,
	type TodoComment,
	type TodoItem,
	type TodoItemStatus,
	type TodoList,
	type TodoOwner,
} from '../../common/todosService.js';
import { TodosEditorInput } from './todosInput.js';

// ---------------------------------------------------------------------------
// Icons + helpers
// ---------------------------------------------------------------------------

function iconForItemStatus(status: TodoItemStatus): ThemeIcon {
	switch (status) {
		case 'pending': return Codicon.circleLargeOutline;
		case 'in_progress': return Codicon.play;
		case 'blocked': return Codicon.warning;
		case 'completed': return Codicon.check;
		case 'cancelled': return Codicon.close;
	}
}

function isTerminalItem(status: TodoItemStatus): boolean {
	return status === 'completed' || status === 'cancelled';
}

function defaultCollapsedForList(list: TodoList): boolean {
	if (list.owner === 'system') {
		return true;
	}
	if (list.items.length === 0) {
		return false;
	}
	return list.items.every(it => isTerminalItem(it.status));
}

// ---------------------------------------------------------------------------
// TodosEditorPane
// ---------------------------------------------------------------------------

/**
 * Per-session Todos review pane (plans/todo-framework.md Phase 5a).
 * Read-only: renders every list the IInsrcTodosService has cached for
 * the active session. Mutations happen agent-side only; this pane
 * never writes.
 */
export class TodosEditorPane extends EditorPane {
	static readonly ID = 'insrc.todosPane';
	private static readonly COLLAPSE_KEY_PREFIX = 'insrc.todos.collapse:';

	private _container!: HTMLElement;
	private _headerSubtitle!: HTMLElement;
	private _headerCount!: HTMLElement;
	private _listsArea!: HTMLElement;
	private _emptyState!: HTMLElement;

	/** Session scope of the current input. Kept so re-renders only pick up the right lists. */
	private _sessionId: string | undefined;

	/** Per-session collapse overrides; persisted on toggle. */
	private _collapsed = new Set<string>();
	private _expanded = new Set<string>();

	private _serviceListeners: IDisposable[] = [];

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly _storage: IStorageService,
		@IInstantiationService _instantiationService: IInstantiationService,
		@IInsrcTodosService private readonly todosService: IInsrcTodosService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super(TodosEditorPane.ID, group, telemetryService, themeService, _storage);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = dom.append(parent, dom.$('.insrc-todos'));

		const header = dom.append(this._container, dom.$('.insrc-todos-header'));
		const headerLeft = dom.append(header, dom.$('.insrc-todos-header-left'));
		const iconEl = dom.append(headerLeft, dom.$('.insrc-todos-header-icon'));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.checklist));
		const titleEl = dom.append(headerLeft, dom.$('h2.insrc-todos-title'));
		titleEl.textContent = 'Todos';
		this._headerSubtitle = dom.append(headerLeft, dom.$('span.insrc-todos-subtitle'));
		this._headerSubtitle.textContent = 'read-only review';
		this._headerCount = dom.append(header, dom.$('span.insrc-todos-count'));
		this._headerCount.textContent = '';

		const main = dom.append(this._container, dom.$('.insrc-todos-main'));
		this._listsArea = dom.append(main, dom.$('.insrc-todos-lists'));
		this._emptyState = dom.append(main, dom.$('.insrc-todos-empty'));
		this._emptyState.textContent = 'No todo lists for this session yet. Agents create lists as they work.';
	}

	override async setInput(input: TodosEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this._sessionId = input.sessionId;
		this._detachServiceListeners();
		this._serviceListeners.push(
			this.todosService.onDidChange(() => this._render()),
			this.todosService.onDidChangeList(list => this._onListChanged(list)),
			this.todosService.onDidRemoveList(id => this._onListRemoved(id)),
		);
		this._loadCollapseState();
		this._render();
	}

	override clearInput(): void {
		this._detachServiceListeners();
		this._sessionId = undefined;
		this._collapsed.clear();
		this._expanded.clear();
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
		const lists = this._activeLists();
		this._headerCount.textContent = lists.length === 0
			? ''
			: `${lists.length} ${lists.length === 1 ? 'list' : 'lists'}`;

		dom.clearNode(this._listsArea);
		if (lists.length === 0) {
			this._emptyState.classList.remove('hidden');
			return;
		}
		this._emptyState.classList.add('hidden');

		// Build an id->list map so parent/child link renderers can resolve
		// cross-references in O(1).
		const byId = new Map<string, TodoList>();
		for (const list of lists) {
			byId.set(list.id, list);
		}
		const childrenOf = new Map<string, TodoList[]>();
		for (const list of lists) {
			const parent = list.parentListId;
			if (parent !== undefined && parent.length > 0) {
				const bucket = childrenOf.get(parent) ?? [];
				bucket.push(list);
				childrenOf.set(parent, bucket);
			}
		}

		for (const list of lists) {
			this._listsArea.appendChild(this._renderListCard(list, byId, childrenOf));
		}
	}

	private _renderListCard(
		list: TodoList,
		byId: Map<string, TodoList>,
		childrenOf: Map<string, TodoList[]>,
	): HTMLElement {
		const collapsed = this._isCollapsed(list);
		const card = dom.$('.insrc-todos-card', { 'data-list-id': list.id });
		if (collapsed) {
			card.classList.add('collapsed');
		}
		card.classList.add(`owner-${list.owner}`);
		card.classList.add(`status-${list.status}`);

		// Header row: chevron, owner badge, title, pending count
		const header = dom.append(card, dom.$('.insrc-todos-card-header'));
		const chevron = dom.append(header, dom.$('span.insrc-todos-chevron'));
		chevron.classList.add(...ThemeIcon.asClassNameArray(collapsed ? Codicon.chevronRight : Codicon.chevronDown));
		header.setAttribute('tabindex', '0');
		header.setAttribute('role', 'button');
		header.setAttribute('aria-expanded', String(!collapsed));

		const ownerBadge = dom.append(header, dom.$('span.insrc-todos-owner-badge'));
		ownerBadge.textContent = this._renderOwner(list.owner);

		const titleEl = dom.append(header, dom.$('span.insrc-todos-card-title'));
		titleEl.textContent = list.title;

		const meta = dom.append(header, dom.$('span.insrc-todos-card-meta'));
		meta.textContent = this._metaLine(list);

		const toggle = (): void => {
			this._toggleCollapse(list);
		};
		header.addEventListener('click', e => {
			// Don't toggle on clicks inside the kebab menu (not yet built).
			const target = e.target as HTMLElement;
			if (target.closest('.insrc-todos-kebab')) {
				return;
			}
			toggle();
		});
		header.addEventListener('keydown', e => {
			if (e.key === ' ' || e.key === 'Enter') {
				e.preventDefault();
				toggle();
			}
		});

		// Parent link (↑ parent) if this card has a parent in the same session.
		if (list.parentListId !== undefined && list.parentListId.length > 0) {
			const parent = byId.get(list.parentListId);
			const parentRow = dom.append(card, dom.$('.insrc-todos-parent-link'));
			if (parent) {
				parentRow.textContent = `↑ parent: ${parent.title}`;
				parentRow.setAttribute('role', 'link');
				parentRow.addEventListener('click', () => {
					this._scrollToCard(parent.id);
				});
			} else {
				parentRow.textContent = `↑ parent: (missing)`;
				parentRow.classList.add('missing');
			}
		}

		// Body: only rendered when expanded.
		const body = dom.append(card, dom.$('.insrc-todos-card-body'));
		if (collapsed) {
			body.classList.add('hidden');
		}

		if (list.body !== undefined && list.body.length > 0) {
			const narr = dom.append(body, dom.$('.insrc-todos-card-narrative'));
			narr.textContent = list.body;
		}

		const itemsWrap = dom.append(body, dom.$('.insrc-todos-items'));
		if (list.items.length === 0) {
			const empty = dom.append(itemsWrap, dom.$('.insrc-todos-items-empty'));
			empty.textContent = '(no items yet)';
		} else {
			for (const item of list.items) {
				itemsWrap.appendChild(this._renderItemRow(item));
			}
		}

		// Child references row.
		const children = childrenOf.get(list.id) ?? [];
		if (children.length > 0) {
			const row = dom.append(body, dom.$('.insrc-todos-children-link'));
			const label = dom.append(row, dom.$('span.insrc-todos-children-label'));
			label.textContent = `↓ children (${children.length}): `;
			children.forEach((child, idx) => {
				const link = dom.append(row, dom.$('a.insrc-todos-child-link'));
				link.textContent = child.title;
				link.addEventListener('click', e => {
					e.preventDefault();
					this._scrollToCard(child.id);
				});
				if (idx < children.length - 1) {
					dom.append(row, document.createTextNode(' · '));
				}
			});
		}

		return card;
	}

	private _renderItemRow(item: TodoItem): HTMLElement {
		const row = dom.$('.insrc-todos-item', { 'data-item-id': item.id });
		row.classList.add(`item-status-${item.status}`);

		const icon = dom.append(row, dom.$('span.insrc-todos-item-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(iconForItemStatus(item.status)));

		const titleEl = dom.append(row, dom.$('span.insrc-todos-item-title'));
		titleEl.textContent = item.title;

		if (item.status === 'blocked' && item.blockedReason !== undefined && item.blockedReason.length > 0) {
			const reason = dom.append(row, dom.$('span.insrc-todos-item-blocked-reason'));
			reason.textContent = item.blockedReason;
		}

		// Comment count + "unread by agent" indicator (Phase 5d).
		const comments = item.comments ?? [];
		if (comments.length > 0) {
			const badge = dom.append(row, dom.$('span.insrc-todos-item-comment-count'));
			const unacked = comments.filter(c => c.author === 'user' && c.agentAcknowledged !== true).length;
			// allow-any-unicode-next-line
			badge.textContent = unacked > 0
				// allow-any-unicode-next-line
				? `💬 ${comments.length} (${unacked} unacked)`
				// allow-any-unicode-next-line
				: `💬 ${comments.length}`;
			if (unacked > 0) {
				badge.classList.add('unacked');
			}
		}

		if (item.description !== undefined && item.description.length > 0) {
			const desc = dom.append(row, dom.$('.insrc-todos-item-description'));
			desc.textContent = item.description;
		}

		// Comments block: list each comment on its own line beneath the
		// item row, followed by a compact "+ Add comment" affordance
		// that reveals an inline textarea. Only rendered once the user
		// opens it (via the + button) to keep the list visually dense
		// when most items have no comments.
		const commentsWrap = dom.append(row, dom.$('.insrc-todos-item-comments'));
		if (comments.length > 0) {
			for (const comment of comments) {
				commentsWrap.appendChild(this._renderCommentRow(comment));
			}
		}
		this._appendAddCommentAffordance(item, commentsWrap);

		return row;
	}

	private _renderCommentRow(comment: TodoComment): HTMLElement {
		const row = dom.$('.insrc-todos-comment', { 'data-comment-id': comment.id });
		if (comment.author === 'user' && comment.agentAcknowledged !== true) {
			row.classList.add('unacked');
		}
		const author = dom.append(row, dom.$('span.insrc-todos-comment-author'));
		author.textContent = `(${comment.author})`;
		const body = dom.append(row, dom.$('span.insrc-todos-comment-body'));
		body.textContent = comment.body;
		if (comment.author === 'user') {
			const actions = dom.append(row, dom.$('.insrc-todos-comment-actions'));
			const deleteBtn = dom.append(actions, dom.$('button.insrc-todos-comment-delete')) as HTMLButtonElement;
			deleteBtn.textContent = 'delete';
			deleteBtn.title = 'Delete this comment';
			deleteBtn.addEventListener('click', async () => {
				try {
					await this.todosService.deleteComment(comment.id);
				} catch (err) {
					this.notificationService.error(`Failed to delete comment: ${(err as Error).message}`);
				}
			});
		}
		return row;
	}

	private _appendAddCommentAffordance(item: TodoItem, container: HTMLElement): void {
		const addBtn = dom.append(container, dom.$('button.insrc-todos-comment-add')) as HTMLButtonElement;
		addBtn.textContent = '+ Add comment';
		addBtn.addEventListener('click', () => {
			if (container.querySelector('.insrc-todos-comment-editor') !== null) {
				return; // already open
			}
			addBtn.style.display = 'none';

			const editor = dom.append(container, dom.$('.insrc-todos-comment-editor'));
			const textarea = dom.append(editor, dom.$('textarea.insrc-todos-comment-textarea')) as HTMLTextAreaElement;
			textarea.rows = 2;
			textarea.placeholder = 'Add a comment; the owning agent reads it on its next turn.';
			textarea.focus();

			const actions = dom.append(editor, dom.$('.insrc-todos-comment-editor-actions'));
			const submit = dom.append(actions, dom.$('button.insrc-todos-comment-submit')) as HTMLButtonElement;
			submit.textContent = 'Post';
			const cancel = dom.append(actions, dom.$('button.insrc-todos-comment-cancel')) as HTMLButtonElement;
			cancel.textContent = 'Cancel';

			const close = (): void => {
				editor.remove();
				addBtn.style.display = '';
			};
			cancel.addEventListener('click', close);
			submit.addEventListener('click', async () => {
				const body = textarea.value.trim();
				if (body.length === 0) {
					close();
					return;
				}
				submit.disabled = true;
				cancel.disabled = true;
				try {
					await this.todosService.addComment(item.id, body);
					close();
				} catch (err) {
					this.notificationService.error(`Failed to add comment: ${(err as Error).message}`);
					submit.disabled = false;
					cancel.disabled = false;
				}
			});
		});
	}

	private _metaLine(list: TodoList): string {
		const pending = list.items.filter(it => !isTerminalItem(it.status)).length;
		const total = list.items.length;
		const parts: string[] = [];
		parts.push(`${total} item${total === 1 ? '' : 's'}`);
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

	private _renderOwner(owner: TodoOwner): string {
		// Wrapped in brackets to mirror the DOM sketch in the plan.
		return `[${owner}]`;
	}

	private _scrollToCard(listId: string): void {
		const card = this._listsArea.querySelector<HTMLElement>(`[data-list-id="${listId}"]`);
		if (!card) {
			return;
		}
		// Expand the target card if it's collapsed so the link has somewhere to land.
		const list = this._activeLists().find(l => l.id === listId);
		if (list && this._isCollapsed(list)) {
			this._setCollapsed(list, false);
			this._render();
			const again = this._listsArea.querySelector<HTMLElement>(`[data-list-id="${listId}"]`);
			again?.scrollIntoView({ behavior: 'smooth', block: 'start' });
			return;
		}
		card.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	// -- Events --------------------------------------------------------------

	private _onListChanged(list: TodoList): void {
		// Scoped to the active session only.
		if (this._sessionId === undefined || list.sessionId !== this._sessionId) {
			return;
		}
		// Small optimisation: if the card exists, replace only that DOM
		// subtree so collapse state of sibling cards isn't flashed. If we
		// don't have it yet (new list), fall back to full re-render.
		const existing = this._listsArea.querySelector<HTMLElement>(`[data-list-id="${list.id}"]`);
		if (existing === null) {
			this._render();
			return;
		}
		const byId = new Map<string, TodoList>();
		const childrenOf = new Map<string, TodoList[]>();
		for (const l of this._activeLists()) {
			byId.set(l.id, l);
			if (l.parentListId !== undefined && l.parentListId.length > 0) {
				const bucket = childrenOf.get(l.parentListId) ?? [];
				bucket.push(l);
				childrenOf.set(l.parentListId, bucket);
			}
		}
		const replacement = this._renderListCard(list, byId, childrenOf);
		existing.replaceWith(replacement);
		this._headerCount.textContent = (() => {
			const n = this._activeLists().length;
			return n === 0 ? '' : `${n} ${n === 1 ? 'list' : 'lists'}`;
		})();
	}

	private _onListRemoved(listId: string): void {
		const existing = this._listsArea.querySelector<HTMLElement>(`[data-list-id="${listId}"]`);
		existing?.remove();
		this._collapsed.delete(listId);
		this._expanded.delete(listId);
		const lists = this._activeLists();
		this._headerCount.textContent = lists.length === 0 ? '' : `${lists.length} ${lists.length === 1 ? 'list' : 'lists'}`;
		if (lists.length === 0) {
			this._emptyState.classList.remove('hidden');
		}
	}

	// -- Collapse state ------------------------------------------------------

	private _isCollapsed(list: TodoList): boolean {
		if (this._collapsed.has(list.id)) {
			return true;
		}
		if (this._expanded.has(list.id)) {
			return false;
		}
		return defaultCollapsedForList(list);
	}

	private _setCollapsed(list: TodoList, collapsed: boolean): void {
		if (collapsed) {
			this._collapsed.add(list.id);
			this._expanded.delete(list.id);
		} else {
			this._expanded.add(list.id);
			this._collapsed.delete(list.id);
		}
		this._persistCollapseState();
	}

	private _toggleCollapse(list: TodoList): void {
		this._setCollapsed(list, !this._isCollapsed(list));
		this._render();
	}

	private _persistCollapseState(): void {
		if (this._sessionId === undefined) {
			return;
		}
		const key = TodosEditorPane.COLLAPSE_KEY_PREFIX + this._sessionId;
		const payload = {
			collapsed: [...this._collapsed],
			expanded: [...this._expanded],
		};
		try {
			this._storage.store(key, JSON.stringify(payload), StorageScope.PROFILE, StorageTarget.USER);
		} catch (err) {
			this.logService.warn(`[insrc-todos:pane] persist collapse failed: ${(err as Error).message}`);
		}
	}

	private _loadCollapseState(): void {
		this._collapsed.clear();
		this._expanded.clear();
		if (this._sessionId === undefined) {
			return;
		}
		const key = TodosEditorPane.COLLAPSE_KEY_PREFIX + this._sessionId;
		try {
			const raw = this._storage.get(key, StorageScope.PROFILE);
			if (raw === undefined) {
				return;
			}
			const parsed = JSON.parse(raw) as { collapsed?: string[]; expanded?: string[] };
			if (Array.isArray(parsed.collapsed)) {
				parsed.collapsed.forEach(id => this._collapsed.add(id));
			}
			if (Array.isArray(parsed.expanded)) {
				parsed.expanded.forEach(id => this._expanded.add(id));
			}
		} catch (err) {
			this.logService.warn(`[insrc-todos:pane] load collapse failed: ${(err as Error).message}`);
		}
	}

	// -- Service subscription ------------------------------------------------

	private _activeLists(): readonly TodoList[] {
		if (this._sessionId === undefined) {
			return [];
		}
		return this.todosService.lists.filter(list => list.sessionId === this._sessionId);
	}

	private _detachServiceListeners(): void {
		for (const l of this._serviceListeners) {
			try {
				l.dispose();
			} catch {
				// ignore
			}
		}
		this._serviceListeners = [];
	}
}

