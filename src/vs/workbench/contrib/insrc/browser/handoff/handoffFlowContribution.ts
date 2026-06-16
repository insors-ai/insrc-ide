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
import { HandoffReportInput } from './handoffReportInput.js';

const HANDOFF_OWNER = 'handoff';

/**
 * Workbench-side flow contribution for the Handoff Report Pane
 * (modelled on `DataAnalyzerFlowContribution`).
 *
 * Responsibilities:
 *
 *   1. Auto-open the Report Pane the first time a handoff TodoList in
 *      the active session gets a non-empty `body`. The orchestrator's
 *      `todo-reporter.ts` writes the body via `updateListBody` at
 *      `handoff-final` / `handoff-error`; the workbench-side todos
 *      service surfaces the mutation as `onDidChangeList`. We watch
 *      that event, filter to `handoff`-owned lists, and openEditor
 *      exactly once per listId.
 *
 *   2. Reset the "already opened" set on chat-session change so
 *      switching sessions doesn't suppress a later handoff in the
 *      new session.
 *
 * No editor serializer is registered for `HandoffReportInput` -- the
 * pane is intentionally ephemeral: `list.body` lives in the framework
 * store so the user re-opens via the todos pane or the
 * `insrc.handoff.openReport` palette command; the workbench drops the
 * tab on reload and the orphan reconciler cleans the backing file.
 */
export class HandoffFlowContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'insrc.handoffFlow';

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
		if (list.owner !== HANDOFF_OWNER) {
			return;
		}
		if (list.body === undefined || list.body.length === 0) {
			return;
		}
		if (this._openedListIds.has(list.id)) {
			return;
		}
		this._openedListIds.add(list.id);

		this.logService.info(`[handoff:flow] auto-opening report pane listId=${list.id} sessionId=${list.sessionId} bodyLen=${list.body.length}`);

		try {
			const input = new HandoffReportInput(list.sessionId, list.id, list.body, list.title);
			await input.ensureBackingFile(this.fileService);
			await this.editorService.openEditor(input, { pinned: true });
		} catch (err) {
			this.logService.warn(`[handoff:flow] openEditor failed for listId=${list.id}: ${(err as Error).message}`);
			// Failed to open -- allow a retry on the next list update.
			this._openedListIds.delete(list.id);
		}
	}
}
