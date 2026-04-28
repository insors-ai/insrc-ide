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
