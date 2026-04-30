/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/dataAnalysisReport.css';
import * as dom from '../../../../../base/browser/dom.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { MarkdownRenderer } from '../../../../../editor/browser/widget/markdownRenderer/browser/markdownRenderer.js';
import { IInsrcTodosService, type TodoList } from '../../common/todosService.js';
import { DataAnalysisReportInput } from './dataAnalysisReportInput.js';
import { InsrcEditorPaneBase } from '../shared/workspacePaneBase.js';

/**
 * Data Analyzer Report Pane (plans/analyzers/data-analyzer.md Phase 2.1).
 *
 * Renders the synthesised markdown report for one data-analysis run.
 * Mirrors the code-analyzer's `AnalysisReportPane` but reads from
 * data-analyzer-owned TodoLists. The report content lives in the
 * framework-side TodoList's `body` field -- the orchestrator's
 * `queueSynthesise` writes it via `updateListBody` -- so this pane
 * renders directly from the live `IInsrcTodosService` snapshot rather
 * than the backing file.
 *
 * Phase 2.1 ships the basic render + Save... button. Phase 5.3 will
 * add a drill-down footer (clickable "## Drill down" candidates) and
 * Phase 5.6 wires the `data-conn:` URI opener so connection-citation
 * links navigate to the data-sources pane. Until then the rendered
 * markdown shows the drill-down section verbatim and `data-conn:`
 * URIs are inert (the markdown renderer renders them as text).
 *
 * The pane uses `IInsrcEditorPaneBase`'s service-listener registry so
 * `onSetInput` / `onClearInput` correctly dispose old subscriptions
 * across input swaps within the same pane instance.
 */
export class DataAnalysisReportPane extends InsrcEditorPaneBase<DataAnalysisReportInput> {
	static readonly ID = 'insrc.dataAnalysisReportPane';

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
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(DataAnalysisReportPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = dom.append(parent, dom.$('.insrc-data-analysis-report'));

		this._header = dom.append(this._container, dom.$('.insrc-data-analysis-report-header'));
		this._titleEl = dom.append(this._header, dom.$('h2.insrc-data-analysis-report-title'));
		this._titleEl.textContent = 'Data Analysis Report';
		this._statusEl = dom.append(this._header, dom.$('span.insrc-data-analysis-report-status'));

		// Save button -- writes the report markdown to a real file
		// under the active repo's docs/data-analysis/. Disabled until
		// `_listId` is set so the click target's args resolve cleanly.
		const saveBtn = dom.append(this._header, dom.$('button.insrc-data-analysis-report-action'));
		saveBtn.textContent = 'Save...';
		saveBtn.title = 'Save report to file (docs/data-analysis/)';
		this._register(dom.addDisposableListener(saveBtn, dom.EventType.CLICK, () => {
			if (this._listId === undefined) {
				return;
			}
			void this.commandService.executeCommand('insrc.dataAnalyzer.saveReport', { listId: this._listId });
		}));

		this._body = dom.append(this._container, dom.$('.insrc-data-analysis-report-body.rendered-markdown-host'));
		this._emptyEl = dom.append(this._container, dom.$('.insrc-data-analysis-report-empty'));
		this._emptyEl.textContent = 'Report not yet ready. The pane will populate when the analysis finishes.';
	}

	protected override onSetInput(input: DataAnalysisReportInput): void {
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

		// Status badge: "K/N items" + state classifier so the
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

		// Phase 5.3 will split out a `## Drill down` footer the way
		// the code-analyzer pane does. For Phase 2.1 we render the
		// body verbatim -- the synthesise prompt always emits a
		// drill-down section (with a placeholder when no candidates
		// exist), and showing it as plain markdown is acceptable
		// until the clickable variant lands.
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
