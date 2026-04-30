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
import { parseDrillDownFooter, type DrillDownItem } from '../shared/drillDownFooter.js';

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

		// Phase 5.3 of plans/analyzers/data-analyzer.md: split the
		// trailing `## Drill down` section out of the rendered body
		// and turn each candidate into a clickable button that fires
		// `insrc.dataAnalyzer.drillDown` with this list's id stamped
		// as `parentListId`. Mirrors the code-analyzer pane's
		// behaviour; the parser is shared via shared/drillDownFooter.
		const { main, items } = parseDrillDownFooter(body);
		const renderable = main.length > 0 ? main : body;
		const rendered = this._getRenderer().render(new MarkdownString(renderable));
		this._body.appendChild(rendered.element);

		if (items.length > 0) {
			this._renderDrillDownFooter(list.id, items);
		}
	}

	/**
	 * Render the parsed drill-down footer as a stack of buttons. Each
	 * button fires `insrc.dataAnalyzer.drillDown` with this list's id
	 * threaded as `parentListId` so the daemon's chat.send stamps
	 * the parent edge on the child analysis's TodoList. Button label
	 * = the candidate question; scope (when present) renders as a
	 * dimmed suffix and is forwarded as the command's `scope` arg.
	 */
	private _renderDrillDownFooter(parentListId: string, items: readonly DrillDownItem[]): void {
		const wrapper = dom.append(this._body, dom.$('.insrc-data-analysis-report-drilldown'));
		const heading = dom.append(wrapper, dom.$('h2.insrc-data-analysis-report-drilldown-heading'));
		heading.textContent = 'Drill down';
		const list = dom.append(wrapper, dom.$('.insrc-data-analysis-report-drilldown-list'));
		for (const item of items) {
			const button = dom.append(list, dom.$('button.insrc-data-analysis-report-drilldown-button'));
			const questionEl = dom.append(button, dom.$('span.insrc-data-analysis-report-drilldown-question'));
			questionEl.textContent = item.question;
			if (item.scope.length > 0) {
				const scopeEl = dom.append(button, dom.$('span.insrc-data-analysis-report-drilldown-scope'));
				scopeEl.textContent = `scope: ${item.scope}`;
			}
			this._register(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
				const args: { parentListId: string; question: string; scope?: string } = {
					parentListId,
					question: item.question,
				};
				if (item.scope.length > 0) {
					args.scope = item.scope;
				}
				void this.commandService.executeCommand('insrc.dataAnalyzer.drillDown', args);
			}));
		}
	}

	private _showEmpty(message: string): void {
		this._renderedBody = undefined;
		dom.clearNode(this._body);
		this._body.style.display = 'none';
		this._emptyEl.textContent = message;
		this._emptyEl.style.display = '';
	}
}
