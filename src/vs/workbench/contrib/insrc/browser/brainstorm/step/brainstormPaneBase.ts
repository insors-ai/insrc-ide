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
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IInsrcChatService } from '../../../common/chatService.js';
import {
	IInsrcBrainstormSessionService,
	type BrainstormGateKind,
	type BrainstormGateSnapshot,
} from '../../../common/brainstormSessionService.js';
import type { BrainstormStepInputBase } from './brainstormStepInput.js';
import { attachRedirectAction } from './redirectAction.js';

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
		protected readonly logService: ILogService,
	) {
		super(id, group, telemetryService, themeService, storageService);
		this.logService.info(`[brainstorm:pane:${id}] constructed`);
	}

	private get _logTag(): string { return `brainstorm:pane:${this._gateKind}`; }

	/** Short label shown in the header. */
	protected abstract get _paneTitle(): string;
	/** Which gate kind this pane renders. */
	protected abstract get _gateKind(): BrainstormGateKind;
	/** Subclass renders its content into `_cardArea` from the live gate. */
	protected abstract _renderGate(gate: BrainstormGateSnapshot): void;

	protected createEditor(parent: HTMLElement): void {
		this.logService.info(`[${this._logTag}] createEditor`);
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

		// Item 6: Redirect action. Every brainstorm pane gets a small header
		// button that lets the user re-classify the current turn. Clicking
		// opens an inline picker (intent dropdown + optional refinement
		// textarea); submit calls chatService.redirect() which cancels the
		// stream and re-sends with the override.
		this._renderRedirectAction();

		// Card area
		const main = dom.append(this._container, dom.$('.insrc-brainstorm-main'));
		this._cardArea = dom.append(main, dom.$('.insrc-brainstorm-card-area'));
		this._emptyState = dom.append(this._cardArea, dom.$('.insrc-brainstorm-empty'));
		this._emptyState.textContent = `Waiting for ${this._paneTitle.toLowerCase()}...`;

		this._register(this.sessionService.onDidChangeActiveGate(gate => {
			this.logService.info(`[${this._logTag}] onDidChangeActiveGate kind=${gate.kind} matches=${gate.kind === this._gateKind}`);
			if (gate.kind === this._gateKind) {
				this._safeRender(gate);
			}
		}));
		this._register(this.sessionService.onDidChange(() => {
			this._headerCategory.textContent = this.sessionService.category ?? '';
		}));

		this._onCreate(this._headerRight);
	}

	private _renderRedirectAction(): void {
		this._register(attachRedirectAction(this._container, this._headerRight, {
			chatService: this.chatService,
			sessionService: this.sessionService,
			logService: this.logService,
			logTag: this._logTag,
		}));
	}

	/** Override in subclasses to add extra header-right content (buttons etc). */
	protected _onCreate(_headerRight: HTMLElement): void { /* no-op */ }

	override async setInput(input: BrainstormStepInputBase, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		this.logService.info(`[${this._logTag}] setInput sessionId=${input.sessionId}`);
		await super.setInput(input, options, context, token);
		const gate = this.sessionService.activeGate;
		this.logService.info(`[${this._logTag}] setInput: activeGate kind=${gate?.kind ?? '(none)'} -- will ${gate?.kind === this._gateKind ? 'render' : 'wait'}`);
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
		this.logService.info(`[${this._logTag}] _safeRender gateId=${gate.gateId} actions=[${gate.actions.join(',')}]`);
		this._emptyState.classList.add('hidden');
		this._renderProgress(gate);
		this._renderGate(gate);
		// Item 11: surface any gate-level warning above the content. The
		// card widget already does this for idea/idea-discussion panes; the
		// downstream panes (convergence-review / theme-spec / presentation)
		// render their own content so they rely on this base-class helper.
		this._renderGateWarning(gate);
	}

	/**
	 * Render the gate-level warning strip (Item 3 + Item 11). Default
	 * implementation prepends an amber strip to the card area. Subclasses
	 * whose own `_renderGate` embeds the warning (e.g. panes that delegate
	 * to `BrainstormCardWidget`, which handles warnings internally) can
	 * override this to a no-op to avoid double-rendering.
	 */
	protected _renderGateWarning(gate: BrainstormGateSnapshot): void {
		if (!gate.warning) { return; }
		const strip = dom.prepend(this._cardArea, dom.$('.insrc-brainstorm-card-warning'));
		const icon = dom.append(strip, dom.$('span.codicon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.warning));
		const text = dom.append(strip, dom.$('span.insrc-brainstorm-card-warning-text'));
		text.textContent = gate.warning;
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
