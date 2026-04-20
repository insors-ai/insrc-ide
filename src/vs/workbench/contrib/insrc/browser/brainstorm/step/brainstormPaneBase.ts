/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/brainstorm.css';
import * as dom from '../../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { IEditorOpenContext } from '../../../../../common/editor.js';
import type { IEditorGroup } from '../../../../../services/editor/common/editorGroupsService.js';
import { EditorPane } from '../../../../../browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { IEditorOptions } from '../../../../../../platform/editor/common/editor.js';
import { IInsrcChatService } from '../../../common/chatService.js';
import {
	IInsrcBrainstormSessionService,
	type BrainstormGateKind,
	type BrainstormGateSnapshot,
} from '../../../common/brainstormSessionService.js';
import type { BrainstormStepInputBase } from './brainstormStepInput.js';

/**
 * Shared skeleton for every per-gate brainstorm pane. Handles the header
 * (title + category badge + progress readout), the scrollable card area,
 * and the wiring that re-renders the content whenever a matching gate
 * arrives. Subclasses override `_paneTitle` and `_renderGate`.
 */
export abstract class BrainstormPaneBase extends EditorPane {
	protected _container!: HTMLElement;
	protected _headerCategory!: HTMLElement;
	protected _headerProgress!: HTMLElement;
	protected _cardArea!: HTMLElement;
	protected _emptyState!: HTMLElement;
	private _headerRight!: HTMLElement;

	constructor(
		id: string,
		group: IEditorGroup,
		telemetryService: ITelemetryService,
		themeService: IThemeService,
		storageService: IStorageService,
		protected readonly chatService: IInsrcChatService,
		protected readonly sessionService: IInsrcBrainstormSessionService,
	) {
		super(id, group, telemetryService, themeService, storageService);
	}

	/** Short label shown in the header. */
	protected abstract get _paneTitle(): string;
	/** Which gate kind this pane renders. */
	protected abstract get _gateKind(): BrainstormGateKind;
	/** Subclass renders its content into `_cardArea` from the live gate. */
	protected abstract _renderGate(gate: BrainstormGateSnapshot): void;

	protected createEditor(parent: HTMLElement): void {
		this._container = dom.append(parent, dom.$('.insrc-brainstorm'));

		// Header
		const header = dom.append(this._container, dom.$('.insrc-brainstorm-header'));
		const headerLeft = dom.append(header, dom.$('.insrc-brainstorm-header-left'));
		const iconEl = dom.append(headerLeft, dom.$('.insrc-brainstorm-header-icon'));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.lightbulb));
		const titleEl = dom.append(headerLeft, dom.$('h2.insrc-brainstorm-title'));
		titleEl.textContent = this._paneTitle;
		this._headerCategory = dom.append(headerLeft, dom.$('span.insrc-brainstorm-category'));
		this._headerCategory.textContent = this.sessionService.category ?? '';
		this._headerProgress = dom.append(headerLeft, dom.$('span.insrc-brainstorm-phase'));
		this._headerProgress.textContent = '';
		this._headerRight = dom.append(header, dom.$('.insrc-brainstorm-header-right'));

		// Card area
		const main = dom.append(this._container, dom.$('.insrc-brainstorm-main'));
		this._cardArea = dom.append(main, dom.$('.insrc-brainstorm-card-area'));
		this._emptyState = dom.append(this._cardArea, dom.$('.insrc-brainstorm-empty'));
		this._emptyState.textContent = `Waiting for ${this._paneTitle.toLowerCase()}...`;

		this._register(this.sessionService.onDidChangeActiveGate(gate => {
			if (gate.kind === this._gateKind) {
				this._safeRender(gate);
			}
		}));
		this._register(this.sessionService.onDidChange(() => {
			this._headerCategory.textContent = this.sessionService.category ?? '';
		}));

		this._onCreate(this._headerRight);
	}

	/** Override in subclasses to add extra header-right content (buttons etc). */
	protected _onCreate(_headerRight: HTMLElement): void { /* no-op */ }

	override async setInput(input: BrainstormStepInputBase, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		const gate = this.sessionService.activeGate;
		if (gate && gate.kind === this._gateKind) {
			this._safeRender(gate);
		}
	}

	layout(dimension: dom.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}

	private _safeRender(gate: BrainstormGateSnapshot): void {
		this._emptyState.classList.add('hidden');
		this._renderProgress(gate);
		this._renderGate(gate);
	}

	protected _renderProgress(gate: BrainstormGateSnapshot): void {
		const p = gate.progress;
		if (!p) {
			this._headerProgress.textContent = '';
			return;
		}
		const parts: string[] = [];
		if (typeof p['current'] === 'number' && typeof p['total'] === 'number' && p['total'] > 0) {
			parts.push(`${p['current']}/${p['total']}`);
		}
		for (const key of ['approved', 'rejected', 'parked', 'skipped', 'pending', 'remaining']) {
			if (typeof p[key] === 'number') {
				parts.push(`${key} ${p[key]}`);
			}
		}
		this._headerProgress.textContent = parts.join(' | ');
	}
}
