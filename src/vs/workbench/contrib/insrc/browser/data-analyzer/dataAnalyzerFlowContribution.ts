/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IInsrcChatService } from '../../common/chatService.js';
import { IInsrcTodosService, type TodoList } from '../../common/todosService.js';
import { DataAnalysisReportInput } from './dataAnalysisReportInput.js';

const DATA_ANALYZER_OWNER = 'data-analyzer';

/**
 * Workbench-side flow contribution for the Data Analyzer Report Pane
 * (plans/analyzers/data-analyzer.md Phase 2.1, acceptance item 1).
 *
 * Mirrors `CodeAnalyzerFlowContribution`. Responsibilities:
 *
 *   1. Auto-open the Report Pane the first time a data-analyzer
 *      TodoList in the active session gets a non-empty `body`. The
 *      orchestrator's `queueSynthesise` writes the body via
 *      `updateListBody`; the daemon emits `listUpdated` over the
 *      stream; the workbench-side todos service surfaces it as
 *      `onDidChangeList`. We watch that event, filter to
 *      `data-analyzer` lists, and openEditor exactly once per listId.
 *
 *   2. Reset the "already opened" set on chat-session change so
 *      switching sessions doesn't suppress a later analysis in the
 *      new session.
 *
 * No editor serializer is registered for `DataAnalysisReportInput` --
 * the pane is intentionally ephemeral: `list.body` lives forever in
 * LanceDB, so the user re-opens via the todos pane's "Open report"
 * action or `insrc.dataAnalyzer.openReport`; the workbench drops the
 * tab on reload and the orphan reconciler cleans up the backing file.
 */
export class DataAnalyzerFlowContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'insrc.dataAnalyzerFlow';

	private readonly _openedListIds = new Set<string>();

	constructor(
		@IInsrcTodosService private readonly todosService: IInsrcTodosService,
		@IInsrcChatService chatService: IInsrcChatService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.todosService.onDidChangeList(list => this._maybeOpen(list)));
		this._register(chatService.onDidChangeSession(() => this._openedListIds.clear()));
	}

	private async _maybeOpen(list: TodoList): Promise<void> {
		if (list.owner !== DATA_ANALYZER_OWNER) {
			return;
		}
		if (list.body === undefined || list.body.length === 0) {
			return;
		}
		if (this._openedListIds.has(list.id)) {
			return;
		}
		this._openedListIds.add(list.id);

		this.logService.info(`[data-analyzer:flow] auto-opening report pane listId=${list.id} sessionId=${list.sessionId} bodyLen=${list.body.length}`);

		try {
			const input = new DataAnalysisReportInput(list.sessionId, list.id, list.body);
			await input.ensureBackingFile(this.fileService);
			await this.editorService.openEditor(input);
		} catch (err) {
			this.logService.warn(`[data-analyzer:flow] openEditor failed for listId=${list.id}: ${(err as Error).message}`);
			// Failed to open -- allow a retry on the next list update.
			this._openedListIds.delete(list.id);
		}
	}
}
