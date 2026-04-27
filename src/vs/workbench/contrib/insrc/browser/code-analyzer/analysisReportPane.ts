/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/analysisReport.css';
import * as dom from '../../../../../base/browser/dom.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { MarkdownRenderer } from '../../../../../editor/browser/widget/markdownRenderer/browser/markdownRenderer.js';
import { IInsrcTodosService, type TodoList } from '../../common/todosService.js';
import { AnalysisReportInput } from './analysisReportInput.js';
import { InsrcEditorPaneBase } from '../shared/workspacePaneBase.js';

/**
 * Code Analyzer Report Pane (plans/analyzers/code-analyzer.md Phase 2.1).
 *
 * Renders the synthesised markdown report for one analysis run. The
 * report content lives in the framework-side TodoList's `body` field
 * -- we render directly from the live service snapshot rather than
 * the backing file so updates land instantly when the orchestrator
 * re-syntheses or appends to the same list. The backing file
 * (`~/.insrc/tmp/code-analysis-report-<listId>.md`, see
 * `EphemeralEditorInput`) is purely a placeholder keeping the URI
 * resolvable.
 *
 * Hard requirement (plan section2.1, memory note `feedback_pane_rendering`):
 * every colour resolves via `var(--vscode-...)` tokens. The
 * `MarkdownRenderer` handles code-fence syntax highlighting through
 * the workbench tokenizer; the surrounding chrome (header, body
 * wrapper) styles are in `media/analysisReport.css`.
 */
export class AnalysisReportPane extends InsrcEditorPaneBase<AnalysisReportInput> {
	static readonly ID = 'insrc.analysisReportPane';

	private _header!: HTMLElement;
	private _titleEl!: HTMLElement;
	private _statusEl!: HTMLElement;
	private _body!: HTMLElement;
	private _emptyEl!: HTMLElement;

	private _listId: string | undefined;
	private _markdownRenderer: MarkdownRenderer | undefined;
	private _renderedBody: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IInsrcTodosService private readonly todosService: IInsrcTodosService,
	) {
		super(AnalysisReportPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = dom.append(parent, dom.$('.insrc-analysis-report'));

		this._header = dom.append(this._container, dom.$('.insrc-analysis-report-header'));
		this._titleEl = dom.append(this._header, dom.$('h2.insrc-analysis-report-title'));
		this._titleEl.textContent = 'Code Analysis Report';
		this._statusEl = dom.append(this._header, dom.$('span.insrc-analysis-report-status'));

		this._body = dom.append(this._container, dom.$('.insrc-analysis-report-body.rendered-markdown-host'));
		this._emptyEl = dom.append(this._container, dom.$('.insrc-analysis-report-empty'));
		this._emptyEl.textContent = 'Report not yet ready. The pane will populate when the analysis finishes.';
	}

	protected override onSetInput(input: AnalysisReportInput): void {
		this._listId = input.listId;
		this.registerServiceListener(this.todosService.onDidChangeList(list => {
			if (list.id === this._listId) {
				this._render(list);
			}
		}));
		this.registerServiceListener(this.todosService.onDidRemoveList(id => {
			if (id === this._listId) {
				this._showEmpty('Report list was removed.');
			}
		}));
		const list = this.todosService.lists.find(l => l.id === input.listId);
		this._render(list);
	}

	protected override onClearInput(): void {
		this._listId = undefined;
		this._renderedBody = undefined;
		dom.clearNode(this._body);
	}

	private _getRenderer(): MarkdownRenderer {
		if (!this._markdownRenderer) {
			this._markdownRenderer = this._register(this.instantiationService.createInstance(MarkdownRenderer, {}));
		}
		return this._markdownRenderer;
	}

	private _render(list: TodoList | undefined): void {
		if (list === undefined) {
			this._showEmpty('Report not available -- the list has rolled out of the active session.');
			return;
		}

		// Status badge: live "K/N items" + a state classifier so the
		// stylesheet can colour in-progress vs complete distinctly.
		const total = list.items.length;
		const completed = list.items.filter(i => i.status === 'completed').length;
		this._statusEl.textContent = total === 0 ? '' : `${completed}/${total} items`;
		this._statusEl.classList.remove('in-progress', 'complete');
		if (list.status === 'completed' || (total > 0 && completed === total)) {
			this._statusEl.classList.add('complete');
		} else {
			this._statusEl.classList.add('in-progress');
		}

		const body = list.body ?? '';
		if (body.length === 0) {
			this._showEmpty('Report still synthesising...');
			return;
		}

		// Avoid re-rendering identical content (the service may emit
		// redundant change events as items mutate around the same
		// snapshot).
		if (this._renderedBody === body) {
			this._emptyEl.style.display = 'none';
			this._body.style.display = '';
			return;
		}
		this._renderedBody = body;
		this._emptyEl.style.display = 'none';
		this._body.style.display = '';
		dom.clearNode(this._body);
		const rendered = this._getRenderer().render(new MarkdownString(body));
		this._body.appendChild(rendered.element);
	}

	private _showEmpty(message: string): void {
		this._renderedBody = undefined;
		dom.clearNode(this._body);
		this._body.style.display = 'none';
		this._emptyEl.textContent = message;
		this._emptyEl.style.display = '';
	}
}
