/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IInsrcChatService } from '../../common/chatService.js';
import { IInsrcDaemonService } from '../../common/daemonService.js';
import { IInsrcTodosService, type TodoList } from '../../common/todosService.js';
import { AnalysisReportInput } from './analysisReportInput.js';

const CATEGORY = localize2('insrc', 'insrc');
const CODE_ANALYZER_OWNER = 'code-analyzer';

/**
 * Open the Code Analysis Report pane for a given listId, or for the
 * most recent code-analyzer list in the active session if no listId
 * is supplied. Both invocation modes ensure the backing file before
 * openEditor.
 *
 * Plan section2.1 acceptance item 2: reload the workbench → pane is gone;
 * clicking "Open report" re-opens it from list.body. The todos
 * pane's row kebab menu wires into this command (Phase 2 follow-up
 * UI work; the command is the load-bearing piece).
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.codeAnalyzer.openReport',
			title: localize2('insrc.codeAnalyzer.openReport', 'Open Code Analysis Report'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor, arg?: { listId?: string }): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const chatService = accessor.get(IInsrcChatService);
		const todosService = accessor.get(IInsrcTodosService);
		const fileService = accessor.get(IFileService);
		const notificationService = accessor.get(INotificationService);

		const targetListId = arg?.listId;
		let list: TodoList | undefined;
		if (targetListId !== undefined) {
			list = todosService.lists.find(l => l.id === targetListId);
			if (list === undefined) {
				notificationService.info('Report not available -- the analysis list is no longer loaded for this session.');
				return;
			}
		} else {
			// Palette invocation: pick the most recent code-analyzer list in
			// the active session. `lists` is sorted by the service; we want
			// the freshest with a non-empty body so we land on a viewable
			// report rather than an in-flight one.
			const sessionId = chatService.activeSessionId;
			if (sessionId === undefined) {
				notificationService.info('No active chat session; run /code-analyze first.');
				return;
			}
			const candidates = todosService.lists.filter(
				l => l.sessionId === sessionId && l.owner === CODE_ANALYZER_OWNER && l.body !== undefined && l.body.length > 0,
			);
			if (candidates.length === 0) {
				notificationService.info('No code-analysis report yet for this session. Run /code-analyze.');
				return;
			}
			// Take the last one (assumed most-recent by insertion order).
			list = candidates[candidates.length - 1];
		}

		if (list === undefined) {
			return;
		}

		const input = new AnalysisReportInput(list.sessionId, list.id, list.body ?? '');
		await input.ensureBackingFile(fileService);
		await editorService.openEditor(input);
	}
});

/**
 * Clear the Code Analyzer's per-task cache (plans/analyzers/code-analyzer.md
 * Phase 2.5). The cache lives daemon-side under `~/.insrc/cache/code-
 * analyzer/`; workbench can't read it directly, so this command goes
 * through the `codeAnalyzer.clearCache` daemon RPC.
 *
 * Useful when:
 *   - prompts changed and the user wants the next /code-analyze run
 *     to redo every task without bumping git HEAD;
 *   - debugging cache-related behaviour;
 *   - reclaiming disk space (each entry caps at 256 KB; the LRU caps
 *     entries at 200, but a force-clear is still sometimes faster).
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.codeAnalyzer.clearCache',
			title: localize2('insrc.codeAnalyzer.clearCache', 'Clear Code Analyzer Cache'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const daemon = accessor.get(IInsrcDaemonService);
		const notifications = accessor.get(INotificationService);
		try {
			const result = await daemon.rpc<{ removed: number }>('codeAnalyzer.clearCache');
			const removed = result?.removed ?? 0;
			notifications.notify({
				severity: Severity.Info,
				message: removed === 0
					? 'Code Analyzer cache was already empty.'
					: `Cleared Code Analyzer cache (${removed} entr${removed === 1 ? 'y' : 'ies'} removed).`,
			});
		} catch (err) {
			notifications.notify({
				severity: Severity.Error,
				message: `Failed to clear Code Analyzer cache: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}
});

/**
 * Drill into a sub-question off an existing Code Analysis report
 * (plans/analyzers/code-analyzer.md Phase 5.D). Args:
 *
 *   {
 *     parentListId: string;        // the report-pane list this came from
 *     question:     string;        // one-line drill-down candidate
 *     scope?:       string;        // optional path/module/entity hint
 *   }
 *
 * Behaviour:
 *   1. Build a `/code-analyze <question> (scope: <scope>)` chat
 *      message via `buildDrillDownMessage`.
 *   2. Send via `chatService.sendMessage(message, undefined, parentListId)` --
 *      the third arg threads parentListId to the daemon's chat.send,
 *      which carries it through to the orchestrator's createList.
 *   3. The daemon's existing /code-analyze slash dispatcher kicks
 *      off the Code Analyzer with the parent edge stamped on the new
 *      TodoList; the Report Pane auto-opens for the child run via the
 *      existing flow contribution.
 *
 * f1 is true so the command shows up in the palette, but the typical
 * invocation is from the Report Pane's drill-down footer buttons --
 * those pass the args programmatically. Palette invocation without
 * args falls back to a manual prompt for the most-recent code-analyzer
 * list + a free-form drill question.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.codeAnalyzer.drillDown',
			title: localize2('insrc.codeAnalyzer.drillDown', 'Drill Down on Code Analysis'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(
		accessor: ServicesAccessor,
		arg?: { parentListId?: string; question?: string; scope?: string },
	): Promise<void> {
		const chatService = accessor.get(IInsrcChatService);
		const todosService = accessor.get(IInsrcTodosService);
		const notifications = accessor.get(INotificationService);

		// Resolve the parent list. Programmatic mode supplies the id;
		// palette mode falls back to the most-recent code-analyzer
		// report list in the active session (same pattern as openReport
		// above) so the user has a single-click "drill down on the last
		// report" shortcut.
		let parentListId = arg?.parentListId;
		if (parentListId === undefined) {
			const sessionId = chatService.activeSessionId;
			if (sessionId === undefined) {
				notifications.info('No active chat session; run /code-analyze first.');
				return;
			}
			const candidates = todosService.lists.filter(
				l => l.sessionId === sessionId && l.owner === CODE_ANALYZER_OWNER && l.body !== undefined && l.body.length > 0,
			);
			if (candidates.length === 0) {
				notifications.info('No code-analysis report yet. Run /code-analyze first.');
				return;
			}
			parentListId = candidates[candidates.length - 1].id;
		}

		const question = (arg?.question ?? '').trim();
		if (question.length === 0) {
			notifications.info('Drill-down needs a question. Click a footer item in the Report pane, or pass a `question` arg.');
			return;
		}

		const scope = (arg?.scope ?? '').trim();
		const message = scope.length > 0
			? `/code-analyze ${question} (scope: ${scope})`
			: `/code-analyze ${question}`;
		await chatService.sendMessage(message, undefined, parentListId);
	}
});

/**
 * Re-run a completed Code Analysis against the current repo
 * revision (plans/analyzers/code-analyzer.md section 4.1). Args:
 *
 *   {
 *     listId?: string;   // the prior analysis list to re-run
 *   }
 *
 * Behaviour:
 *   1. Resolve the prior list (programmatic mode supplies it; palette
 *      mode picks the most-recent code-analyzer report list in the
 *      active session).
 *   2. Re-issue the prior `request` as a `/code-analyze` chat message
 *      with `rerunFromListId` set; the daemon skips the plan LLM
 *      call and reconstructs the task list from the prior list's
 *      items. The new run threads under the prior in the todos
 *      pane (parentListId = priorListId).
 *
 * The Report Pane wires this into a "Re-run" affordance in the
 * pane header (follow-up commit); today the palette is the entry.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.codeAnalyzer.rerun',
			title: localize2('insrc.codeAnalyzer.rerun', 'Re-run Code Analysis'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor, arg?: { listId?: string }): Promise<void> {
		const chatService = accessor.get(IInsrcChatService);
		const todosService = accessor.get(IInsrcTodosService);
		const notifications = accessor.get(INotificationService);

		let priorList: TodoList | undefined;
		const targetListId = arg?.listId;
		if (targetListId !== undefined) {
			priorList = todosService.lists.find(l => l.id === targetListId);
		} else {
			const sessionId = chatService.activeSessionId;
			if (sessionId === undefined) {
				notifications.info('No active chat session; run /code-analyze first.');
				return;
			}
			const candidates = todosService.lists.filter(
				l => l.sessionId === sessionId && l.owner === CODE_ANALYZER_OWNER && l.body !== undefined && l.body.length > 0,
			);
			if (candidates.length === 0) {
				notifications.info('No code-analysis report yet for this session. Run /code-analyze first.');
				return;
			}
			priorList = candidates[candidates.length - 1];
		}

		if (priorList === undefined) {
			notifications.info('Re-run target not available -- the prior analysis list is no longer loaded for this session.');
			return;
		}

		// Use the prior list's `description` (which the orchestrator
		// stamps as the original request) as the new prompt. Falls
		// back to the title if description is missing.
		const priorRequest = (priorList.description ?? priorList.title).trim();
		if (priorRequest.length === 0) {
			notifications.info('Re-run aborted -- prior list has no recoverable request text.');
			return;
		}

		const message = `/code-analyze ${priorRequest}`;
		await chatService.sendMessage(message, undefined, undefined, priorList.id);
	}
});
