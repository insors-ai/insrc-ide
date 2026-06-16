/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/handoffReport.css';
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
import { HandoffReportInput } from './handoffReportInput.js';
import { InsrcEditorPaneBase } from '../shared/workspacePaneBase.js';

/**
 * Handoff Report Pane (modelled on the data-analyzer's
 * `DataAnalysisReportPane`).
 *
 * Renders the synthesised markdown report for one handoff run. The
 * report body lives in the framework-side TodoList's `body` field --
 * runHandoff's `todo-reporter.ts` writes it via `updateListBody` at
 * `handoff-final` / `handoff-error` -- so this pane renders directly
 * from the live `IInsrcTodosService` snapshot rather than the backing
 * file.
 *
 * Status badge shows `K/N stages` (TodoItems are the pipeline stages
 * spec-assembling / spec-ready / worktree / spawned / agent-completed
 * / auditing / audit-ready / final). Re-run button fires a quick-pick
 * command (`insrc.handoff.rerun`) that the user can use to retry with
 * a different agent / template choice.
 */
export class HandoffReportPane extends InsrcEditorPaneBase<HandoffReportInput> {
	static readonly ID = 'insrc.handoffReportPane';

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
		super(HandoffReportPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = dom.append(parent, dom.$('.insrc-handoff-report'));

		this._header = dom.append(this._container, dom.$('.insrc-handoff-report-header'));
		this._titleEl = dom.append(this._header, dom.$('h2.insrc-handoff-report-title'));
		this._titleEl.textContent = 'Handoff Report';
		this._statusEl = dom.append(this._header, dom.$('span.insrc-handoff-report-status'));

		// Re-run button -- opens a quick-pick (agent + template + edited
		// intent prefilled in the chat input). Wired in
		// `handoffReRunCommand.ts`; the click target's args are
		// resolved at click time once `_listId` is set.
		const rerunBtn = dom.append(this._header, dom.$('button.insrc-handoff-report-action'));
		rerunBtn.textContent = 'Re-run...';
		rerunBtn.title = 'Re-run this handoff with a different agent / template';
		this._register(dom.addDisposableListener(rerunBtn, dom.EventType.CLICK, () => {
			if (this._listId === undefined) {
				return;
			}
			void this.commandService.executeCommand('insrc.handoff.rerun', { listId: this._listId });
		}));

		this._body = dom.append(this._container, dom.$('.insrc-handoff-report-body.rendered-markdown-host'));
		this._emptyEl = dom.append(this._container, dom.$('.insrc-handoff-report-empty'));
		this._emptyEl.textContent = 'Report not yet ready. The pane will populate when the handoff finishes.';
	}

	protected override onSetInput(input: HandoffReportInput): void {
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

		// Status badge: K/N stages + state classifier so the
		// stylesheet can colour in-progress vs complete distinctly.
		const total = list.items.length;
		const completed = list.items.filter(i => i.status === 'completed').length;
		this._statusEl.textContent = total === 0 ? '' : `${completed}/${total} stages`;
		this._statusEl.classList.remove('in-progress', 'complete');
		if (list.status === 'completed' || (total > 0 && completed === total)) {
			this._statusEl.classList.add('complete');
		} else {
			this._statusEl.classList.add('in-progress');
		}

		const body = list.body ?? '';
		if (body.length === 0) {
			this._showEmpty('Handoff running... the report will populate when it finishes.');
			return;
		}

		// Avoid re-rendering identical content.
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
