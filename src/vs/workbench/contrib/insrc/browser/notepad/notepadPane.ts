/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/notepadTodos.css';
import './media/notepad.css';
import * as dom from '../../../../../base/browser/dom.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
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
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { CodeEditorWidget, type ICodeEditorWidgetOptions } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import type { IEditorOptions as IMonacoEditorOptions } from '../../../../../editor/common/config/editorOptions.js';
import { IInsrcChatService } from '../../common/chatService.js';
import {
	IInsrcTodosService,
	type TodoItem,
	type TodoList,
	type TodoOwner,
} from '../../common/todosService.js';
import { NotepadEditorInput } from './notepadInput.js';
import { PromptNotepadProvider } from './promptNotepadProvider.js';
import {
	FORWARD_TARGET_FAMILIES, formatListMeta, iconForItemStatus, nextStatus,
} from '../shared/todosViewHelpers.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACTIVE_TAB_KEY_PREFIX = 'insrc.notepad.activeTab:';

type Tab = 'draft' | 'todos';

// ---------------------------------------------------------------------------
// NotepadEditorPane
// ---------------------------------------------------------------------------

/**
 * Unified prompt notepad pane (plans/todo-framework.md Phase 9 follow-up).
 *
 * One pane, two tabs:
 * - **Draft**: Monaco markdown editor backed by the existing
 *   PromptNotepadProvider text model.
 * - **TODOs**: structured user-owned TODO lists scoped to the active
 *   chat session, mutated through IInsrcTodosService.
 *
 * Header carries the tab toggle, an `+ Add TODO` button (active only in
 * the TODOs tab; switches to TODOs and creates a list+item if no list
 * exists yet), and the notepad title. The previous standalone "My TODOs"
 * pane is retired in favour of this unified surface.
 */
export class NotepadEditorPane extends EditorPane {
	static readonly ID = 'insrc.notepadPane';

	private _container!: HTMLElement;
	private _draftBody!: HTMLElement;
	private _todosBody!: HTMLElement;
	private _editorContainer!: HTMLElement;
	private _todosListsArea!: HTMLElement;
	private _todosEmpty!: HTMLElement;
	private _draftTabBtn!: HTMLButtonElement;
	private _todosTabBtn!: HTMLButtonElement;
	private _addTodoBtn!: HTMLButtonElement;

	private _codeEditor: CodeEditorWidget | undefined;
	private _activeTab: Tab = 'draft';
	private _notepadId: string | undefined;
	private _provider: PromptNotepadProvider | undefined;

	private _serviceListeners: IDisposable[] = [];
	private _selectedItemIds = new Map<string, Set<string>>();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly _storage: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IInsrcTodosService private readonly todosService: IInsrcTodosService,
		@IInsrcChatService private readonly chatService: IInsrcChatService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super(NotepadEditorPane.ID, group, telemetryService, themeService, _storage);
	}

	/** PromptNotepadProvider is registered late by the contribution; the
	 *  open-command sets it on this pane class so we can construct the
	 *  Monaco editor without circular DI. */
	private static _providerStatic: PromptNotepadProvider | undefined;
	static setProvider(p: PromptNotepadProvider): void {
		NotepadEditorPane._providerStatic = p;
	}

	protected createEditor(parent: HTMLElement): void {
		this._provider = NotepadEditorPane._providerStatic;
		this._container = dom.append(parent, dom.$('.insrc-notepad'));

		// Header
		const header = dom.append(this._container, dom.$('.insrc-notepad-header'));
		const headerLeft = dom.append(header, dom.$('.insrc-notepad-header-left'));
		const titleEl = dom.append(headerLeft, dom.$('h2.insrc-notepad-title'));
		titleEl.textContent = 'Prompt Notepad';

		const tabs = dom.append(header, dom.$('.insrc-notepad-tabs'));
		this._draftTabBtn = dom.append(tabs, dom.$('button.insrc-notepad-tab')) as HTMLButtonElement;
		this._draftTabBtn.textContent = 'Draft';
		this._draftTabBtn.addEventListener('click', () => this._switchTab('draft'));

		this._todosTabBtn = dom.append(tabs, dom.$('button.insrc-notepad-tab')) as HTMLButtonElement;
		this._todosTabBtn.textContent = 'TODOs';
		this._todosTabBtn.addEventListener('click', () => this._switchTab('todos'));

		const headerRight = dom.append(header, dom.$('.insrc-notepad-header-right'));
		this._addTodoBtn = dom.append(headerRight, dom.$('button.insrc-notepad-add-todo')) as HTMLButtonElement;
		this._addTodoBtn.textContent = '+ Add TODO';
		this._addTodoBtn.title = 'Switch to the TODOs tab and start a new list (or add an item to the first existing list).';
		this._addTodoBtn.addEventListener('click', () => void this._addTodoQuick());

		// Body -- one container per tab; only the active one is visible.
		const main = dom.append(this._container, dom.$('.insrc-notepad-main'));

		this._draftBody = dom.append(main, dom.$('.insrc-notepad-draft-body'));
		this._editorContainer = dom.append(this._draftBody, dom.$('.insrc-notepad-editor-container'));
		this._draftBody.style.display = 'block';

		this._todosBody = dom.append(main, dom.$('.insrc-notepad-todos-body'));
		this._todosListsArea = dom.append(this._todosBody, dom.$('.insrc-notepad-todos-lists'));
		this._todosEmpty = dom.append(this._todosBody, dom.$('.insrc-notepad-todos-empty'));
		this._todosEmpty.textContent = 'No TODO lists yet for this session. Click "+ Add TODO" to start one.';
		this._todosBody.style.display = 'none';

		// Construct the Monaco editor for the Draft tab.
		this._buildCodeEditor();
		this._refreshTabClasses();
	}

	private _buildCodeEditor(): void {
		const editorOptions: IMonacoEditorOptions = {
			fontFamily: 'var(--monaco-monospace-font, monospace)',
			lineNumbers: 'off',
			folding: false,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			renderLineHighlight: 'none',
			wordWrap: 'on',
			automaticLayout: true,
			glyphMargin: false,
		};
		const widgetOptions: ICodeEditorWidgetOptions = {
			isSimpleWidget: false,
		};
		this._codeEditor = this.instantiationService.createInstance(
			CodeEditorWidget,
			this._editorContainer,
			editorOptions,
			widgetOptions,
		);
	}

	override async setInput(
		input: NotepadEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		this._notepadId = input.notepadId;

		// Attach the existing PromptNotepadProvider's text model to the
		// embedded Monaco editor.
		if (this._provider !== undefined && this._codeEditor !== undefined) {
			const { model } = this._provider.getOrCreateModel(input.notepadId);
			this._codeEditor.setModel(model);
		}

		// Wire TODOs subscription + initial render.
		this._detachServiceListeners();
		this._serviceListeners.push(
			this.todosService.onDidChange(() => this._renderTodos()),
			this.todosService.onDidChangeList(list => this._onListChanged(list)),
			this.todosService.onDidRemoveList(id => this._onListRemoved(id)),
			this.chatService.onDidChangeSession(() => {
				this._selectedItemIds.clear();
				this._renderTodos();
			}),
		);

		// Restore the previously-active tab for this notepad.
		const stored = this._storage.get(ACTIVE_TAB_KEY_PREFIX + input.notepadId, StorageScope.PROFILE);
		if (stored === 'todos' || stored === 'draft') {
			this._activeTab = stored;
		}
		this._refreshTabClasses();
		this._renderTodos();
	}

	override clearInput(): void {
		this._detachServiceListeners();
		this._notepadId = undefined;
		this._selectedItemIds.clear();
		if (this._codeEditor !== undefined) {
			this._codeEditor.setModel(null);
		}
		super.clearInput();
	}

	layout(dimension: dom.Dimension): void {
		if (this._container !== undefined) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
		this._codeEditor?.layout();
	}

	override dispose(): void {
		this._detachServiceListeners();
		if (this._codeEditor !== undefined) {
			this._codeEditor.dispose();
			this._codeEditor = undefined;
		}
		super.dispose();
	}

	// -- Tab management -----------------------------------------------------

	private _switchTab(tab: Tab): void {
		if (this._activeTab === tab) {
			return;
		}
		this._activeTab = tab;
		this._refreshTabClasses();
		if (this._notepadId !== undefined) {
			this._storage.store(
				ACTIVE_TAB_KEY_PREFIX + this._notepadId, tab,
				StorageScope.PROFILE, StorageTarget.USER,
			);
		}
		if (tab === 'draft' && this._codeEditor !== undefined) {
			// Force a layout pass once visible so Monaco picks up the
			// container dimensions.
			queueMicrotask(() => this._codeEditor?.layout());
		}
	}

	private _refreshTabClasses(): void {
		this._draftTabBtn.classList.toggle('active', this._activeTab === 'draft');
		this._todosTabBtn.classList.toggle('active', this._activeTab === 'todos');
		this._draftBody.style.display = this._activeTab === 'draft' ? 'block' : 'none';
		this._todosBody.style.display = this._activeTab === 'todos' ? 'block' : 'none';
	}

	// -- Quick-add affordance -----------------------------------------------

	private async _addTodoQuick(): Promise<void> {
		// Always switch to TODOs tab so the user sees the result.
		this._switchTab('todos');
		const sessionId = this.chatService.activeSessionId;
		if (sessionId === undefined) {
			this.notificationService.info('Start a chat session first -- user TODOs are session-scoped.');
			return;
		}
		const lists = this._userLists();
		try {
			let listId: string;
			if (lists.length === 0) {
				const list = await this.todosService.createUserList({ sessionId, title: 'TODOs' });
				listId = list.id;
			} else {
				listId = lists[0]!.id;
			}
			await this.todosService.addItem(listId, { title: 'New TODO' });
		} catch (err) {
			this.notificationService.error(`Failed to add TODO: ${(err as Error).message}`);
		}
	}

	// -- TODOs rendering (lifted from the standalone NotepadTodosEditorPane) -

	private _renderTodos(): void {
		if (this._todosListsArea === undefined) {
			return;
		}
		const lists = this._userLists();
		dom.clearNode(this._todosListsArea);
		if (lists.length === 0) {
			this._todosEmpty.classList.remove('hidden');
			return;
		}
		this._todosEmpty.classList.add('hidden');
		for (const list of lists) {
			this._todosListsArea.appendChild(this._renderListCard(list));
		}
	}

	private _userLists(): readonly TodoList[] {
		const sessionId = this.chatService.activeSessionId;
		if (sessionId === undefined) {
			return [];
		}
		return this.todosService.lists.filter(
			list => list.sessionId === sessionId && list.owner === 'user',
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

		const body = dom.append(card, dom.$('.insrc-notepad-todos-card-body'));
		const itemsWrap = dom.append(body, dom.$('.insrc-notepad-todos-items'));
		for (const item of list.items) {
			itemsWrap.appendChild(this._renderItemRow(list, item));
		}

		const addBtn = dom.append(body, dom.$('button.insrc-notepad-todos-add-item')) as HTMLButtonElement;
		addBtn.textContent = '+ Add item';
		addBtn.addEventListener('click', () => {
			void this._call(() => this.todosService.addItem(list.id, { title: 'New item' }));
		});

		// Forward toolbar
		const toolbar = dom.append(card, dom.$('.insrc-notepad-todos-card-toolbar'));
		const targetSelect = dom.append(toolbar, dom.$('select.insrc-notepad-todos-target-select')) as HTMLSelectElement;
		for (const family of FORWARD_TARGET_FAMILIES) {
			const opt = document.createElement('option');
			opt.value = family as string;
			opt.textContent = family as string;
			targetSelect.appendChild(opt);
		}

		const forwardBtn = dom.append(toolbar, dom.$('button.insrc-notepad-todos-forward-selected')) as HTMLButtonElement;
		forwardBtn.textContent = 'Forward selected';
		forwardBtn.title = 'Send the selected items to the chosen agent as snapshots (withTodo). Items stay here; statuses update on response.';
		forwardBtn.disabled = (this._selectedItemIds.get(list.id)?.size ?? 0) === 0;
		forwardBtn.addEventListener('click', () => {
			void this._forwardSelected(list, targetSelect.value as TodoOwner);
		});

		const forwardAllBtn = dom.append(toolbar, dom.$('button.insrc-notepad-todos-forward-all')) as HTMLButtonElement;
		forwardAllBtn.textContent = 'Forward all';
		forwardAllBtn.title = 'Send every non-terminal item to the chosen agent.';
		forwardAllBtn.disabled = list.items.every(it => it.status === 'completed' || it.status === 'cancelled');
		forwardAllBtn.addEventListener('click', () => {
			void this._forwardAll(list, targetSelect.value as TodoOwner);
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
			this._renderTodos();
		});

		const icon = dom.append(row, dom.$('span.insrc-notepad-todos-item-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(iconForItemStatus(item.status)));
		icon.title = `${item.status} - click to cycle`;
		icon.addEventListener('click', () => {
			void this._call(() => this.todosService.updateItem(item.id, { status: nextStatus(item.status) }));
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
		return formatListMeta(list);
	}

	// -- Forwarding (withTodo) ----------------------------------------------

	private async _forwardSelected(list: TodoList, target: TodoOwner): Promise<void> {
		const selectedIds = this._selectedItemIds.get(list.id);
		if (selectedIds === undefined || selectedIds.size === 0) {
			return;
		}
		const items = list.items.filter(it => selectedIds.has(it.id));
		await this._forwardItems(list, items, target);
		this._selectedItemIds.set(list.id, new Set());
	}

	private async _forwardAll(list: TodoList, target: TodoOwner): Promise<void> {
		const items = list.items.filter(it => it.status !== 'completed' && it.status !== 'cancelled');
		await this._forwardItems(list, items, target);
	}

	private async _forwardItems(list: TodoList, items: readonly TodoItem[], target: TodoOwner): Promise<void> {
		const sessionId = this.chatService.activeSessionId;
		if (sessionId === undefined || items.length === 0) {
			return;
		}
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
				sessionId,
				items: snapshots,
			});
			for (const resp of result.items) {
				const patch: { status: typeof resp.status; blockedReason?: string } = { status: resp.status };
				if (resp.blockedReason !== undefined) {
					patch.blockedReason = resp.blockedReason;
				}
				try {
					await this.todosService.updateItem(resp.sourceRef, patch);
				} catch (err) {
					this.logService.warn(`[notepad] failed to apply response status for ${resp.sourceRef}: ${(err as Error).message}`);
				}
			}
			this.notificationService.info(`Forwarded ${items.length} item(s) to ${target}. Items stay in your list; statuses update from the agent's response.`);
		} catch (err) {
			this.notificationService.error(`Failed to forward: ${(err as Error).message}`);
		}
	}

	// -- Service event handlers ---------------------------------------------

	private _onListChanged(list: TodoList): void {
		const sessionId = this.chatService.activeSessionId;
		if (sessionId === undefined || list.sessionId !== sessionId) {
			return;
		}
		// List left user ownership (transferred out) or arrived as user-owned: re-render.
		this._renderTodos();
	}

	private _onListRemoved(listId: string): void {
		this._selectedItemIds.delete(listId);
		this._renderTodos();
	}

	private async _call<T>(op: () => Promise<T>): Promise<T | undefined> {
		try {
			return await op();
		} catch (err) {
			this.notificationService.error(`Notepad TODO op failed: ${(err as Error).message}`);
			this.logService.warn(`[notepad] op failed: ${(err as Error).message}`);
			return undefined;
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
