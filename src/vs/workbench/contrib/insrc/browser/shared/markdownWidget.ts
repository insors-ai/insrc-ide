/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { CodeEditorWidget, type ICodeEditorWidgetOptions } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import type { IEditorOptions as IMonacoEditorOptions } from '../../../../../editor/common/config/editorOptions.js';

/**
 * Shared helper for embedding a Monaco editor tuned for insrc's
 * markdown-drafting surfaces (plans/todo-framework.md Phase 8).
 *
 * The notepad's Draft tab is the only consumer today. Centralising
 * the editor-option defaults here (and the `CodeEditorWidget`
 * construction boilerplate) means a second consumer -- say, a future
 * markdown description editor on the agent todos pane -- inherits the
 * same look + keybindings without duplicating the options block.
 *
 * Defaults are biased for "prose composition" (no line numbers, no
 * folding, no minimap, wrap on, `automaticLayout: true`). Callers
 * can override any option via the `overrides` param.
 */

export interface CreateMarkdownEditorOpts {
	/** Override editor-level options (line numbers, word wrap, etc.). */
	readonly editorOptions?: Readonly<IMonacoEditorOptions>;
	/** Override widget-level options (contributions list, isSimpleWidget). */
	readonly widgetOptions?: Readonly<ICodeEditorWidgetOptions>;
}

/** Default editor options used for insrc markdown-drafting surfaces. */
export const DEFAULT_MARKDOWN_EDITOR_OPTIONS: IMonacoEditorOptions = Object.freeze({
	fontFamily: 'var(--monaco-monospace-font, monospace)',
	lineNumbers: 'off',
	folding: false,
	minimap: { enabled: false },
	scrollBeyondLastLine: false,
	renderLineHighlight: 'none',
	wordWrap: 'on',
	automaticLayout: true,
	glyphMargin: false,
});

const DEFAULT_WIDGET_OPTIONS: ICodeEditorWidgetOptions = Object.freeze({
	isSimpleWidget: false,
});

/**
 * Instantiate a `CodeEditorWidget` pre-configured for markdown
 * drafting. The caller owns the widget's lifetime (call
 * `widget.dispose()` in the hosting pane's dispose path).
 *
 * @param instantiationService - platform DI, used to construct the widget
 * @param container            - DOM element the editor paints into
 * @param opts                 - optional option overrides
 */
export function createMarkdownEditor(
	instantiationService: IInstantiationService,
	container: HTMLElement,
	opts: CreateMarkdownEditorOpts = {},
): CodeEditorWidget {
	const editorOptions: IMonacoEditorOptions = {
		...DEFAULT_MARKDOWN_EDITOR_OPTIONS,
		...(opts.editorOptions ?? {}),
	};
	const widgetOptions: ICodeEditorWidgetOptions = {
		...DEFAULT_WIDGET_OPTIONS,
		...(opts.widgetOptions ?? {}),
	};
	return instantiationService.createInstance(
		CodeEditorWidget,
		container,
		editorOptions,
		widgetOptions,
	);
}
