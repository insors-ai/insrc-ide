/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/artifacts.css';
import * as dom from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IInsrcTodosService, type TodoItem, type TodoList } from '../../common/todosService.js';
import {
	isArtifactItem, isArtifactItemMeta, isArtifactList,
	type ArtifactItemMeta, type ArtifactKind,
} from '../../common/insrcArtifacts.js';
import { ArtifactsEditorInput } from './artifactsInput.js';
import { InsrcEditorPaneBase } from '../shared/workspacePaneBase.js';

// ---------------------------------------------------------------------------
// Labels + shape helpers
// ---------------------------------------------------------------------------

const KIND_LABELS: Readonly<Record<ArtifactKind, string>> = {
	er: 'ER',
	sequence: 'Sequence',
	flow: 'Flow',
	deployment: 'Deployment',
	wireframe: 'Wireframe',
};

interface ArtifactCardHandles {
	readonly root: HTMLElement;
	readonly title: HTMLElement;
	readonly kindBadge: HTMLElement;
	readonly meta: HTMLElement;
	readonly iframe: HTMLIFrameElement;
	readonly provenance: HTMLElement;
	readonly revisions: HTMLElement;
	readonly warnings: HTMLElement;
	lastHtml: string;
}

// ---------------------------------------------------------------------------
// ArtifactsEditorPane
// ---------------------------------------------------------------------------

/**
 * Per-session Artifacts pane
 * (plans/artifact-tasks.md section 2.2). Durable (restored on
 * window reload): lists every artifact TodoItem on the session's
 * `Artifacts` list, rendered into per-card sandboxed iframes.
 *
 * Mutations never happen from the pane. Regeneration flows through
 * the chat surface (NL-only; the LLM calls `artifact:regenerate`);
 * the pane just re-renders when the framework emits `itemUpdated`.
 */
export class ArtifactsEditorPane extends InsrcEditorPaneBase<ArtifactsEditorInput> {
	static readonly ID = 'insrc.artifactsPane';

	private _headerCount!: HTMLElement;
	private _listArea!: HTMLElement;
	private _emptyState!: HTMLElement;

	private _sessionId: string | undefined;
	private readonly _cards = new Map<string, ArtifactCardHandles>();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storage: IStorageService,
		@IInstantiationService _instantiationService: IInstantiationService,
		@IInsrcTodosService private readonly todosService: IInsrcTodosService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super(ArtifactsEditorPane.ID, group, telemetryService, themeService, storage);
	}

	// -- Skeleton -----------------------------------------------------------

	protected createEditor(parent: HTMLElement): void {
		this._container = dom.append(parent, dom.$('.insrc-artifacts'));

		const header = dom.append(this._container, dom.$('.insrc-artifacts-header'));
		const headerLeft = dom.append(header, dom.$('.insrc-artifacts-header-left'));
		const iconEl = dom.append(headerLeft, dom.$('.insrc-artifacts-header-icon'));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.symbolMisc));
		const titleEl = dom.append(headerLeft, dom.$('h2.insrc-artifacts-title'));
		titleEl.textContent = 'Artifacts';
		const subtitle = dom.append(headerLeft, dom.$('span.insrc-artifacts-subtitle'));
		subtitle.textContent = 'durable audit trail';
		this._headerCount = dom.append(header, dom.$('span.insrc-artifacts-count'));
		this._headerCount.textContent = '';

		const main = dom.append(this._container, dom.$('.insrc-artifacts-main'));
		this._listArea = dom.append(main, dom.$('.insrc-artifacts-list'));
		this._emptyState = dom.append(main, dom.$('.insrc-artifacts-empty'));
		this._emptyState.textContent =
			'No artifacts for this session yet. Ask in chat ' +
			'("draw an ER diagram for users and orders") or use the artifact.* tools.';
	}

	// -- Lifecycle ----------------------------------------------------------

	protected override onSetInput(input: ArtifactsEditorInput): void {
		this._sessionId = input.sessionId;
		this.registerServiceListener(this.todosService.onDidChange(() => this._render()));
		this.registerServiceListener(this.todosService.onDidChangeList(list => this._onListChanged(list)));
		this.registerServiceListener(this.todosService.onDidRemoveList(id => this._onListRemoved(id)));
		this._render();
	}

	protected override onClearInput(): void {
		this._sessionId = undefined;
		for (const card of this._cards.values()) {
			card.root.remove();
		}
		this._cards.clear();
	}

	// -- Rendering ----------------------------------------------------------

	private _render(): void {
		if (!this._container || this._sessionId === undefined) {
			return;
		}
		const session = this._sessionId;
		const lists = this.todosService.lists.filter(
			list => list.sessionId === session && isArtifactList(list),
		);
		const items: TodoItem[] = [];
		for (const list of lists) {
			for (const item of list.items) {
				if (isArtifactItem(item)) {
					items.push(item);
				}
			}
		}

		this._headerCount.textContent = items.length === 0
			? ''
			: `${items.length} ${items.length === 1 ? 'artifact' : 'artifacts'}`;

		if (items.length === 0) {
			this._emptyState.classList.remove('hidden');
		} else {
			this._emptyState.classList.add('hidden');
		}

		const seenIds = new Set<string>();
		for (const item of items) {
			seenIds.add(item.id);
			this._applyItem(item);
		}
		for (const id of [...this._cards.keys()]) {
			if (!seenIds.has(id)) {
				this._removeCard(id);
			}
		}
	}

	private _onListChanged(list: TodoList): void {
		if (list.sessionId !== this._sessionId) {
			return;
		}
		if (!isArtifactList(list)) {
			return;
		}
		// Incremental re-render: run a full pass. Lists stay small in
		// practice; no perf concern.
		this._render();
	}

	private _onListRemoved(listId: string): void {
		for (const [itemId, card] of this._cards) {
			if (card.root.getAttribute('data-list-id') === listId) {
				this._removeCard(itemId);
			}
		}
	}

	private _applyItem(item: TodoItem): void {
		if (!this._listArea) {
			return;
		}
		if (!isArtifactItemMeta(item.meta)) {
			return;
		}
		const meta: ArtifactItemMeta = item.meta;
		const existing = this._cards.get(item.id);
		if (existing === undefined) {
			const handles = this._createCard(item, meta);
			this._cards.set(item.id, handles);
			this._listArea.appendChild(handles.root);
			this._renderCard(item, meta, handles);
			return;
		}
		this._renderCard(item, meta, existing);
	}

	private _createCard(item: TodoItem, meta: ArtifactItemMeta): ArtifactCardHandles {
		const listId = this._findListIdForItem(item.id);
		const rootAttrs: Record<string, string> = {
			'data-item-id': item.id,
			'data-artifact-kind': meta.kind,
		};
		if (listId !== undefined) {
			rootAttrs['data-list-id'] = listId;
		}
		const root = dom.$('.insrc-artifacts-card', rootAttrs);
		const header = dom.append(root, dom.$('.insrc-artifacts-card-header'));
		const kindBadge = dom.append(header, dom.$('span.insrc-artifacts-card-kind'));
		kindBadge.textContent = KIND_LABELS[meta.kind];
		const title = dom.append(header, dom.$('span.insrc-artifacts-card-title'));
		const metaLabel = dom.append(header, dom.$('span.insrc-artifacts-card-meta'));

		const actions = dom.append(header, dom.$('.insrc-artifacts-card-actions'));
		const copyBtn = dom.append(actions, dom.$('button.insrc-artifacts-card-action')) as HTMLButtonElement;
		copyBtn.textContent = 'Copy standalone';
		copyBtn.title = 'Copy the standalone HTML snippet to the clipboard';
		this._register(dom.addDisposableListener(copyBtn, 'click', event => {
			event.stopPropagation();
			void this._copyStandalone(item.id);
		}));

		const body = dom.append(root, dom.$('.insrc-artifacts-card-body'));
		const iframe = dom.append(body, dom.$('iframe.insrc-artifacts-card-iframe')) as HTMLIFrameElement;
		iframe.setAttribute('sandbox', 'allow-scripts');
		iframe.setAttribute('loading', 'lazy');
		iframe.setAttribute('referrerpolicy', 'no-referrer');
		iframe.setAttribute('title', `${KIND_LABELS[meta.kind]} artifact`);

		const footer = dom.append(root, dom.$('.insrc-artifacts-card-footer'));
		const provenance = dom.append(footer, dom.$('span.insrc-artifacts-card-provenance'));
		const revisions = dom.append(footer, dom.$('span.insrc-artifacts-card-revisions'));
		const warnings = dom.append(footer, dom.$('span.insrc-artifacts-card-warnings'));

		return {
			root, title, kindBadge, meta: metaLabel, iframe,
			provenance, revisions, warnings,
			lastHtml: '',
		};
	}

	private _renderCard(item: TodoItem, meta: ArtifactItemMeta, handles: ArtifactCardHandles): void {
		handles.title.textContent = meta.title ?? item.title;

		const generatedAt = meta.metadata['generatedAt'] ?? '';
		handles.meta.textContent = generatedAt;

		if (handles.lastHtml !== meta.renderedHtml.standalone) {
			handles.iframe.srcdoc = meta.renderedHtml.standalone;
			handles.lastHtml = meta.renderedHtml.standalone;
		}

		const provenance = meta.metadata['provenance'] ?? 'unknown';
		handles.provenance.textContent =
			`source: ${provenance} / confidence: ${meta.confidence}`;

		const revisions = meta.revisions ?? [];
		const revCount = revisions.length;
		handles.revisions.textContent = revCount > 0
			? `${revCount} revision${revCount === 1 ? '' : 's'}`
			: '';
		handles.revisions.classList.toggle('insrc-artifacts-card-revisions-visible', revCount > 0);
		if (revCount > 0) {
			handles.revisions.setAttribute(
				'title',
				revisions.map(r => `${r.at}: ${r.edits}`).join('\n'),
			);
		} else {
			handles.revisions.removeAttribute('title');
		}

		handles.warnings.textContent = meta.warnings.length > 0
			? `${meta.warnings.length} warning${meta.warnings.length === 1 ? '' : 's'}`
			: '';
		handles.warnings.classList.toggle('insrc-artifacts-card-warnings-visible', meta.warnings.length > 0);
		if (meta.warnings.length > 0) {
			handles.warnings.setAttribute('title', meta.warnings.join('\n'));
		} else {
			handles.warnings.removeAttribute('title');
		}
	}

	// -- Helpers ------------------------------------------------------------

	private _findListIdForItem(itemId: string): string | undefined {
		for (const list of this.todosService.lists) {
			if (!isArtifactList(list) || list.sessionId !== this._sessionId) {
				continue;
			}
			if (list.items.some(i => i.id === itemId)) {
				return list.id;
			}
		}
		return undefined;
	}

	private async _copyStandalone(itemId: string): Promise<void> {
		const card = this._cards.get(itemId);
		if (card === undefined || card.lastHtml === '') {
			return;
		}
		try {
			await this.clipboardService.writeText(card.lastHtml);
			this.notificationService.info('Standalone artifact HTML copied to clipboard.');
		} catch (err) {
			this.logService.warn(`[insrc-artifacts-pane] copy failed: ${(err as Error).message}`);
		}
	}

	private _removeCard(itemId: string): void {
		const card = this._cards.get(itemId);
		if (card === undefined) {
			return;
		}
		card.root.remove();
		this._cards.delete(itemId);
	}
}
