/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { EditorInput } from '../../../../common/editor/editorInput.js';
import type { IEditorOpenContext } from '../../../../common/editor.js';
import type { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import type { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import type { IStorageService } from '../../../../../platform/storage/common/storage.js';
import type { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import type { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';

/**
 * Shared EditorPane base for insrc workspace surfaces (plans/todo-
 * framework.md Phase 8).
 *
 * Absorbs the setInput / clearInput / dispose / layout lifecycle
 * boilerplate that every insrc pane was hand-rolling: a
 * `_serviceListeners: IDisposable[]` buffer, detach-on-teardown,
 * container size propagation in `layout()`. Subclasses implement
 * `onSetInput(input)` / `onClearInput()` / `onLayout(dim)` hooks
 * and call `registerServiceListener(d)` for any subscription they
 * want torn down on input change / dispose.
 *
 * Chat widgets and non-EditorPane surfaces do **not** extend this
 * class -- they manage their own lifecycle via Disposable. The
 * class is specifically for VS Code editor panes.
 */
export abstract class InsrcEditorPaneBase<TInput extends EditorInput> extends EditorPane {
	protected _container: HTMLElement | undefined;
	private _serviceListeners: IDisposable[] = [];

	constructor(
		id: string,
		group: IEditorGroup,
		telemetryService: ITelemetryService,
		themeService: IThemeService,
		storageService: IStorageService,
	) {
		super(id, group, telemetryService, themeService, storageService);
	}

	/**
	 * Record an IDisposable (usually an event-emitter subscription)
	 * so the base disposes it on clearInput / dispose. Subclasses
	 * push listeners here instead of keeping their own buffer.
	 */
	protected registerServiceListener(d: IDisposable): void {
		this._serviceListeners.push(d);
	}

	/** Hook: called at the end of setInput, after listeners are torn down. */
	protected abstract onSetInput(input: TInput, options: IEditorOptions | undefined): void | Promise<void>;

	/** Hook: called at the start of clearInput, before listeners are torn down. */
	protected onClearInput(): void {
		// no-op default
	}

	/** Hook: called after the container's width/height are set in layout(). */
	protected onLayout(_dimension: dom.Dimension): void {
		// no-op default
	}

	override async setInput(
		input: TInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		this._detachServiceListeners();
		await this.onSetInput(input, options);
	}

	override clearInput(): void {
		try {
			this.onClearInput();
		} finally {
			this._detachServiceListeners();
			super.clearInput();
		}
	}

	override dispose(): void {
		this._detachServiceListeners();
		super.dispose();
	}

	layout(dimension: dom.Dimension): void {
		if (this._container !== undefined) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
		this.onLayout(dimension);
	}

	private _detachServiceListeners(): void {
		for (const d of this._serviceListeners) {
			try {
				d.dispose();
			} catch {
				// ignore -- best-effort teardown
			}
		}
		this._serviceListeners = [];
	}
}
