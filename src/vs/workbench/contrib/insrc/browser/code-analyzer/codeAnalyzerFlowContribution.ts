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
import { AnalysisReportInput } from './analysisReportInput.js';

const CODE_ANALYZER_OWNER = 'code-analyzer';

/**
 * Workbench-side flow contribution for the Code Analyzer Report Pane
 * (plans/analyzers/code-analyzer.md Phase 2.1, acceptance items 1-2).
 *
 * Responsibilities:
 *
 *   1. Auto-open the Report Pane the first time a code-analyzer
 *      TodoList in the active session gets a non-empty `body`. The
 *      orchestrator writes the body in `afterSynthesise`; the daemon
 *      emits `listUpdated` over the stream; the workbench-side
 *      todos service surfaces it as `onDidChangeList`. We watch
 *      that event, filter to `code-analyzer` lists, and openEditor
 *      exactly once per listId.
 *
 *   2. Reset the "already opened" set on chat-session change so
 *      switching sessions doesn't suppress a later analysis in the
 *      new session.
 *
 * Mirrors the pattern used by `BrainstormFlowContribution`. We do NOT
 * register an editor serializer for `AnalysisReportInput` -- the
 * pane is intentionally ephemeral (design section10.2): `list.body` lives
 * forever in LanceDB, so the user re-opens via the todos pane's
 * kebab "Open report" action; the workbench drops the tab on reload
 * and the orphan reconciler cleans up the backing file.
 */
export class CodeAnalyzerFlowContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'insrc.codeAnalyzerFlow';

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
		if (list.owner !== CODE_ANALYZER_OWNER) {
			return;
		}
		if (list.body === undefined || list.body.length === 0) {
			return;
		}
		if (this._openedListIds.has(list.id)) {
			return;
		}
		this._openedListIds.add(list.id);

		this.logService.info(`[code-analyzer:flow] auto-opening report pane listId=${list.id} sessionId=${list.sessionId} bodyLen=${list.body.length}`);

		try {
			const input = new AnalysisReportInput(list.sessionId, list.id, list.body, list.title);
			await input.ensureBackingFile(this.fileService);
			await this.editorService.openEditor(input);
		} catch (err) {
			this.logService.warn(`[code-analyzer:flow] openEditor failed for listId=${list.id}: ${(err as Error).message}`);
			// Failed to open -- allow a retry on the next list update.
			this._openedListIds.delete(list.id);
		}
	}
}
