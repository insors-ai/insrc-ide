/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatTodos.css';
import * as dom from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import {
	IInsrcTodosService,
	type TodoItem,
	type TodoList,
} from '../../common/todosService.js';
import { isArtifactList } from '../../common/insrcArtifacts.js';
import { TodosEditorInput } from '../todos/todosInput.js';

/**
 * Inline chat widget (plans/todo-framework.md Phase 5b).
 *
 * Renders a compact card per agent-owned TODO list in the chat
 * transcript. Each card appears at the position where the list was
 * first created and updates in place on subsequent mutations -- no
 * new chat message per event. System-owned lists are suppressed
 * inline (they live only in the editor pane).
 *
 * The widget subscribes directly to `IInsrcTodosService`; chatView
 * just instantiates it once and hands over a parent DOM node.
 */

// Icon + meta-line helpers come from the shared view helpers so the
// chat widget stays consistent with the todos pane + notepad pane
// (plans/todo-framework.md Phase 8).
import { formatListMeta, iconForItemStatus } from '../shared/todosViewHelpers.js';

interface CardHandles {
	readonly root: HTMLElement;
	readonly title: HTMLElement;
	readonly meta: HTMLElement;
	readonly chevron: HTMLElement;
	readonly parent: HTMLElement;
	readonly items: HTMLElement;
	readonly children: HTMLElement;
	collapsed: boolean;
	/** True if the user has explicitly toggled since the last auto-collapse. */
	userToggled: boolean;
}

export class ChatTodosWidget extends Disposable {

	private _container: HTMLElement | undefined;
	private _cards = new Map<string, CardHandles>();

	constructor(
		private readonly todosService: IInsrcTodosService,
		private readonly editorService: IEditorService,
		private readonly logService: ILogService,
	) {
		super();
	}

	/** Mount the widget into `parent`. Subsequent calls are a no-op. */
	mount(parent: HTMLElement): void {
		if (this._container !== undefined) {
			return;
		}
		this._container = dom.append(parent, dom.$('.insrc-chat-todos'));

		this._register(this.todosService.onDidChangeList(list => this._applyList(list)));
		this._register(this.todosService.onDidRemoveList(id => this._removeCard(id)));
		this._register(this.todosService.onDidChange(() => this._reconcile()));

		this._reconcile();
	}

	// -- Reconcile full list set (covers session changes + initial paint) ----

	private _reconcile(): void {
		if (this._container === undefined) {
			return;
		}
		const visible = this.todosService.lists.filter(l => this._shouldRenderInline(l));
		const seen = new Set<string>();
		for (const list of visible) {
			seen.add(list.id);
			this._applyList(list);
		}
		for (const id of [...this._cards.keys()]) {
			if (!seen.has(id)) {
				this._removeCard(id);
			}
		}
	}

	private _shouldRenderInline(list: TodoList): boolean {
		// System-owned lists live only in the editor pane -- the inline
		// surface is for agent-authored work the user should notice.
		if (list.owner === 'system') {
			return false;
		}
		// Artifact lists are rendered by `chatArtifactWidget` instead
		// (plans/artifact-tasks.md section 1.6). The two widgets partition the
		// todos stream so every list shows up exactly once.
		if (isArtifactList(list)) {
			return false;
		}
		return true;
	}

	// -- Card lifecycle ------------------------------------------------------

	private _applyList(list: TodoList): void {
		if (this._container === undefined) {
			return;
		}
		if (!this._shouldRenderInline(list)) {
			this._removeCard(list.id);
			return;
		}
		const existing = this._cards.get(list.id);
		if (existing === undefined) {
			const handles = this._createCard(list);
			this._cards.set(list.id, handles);
			this._container.appendChild(handles.root);
			this._renderCard(list, handles);
			return;
		}
		this._renderCard(list, existing);
	}

	private _createCard(list: TodoList): CardHandles {
		const root = dom.$('.insrc-chat-todos-card', { 'data-list-id': list.id });
		const header = dom.append(root, dom.$('.insrc-chat-todos-card-header'));

		const chevron = dom.append(header, dom.$('span.insrc-chat-todos-chevron'));
		chevron.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown));

		const ownerBadge = dom.append(header, dom.$('span.insrc-chat-todos-owner'));
		ownerBadge.textContent = `[${list.owner}]`;

		const title = dom.append(header, dom.$('span.insrc-chat-todos-title'));
		const meta = dom.append(header, dom.$('span.insrc-chat-todos-meta'));

		const openBtn = dom.append(header, dom.$('button.insrc-chat-todos-open')) as HTMLButtonElement;
		openBtn.textContent = 'Open todos';
		openBtn.title = 'Open the todos pane for this session';
		this._register(dom.addDisposableListener(openBtn, 'click', event => {
			event.stopPropagation();
			void this._openPane(list);
		}));

		const body = dom.append(root, dom.$('.insrc-chat-todos-card-body'));
		const parent = dom.append(body, dom.$('.insrc-chat-todos-parent'));
		const items = dom.append(body, dom.$('.insrc-chat-todos-items'));
		const children = dom.append(body, dom.$('.insrc-chat-todos-children'));

		const handles: CardHandles = {
			root, title, meta, chevron, parent, items, children,
			collapsed: false,
			userToggled: false,
		};

		this._register(dom.addDisposableListener(header, 'click', () => this._toggle(list.id, handles)));

		return handles;
	}

	private _renderCard(list: TodoList, handles: CardHandles): void {
		handles.title.textContent = list.title;
		handles.meta.textContent = this._metaText(list);

		// Parent cross-reference.
		dom.clearNode(handles.parent);
		if (list.parentListId !== undefined && list.parentListId.length > 0) {
			const parentList = this.todosService.lists.find(l => l.id === list.parentListId);
			const row = dom.append(handles.parent, dom.$('span'));
			row.textContent = parentList
				? `↑ parent: ${parentList.title}`
				: `↑ parent: (missing)`;
			if (parentList) {
				row.classList.add('insrc-chat-todos-parent-link');
				this._register(dom.addDisposableListener(row, 'click', e => {
					e.stopPropagation();
					this._scrollToCard(parentList.id);
				}));
			}
		}

		// Items.
		dom.clearNode(handles.items);
		for (const item of list.items) {
			handles.items.appendChild(this._renderItemRow(item));
		}

		// Children cross-references.
		dom.clearNode(handles.children);
		const children = this.todosService.lists.filter(l => l.parentListId === list.id);
		if (children.length > 0) {
			const label = dom.append(handles.children, dom.$('span'));
			label.textContent = `↓ children (${children.length}): `;
			children.forEach((child, idx) => {
				const link = dom.append(handles.children, dom.$('a.insrc-chat-todos-child-link'));
				link.textContent = child.title;
				this._register(dom.addDisposableListener(link, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					this._scrollToCard(child.id);
				}));
				if (idx < children.length - 1) {
					dom.append(handles.children, document.createTextNode(' · '));
				}
			});
		}

		// Owner/status classes for CSS hooks.
		handles.root.className = 'insrc-chat-todos-card';
		handles.root.classList.add(`owner-${list.owner}`);
		handles.root.classList.add(`status-${list.status}`);

		// Auto-collapse behaviour: when the list flips to `completed`,
		// collapse the card unless the user has explicitly expanded it.
		if (!handles.userToggled && list.status === 'completed' && !handles.collapsed) {
			handles.collapsed = true;
			this._applyCollapse(handles);
		}
	}

	private _renderItemRow(item: TodoItem): HTMLElement {
		const row = dom.$('.insrc-chat-todos-item', { 'data-item-id': item.id });
		row.classList.add(`item-status-${item.status}`);
		const icon = dom.append(row, dom.$('span.insrc-chat-todos-item-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(iconForItemStatus(item.status)));
		const title = dom.append(row, dom.$('span.insrc-chat-todos-item-title'));
		title.textContent = item.title;
		if (item.status === 'blocked' && item.blockedReason !== undefined && item.blockedReason.length > 0) {
			const reason = dom.append(row, dom.$('span.insrc-chat-todos-item-reason'));
			reason.textContent = item.blockedReason;
		}
		// Comment count (Phase 5d). Jumps the user to the full editor
		// pane when clicked -- inline comment editing lives there.
		const comments = item.comments ?? [];
		if (comments.length > 0) {
			const badge = dom.append(row, dom.$('span.insrc-chat-todos-item-comments'));
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
		return row;
	}

	private _metaText(list: TodoList): string {
		return formatListMeta(list);
	}

	private _toggle(_listId: string, handles: CardHandles): void {
		handles.collapsed = !handles.collapsed;
		handles.userToggled = true;
		this._applyCollapse(handles);
	}

	private _applyCollapse(handles: CardHandles): void {
		if (handles.collapsed) {
			handles.root.classList.add('collapsed');
			handles.chevron.classList.remove(...ThemeIcon.asClassNameArray(Codicon.chevronDown));
			handles.chevron.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronRight));
		} else {
			handles.root.classList.remove('collapsed');
			handles.chevron.classList.remove(...ThemeIcon.asClassNameArray(Codicon.chevronRight));
			handles.chevron.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown));
		}
	}

	private _removeCard(listId: string): void {
		const card = this._cards.get(listId);
		if (card === undefined) {
			return;
		}
		card.root.remove();
		this._cards.delete(listId);
	}

	private _scrollToCard(listId: string): void {
		const card = this._cards.get(listId);
		if (card === undefined) {
			// Not rendered inline (system-owned or not yet seen). Fall back
			// to opening the full pane; the user can navigate from there.
			const list = this.todosService.lists.find(l => l.id === listId);
			if (list !== undefined) {
				void this._openPane(list);
			}
			return;
		}
		if (card.collapsed) {
			card.collapsed = false;
			card.userToggled = true;
			this._applyCollapse(card);
		}
		card.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	private async _openPane(list: TodoList): Promise<void> {
		try {
			await this.editorService.openEditor(new TodosEditorInput(list.sessionId));
		} catch (err) {
			this.logService.warn(`[insrc-chat-todos] openPane failed: ${(err as Error).message}`);
		}
	}

	override dispose(): void {
		for (const card of this._cards.values()) {
			card.root.remove();
		}
		this._cards.clear();
		this._container = undefined;
		super.dispose();
	}
}
