/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatArtifacts.css';
import * as dom from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import {
	IInsrcTodosService,
	type TodoItem,
	type TodoList,
} from '../../common/todosService.js';
import {
	isArtifactItem,
	isArtifactItemMeta,
	isArtifactList,
	type ArtifactItemMeta,
	type ArtifactKind,
} from '../../common/insrcArtifacts.js';

/**
 * Inline chat widget for artifact items (plans/artifact-tasks.md section 1.6).
 *
 * Renders each artifact item as a standalone card in the chat
 * transcript. The rendered HTML (Mermaid or inline SVG) lives inside
 * a sandboxed `<iframe srcdoc=…>` so the artifact's own
 * `<script>`-based renderer (Mermaid CDN, SRI-pinned via the
 * daemon's `mermaid-cdn.json`) runs in an isolated document without
 * touching the workbench main window.
 *
 * Subscribes directly to `IInsrcTodosService`; artifacts ride the
 * same todos stream as regular items (we identify them by the shape
 * of `item.meta`, see `isArtifactItemMeta`). The companion
 * `chatTodosWidget` skips artifact lists, so the two widgets
 * partition the rendering responsibility cleanly.
 */

interface ArtifactCardHandles {
	readonly root: HTMLElement;
	readonly title: HTMLElement;
	readonly kindBadge: HTMLElement;
	readonly meta: HTMLElement;
	readonly iframe: HTMLIFrameElement;
	/** Last rendered standalone-mode HTML, used to avoid redundant
	 *  `srcdoc` assignments on superficial list-level events that don't
	 *  actually touch the artifact payload. */
	lastHtml: string;
}

const KIND_LABELS: Readonly<Record<ArtifactKind, string>> = {
	er: 'ER',
	sequence: 'Sequence',
	flow: 'Flow',
	deployment: 'Deployment',
	wireframe: 'Wireframe',
};

export class ChatArtifactWidget extends Disposable {

	private _container: HTMLElement | undefined;
	private readonly _cards = new Map<string, ArtifactCardHandles>();

	constructor(
		private readonly todosService: IInsrcTodosService,
		private readonly clipboardService: IClipboardService,
		private readonly logService: ILogService,
	) {
		super();
	}

	/** Mount the widget into `parent`. Subsequent calls are a no-op. */
	mount(parent: HTMLElement): void {
		if (this._container !== undefined) {
			return;
		}
		this._container = dom.append(parent, dom.$('.insrc-chat-artifacts'));

		this._register(this.todosService.onDidChangeList(list => this._applyList(list)));
		this._register(this.todosService.onDidRemoveList(id => this._removeList(id)));
		this._register(this.todosService.onDidChange(() => this._reconcile()));

		this._reconcile();
	}

	// -- Reconcile full list set --------------------------------------------

	private _reconcile(): void {
		if (this._container === undefined) {
			return;
		}
		const seenItemIds = new Set<string>();
		for (const list of this.todosService.lists) {
			if (!isArtifactList(list)) {
				continue;
			}
			for (const item of list.items) {
				if (!isArtifactItem(item)) {
					continue;
				}
				seenItemIds.add(item.id);
				this._applyItem(list, item);
			}
		}
		for (const id of [...this._cards.keys()]) {
			if (!seenItemIds.has(id)) {
				this._removeCard(id);
			}
		}
	}

	private _applyList(list: TodoList): void {
		if (this._container === undefined) {
			return;
		}
		if (!isArtifactList(list)) {
			// A non-artifact list we previously mis-identified? Clean up.
			for (const item of list.items) {
				this._removeCard(item.id);
			}
			return;
		}
		const currentIds = new Set<string>();
		for (const item of list.items) {
			if (isArtifactItem(item)) {
				currentIds.add(item.id);
				this._applyItem(list, item);
			}
		}
		// Drop cards for items that no longer appear on this list.
		for (const [itemId, card] of this._cards) {
			if (card.root.getAttribute('data-list-id') === list.id && !currentIds.has(itemId)) {
				this._removeCard(itemId);
			}
		}
	}

	private _removeList(listId: string): void {
		for (const [itemId, card] of this._cards) {
			if (card.root.getAttribute('data-list-id') === listId) {
				this._removeCard(itemId);
			}
		}
	}

	// -- Per-item card lifecycle --------------------------------------------

	private _applyItem(list: TodoList, item: TodoItem): void {
		if (this._container === undefined) {
			return;
		}
		if (!isArtifactItemMeta(item.meta)) {
			// Defensive: skip items on an artifact list whose meta doesn't
			// match. Should be impossible but we'd rather miss a render
			// than throw inside the event handler.
			return;
		}
		const meta: ArtifactItemMeta = item.meta;
		const existing = this._cards.get(item.id);
		if (existing === undefined) {
			const handles = this._createCard(list.id, item, meta);
			this._cards.set(item.id, handles);
			this._container.appendChild(handles.root);
			this._renderCard(item, meta, handles);
			return;
		}
		this._renderCard(item, meta, existing);
	}

	private _createCard(listId: string, item: TodoItem, meta: ArtifactItemMeta): ArtifactCardHandles {
		const root = dom.$('.insrc-chat-artifact-card', {
			'data-list-id': listId,
			'data-item-id': item.id,
			'data-artifact-kind': meta.kind,
		});
		const header = dom.append(root, dom.$('.insrc-chat-artifact-header'));
		const kindBadge = dom.append(header, dom.$('span.insrc-chat-artifact-kind'));
		kindBadge.textContent = KIND_LABELS[meta.kind];
		const title = dom.append(header, dom.$('span.insrc-chat-artifact-title'));
		const meta_ = dom.append(header, dom.$('span.insrc-chat-artifact-meta'));

		const actions = dom.append(header, dom.$('.insrc-chat-artifact-actions'));
		const copyBtn = dom.append(actions, dom.$('button.insrc-chat-artifact-action')) as HTMLButtonElement;
		copyBtn.textContent = 'Copy snippet';
		copyBtn.title = 'Copy the standalone HTML snippet to the clipboard';
		this._register(dom.addDisposableListener(copyBtn, 'click', event => {
			event.stopPropagation();
			void this._copyStandalone(item.id);
		}));

		const body = dom.append(root, dom.$('.insrc-chat-artifact-body'));
		const iframe = dom.append(body, dom.$('iframe.insrc-chat-artifact-iframe')) as HTMLIFrameElement;
		// `allow-scripts` lets Mermaid's runtime execute inside the frame;
		// omitting `allow-same-origin` assigns the iframe a unique origin
		// so it can't touch the main workbench document. `sandbox` plus
		// the binder-side HTML sanitiser form the two layers of
		// containment.
		iframe.setAttribute('sandbox', 'allow-scripts');
		iframe.setAttribute('loading', 'lazy');
		iframe.setAttribute('referrerpolicy', 'no-referrer');
		iframe.setAttribute('title', `${KIND_LABELS[meta.kind]} artifact`);

		const footer = dom.append(root, dom.$('.insrc-chat-artifact-footer'));
		const provenance = dom.append(footer, dom.$('span.insrc-chat-artifact-provenance'));
		const warnings = dom.append(footer, dom.$('span.insrc-chat-artifact-warnings'));
		void provenance;
		void warnings;

		return {
			root, title, kindBadge, meta: meta_, iframe,
			lastHtml: '',
		};
	}

	private _renderCard(item: TodoItem, meta: ArtifactItemMeta, handles: ArtifactCardHandles): void {
		handles.title.textContent = meta.title ?? item.title;
		handles.meta.textContent = this._metaLine(meta);

		if (handles.lastHtml !== meta.renderedHtml.standalone) {
			// `srcdoc` reassignment tears down + rebuilds the iframe
			// document, including the Mermaid script. Worth the churn when
			// the payload genuinely changes (phase-2 regenerate); a no-op
			// when it doesn't.
			handles.iframe.srcdoc = meta.renderedHtml.standalone;
			handles.lastHtml = meta.renderedHtml.standalone;
		}

		// Provenance + warnings footer rows.
		const footer = handles.root.querySelector('.insrc-chat-artifact-footer');
		if (footer !== null) {
			const provenance = footer.querySelector('.insrc-chat-artifact-provenance');
			const warnings = footer.querySelector('.insrc-chat-artifact-warnings');
			if (provenance !== null) {
				provenance.textContent =
					`source: ${meta.metadata['provenance'] ?? 'unknown'} · confidence: ${meta.confidence}`;
			}
			if (warnings !== null) {
				warnings.textContent = meta.warnings.length > 0
					? `${meta.warnings.length} warning${meta.warnings.length === 1 ? '' : 's'}`
					: '';
				warnings.classList.toggle('insrc-chat-artifact-warnings-visible', meta.warnings.length > 0);
				if (meta.warnings.length > 0) {
					warnings.setAttribute('title', meta.warnings.join('\n'));
				} else {
					warnings.removeAttribute('title');
				}
			}
		}
	}

	private _metaLine(meta: ArtifactItemMeta): string {
		const parts: string[] = [];
		const generatedAt = meta.metadata['generatedAt'];
		if (typeof generatedAt === 'string' && generatedAt.length > 0) {
			parts.push(generatedAt);
		}
		return parts.join(' · ');
	}

	private async _copyStandalone(itemId: string): Promise<void> {
		const card = this._cards.get(itemId);
		if (card === undefined) {
			return;
		}
		try {
			await this.clipboardService.writeText(card.lastHtml);
			this.logService.info(`[insrc-chat-artifact] copied standalone snippet for item ${itemId}`);
		} catch (err) {
			this.logService.warn(`[insrc-chat-artifact] copy failed: ${(err as Error).message}`);
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

	override dispose(): void {
		for (const card of this._cards.values()) {
			card.root.remove();
		}
		this._cards.clear();
		this._container = undefined;
		super.dispose();
	}
}
