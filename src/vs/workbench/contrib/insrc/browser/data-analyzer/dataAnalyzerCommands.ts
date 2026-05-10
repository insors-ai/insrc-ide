/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IInsrcChatService } from '../../common/chatService.js';
import { IInsrcDaemonService } from '../../common/daemonService.js';
import { IInsrcTodosService, type TodoList } from '../../common/todosService.js';
import { DataAnalysisReportInput } from './dataAnalysisReportInput.js';
import { EphemeralEditorInput } from '../shared/ephemeralEditorInput.js';
import { rewriteCustomUrisForSave } from '../shared/saveReportUris.js';

const CATEGORY = localize2('insrc', 'insrc');
const DATA_ANALYZER_OWNER = 'data-analyzer';

/**
 * Open the Data Analysis Report pane for a given listId, or for the
 * most recent data-analyzer list in the active session if no listId
 * is supplied. Mirrors `insrc.codeAnalyzer.openReport`.
 *
 * The workbench drops the report-pane tab across IDE reloads (the
 * pane is ephemeral); this command is the re-entry point. Bound to
 * the todos pane's "Open report" row action via `arg.listId`, and
 * available from the palette without args (most-recent fallback).
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.dataAnalyzer.openReport',
			title: localize2('insrc.dataAnalyzer.openReport', 'Open Data Analysis Report'),
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
			const sessionId = chatService.activeSessionId;
			if (sessionId === undefined) {
				notificationService.info('No active chat session; run /data-analyze first.');
				return;
			}
			const candidates = todosService.lists.filter(
				l => l.sessionId === sessionId && l.owner === DATA_ANALYZER_OWNER && l.body !== undefined && l.body.length > 0,
			);
			if (candidates.length === 0) {
				notificationService.info('No data-analysis report yet for this session. Run /data-analyze.');
				return;
			}
			list = candidates[candidates.length - 1];
		}

		if (list === undefined) {
			return;
		}

		const input = new DataAnalysisReportInput(list.sessionId, list.id, list.body ?? '', list.title);
		await input.ensureBackingFile(fileService);
		// Pin so each report opens in its own tab instead of replacing
		// VSCode's shared preview slot.
		await editorService.openEditor(input, { pinned: true });
	}
});

/**
 * Save the Data Analysis report markdown to a file under
 * `<repo-root>/docs/data-analysis/<slug>-<short-listId>.md`. Mirrors
 * `insrc.codeAnalyzer.saveReport`. Uses the shared
 * `rewriteCustomUrisForSave` helper to convert `path:` citations to
 * absolute `file://` URIs so the saved markdown clicks through under
 * VS Code's stock markdown preview.
 *
 * `data-conn:` URIs are intentionally left untouched -- they're
 * navigation anchors keyed on the connection registry, not file
 * references. They're inert in stock preview but still work in-IDE
 * once Phase 5.6 ships the `data-conn:` opener.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.dataAnalyzer.saveReport',
			title: localize2('insrc.dataAnalyzer.saveReport', 'Save Data Analysis Report'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor, arg?: { listId?: string }): Promise<void> {
		const chatService = accessor.get(IInsrcChatService);
		const todosService = accessor.get(IInsrcTodosService);
		const fileService = accessor.get(IFileService);
		const dialogService = accessor.get(IDialogService);
		const editorService = accessor.get(IEditorService);
		const workspaceService = accessor.get(IWorkspaceContextService);
		const notifications = accessor.get(INotificationService);

		// Resolve list (explicit listId or most-recent fallback).
		let list: TodoList | undefined;
		const targetListId = arg?.listId;
		if (targetListId !== undefined) {
			list = todosService.lists.find(l => l.id === targetListId);
			if (list === undefined) {
				notifications.info('Save aborted -- the analysis list is no longer loaded for this session.');
				return;
			}
		} else {
			const sessionId = chatService.activeSessionId;
			if (sessionId === undefined) {
				notifications.info('No active chat session; run /data-analyze first.');
				return;
			}
			const candidates = todosService.lists.filter(
				l => l.sessionId === sessionId && l.owner === DATA_ANALYZER_OWNER && l.body !== undefined && l.body.length > 0,
			);
			if (candidates.length === 0) {
				notifications.info('No completed data-analysis report yet for this session.');
				return;
			}
			list = candidates[candidates.length - 1];
		}
		if (list === undefined || list.body === undefined || list.body.trim().length === 0) {
			notifications.info('Save aborted -- the report has no body.');
			return;
		}

		const repoRoot = resolveRepoRoot(chatService, workspaceService);
		if (repoRoot === undefined) {
			notifications.info('Save aborted -- no active repo or workspace folder available.');
			return;
		}

		const slug = slugFromRequest(list.description ?? list.title);
		const filename = `${slug}-${list.id.slice(0, 8)}.md`;
		const target = joinPath(repoRoot, 'docs', 'data-analysis', filename);

		try {
			const exists = await fileService.exists(target);
			if (exists) {
				const result = await dialogService.confirm({
					message: 'Overwrite existing report?',
					detail: `${target.fsPath} already exists.`,
					primaryButton: 'Overwrite',
					type: 'warning',
				});
				if (!result.confirmed) {
					return;
				}
			}
		} catch (err) {
			notifications.notify({
				severity: Severity.Error,
				message: `Could not check target file: ${err instanceof Error ? err.message : String(err)}`,
			});
			return;
		}

		// Rewrite path: citations to absolute file:// URIs via the
		// shared helper. data-conn: URIs are left as-is (Phase 5.6).
		const rewrittenBody = rewriteCustomUrisForSave(list.body, repoRoot);

		try {
			await fileService.writeFile(target, VSBuffer.fromString(rewrittenBody));
		} catch (err) {
			notifications.notify({
				severity: Severity.Error,
				message: `Save failed: ${err instanceof Error ? err.message : String(err)}`,
			});
			return;
		}
		await editorService.openEditor({ resource: target });
		notifications.notify({
			severity: Severity.Info,
			message: `Saved to ${target.fsPath}`,
		});
	}
});

/**
 * Pick the repo path the report should land under. Prefers
 * `chatService.activeRepo` (the repo the analysis was run against);
 * falls back to the workspace's first folder. Returns undefined when
 * neither is available.
 */
function resolveRepoRoot(
	chatService: IInsrcChatService,
	workspaceService: IWorkspaceContextService,
): URI | undefined {
	const activeRepo = chatService.activeRepo;
	if (activeRepo !== undefined && activeRepo.length > 0) {
		return URI.file(activeRepo);
	}
	const folders = workspaceService.getWorkspace().folders;
	if (folders.length > 0) {
		return folders[0]!.uri;
	}
	return undefined;
}

/**
 * Derive a filesystem-safe slug from the original analysis request.
 * Lowercase, alnum-and-hyphen only, collapsed runs of `-`, capped at
 * 60 chars. Falls back to `report` when the input is empty.
 */
function slugFromRequest(request: string): string {
	const trimmed = request.trim().toLowerCase();
	if (trimmed.length === 0) {
		return 'report';
	}
	const slug = trimmed
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
	return slug.length > 0 ? slug : 'report';
}

/**
 * Drill down on a data-analysis report (plans/analyzers/data-analyzer.md
 * Phase 5.3). Args:
 *
 *   {
 *     parentListId: string;   // the report-pane list this came from
 *     question:     string;   // one-line drill-down candidate
 *     scope?:       string;   // optional connection / table / path hint
 *   }
 *
 * Behaviour:
 *   1. Resolve the parent list (programmatic mode supplies the id;
 *      palette-mode falls back to the most-recent data-analyzer list
 *      in the active session, mirroring openReport / saveReport).
 *   2. Build a `/data-analyze <question> (scope: <scope>)` chat
 *      message.
 *   3. Send via `chatService.sendMessage(message, undefined, parentListId)`
 *      -- the third arg threads parentListId to the daemon's
 *      chat.send, which carries it to the orchestrator's createList.
 *   4. The daemon's existing /data-analyze slash dispatcher kicks
 *      off a child analysis with the parent edge stamped on the new
 *      TodoList; the Report Pane auto-opens for the child run via
 *      the existing flow contribution.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.dataAnalyzer.drillDown',
			title: localize2('insrc.dataAnalyzer.drillDown', 'Drill Down on Data Analysis'),
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

		let parentListId = arg?.parentListId;
		if (parentListId === undefined) {
			const sessionId = chatService.activeSessionId;
			if (sessionId === undefined) {
				notifications.info('No active chat session; run /data-analyze first.');
				return;
			}
			const candidates = todosService.lists.filter(
				l => l.sessionId === sessionId && l.owner === DATA_ANALYZER_OWNER && l.body !== undefined && l.body.length > 0,
			);
			if (candidates.length === 0) {
				notifications.info('No data-analysis report yet. Run /data-analyze first.');
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
			? `/data-analyze ${question} (scope: ${scope})`
			: `/data-analyze ${question}`;
		await chatService.sendMessage(message, undefined, parentListId);
	}
});

/**
 * Re-run a completed Data Analysis (plans/analyzers/data-analyzer.md
 * Phase 5.1). Args:
 *
 *   {
 *     listId?: string;   // the prior analysis list to re-run
 *   }
 *
 * Behaviour:
 *   1. Resolve the prior list (programmatic mode supplies it; palette
 *      mode picks the most-recent data-analyzer list in the active
 *      session).
 *   2. Re-issue the prior `request` as a `/data-analyze` chat message
 *      with `rerunFromListId` set; the daemon skips the plan LLM
 *      call and reconstructs the task list from the prior list's
 *      items. The new run threads under the prior in the todos
 *      pane (parentListId = priorListId) and benefits from the
 *      Phase 2.4 cache when nothing has changed.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.dataAnalyzer.rerun',
			title: localize2('insrc.dataAnalyzer.rerun', 'Re-run Data Analysis'),
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
				notifications.info('No active chat session; run /data-analyze first.');
				return;
			}
			const candidates = todosService.lists.filter(
				l => l.sessionId === sessionId && l.owner === DATA_ANALYZER_OWNER && l.body !== undefined && l.body.length > 0,
			);
			if (candidates.length === 0) {
				notifications.info('No data-analysis report yet for this session. Run /data-analyze first.');
				return;
			}
			priorList = candidates[candidates.length - 1];
		}

		if (priorList === undefined) {
			notifications.info('Re-run target not available -- the prior analysis list is no longer loaded for this session.');
			return;
		}

		const priorRequest = (priorList.description ?? priorList.title).trim();
		if (priorRequest.length === 0) {
			notifications.info('Re-run aborted -- prior list has no recoverable request text.');
			return;
		}

		const message = `/data-analyze ${priorRequest}`;
		await chatService.sendMessage(message, undefined, undefined, priorList.id);
	}
});

/**
 * Diff a Data Analysis run against a prior run
 * (plans/analyzers/data-analyzer.md Phase 5.2). Args:
 *
 *   {
 *     priorListId?:   string;
 *     currentListId?: string;  // defaults to the most-recent list, with
 *                              // its parentListId picked as `prior` when set.
 *   }
 *
 * Behaviour: resolve the (prior, current) pair, call the daemon's
 * `dataAnalyzer.diffRuns` RPC, write the rendered markdown to a tmp
 * file, open it in the workbench's default editor.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.dataAnalyzer.diffWithPrevious',
			title: localize2('insrc.dataAnalyzer.diffWithPrevious', 'Diff Data Analysis With Previous Run'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(
		accessor: ServicesAccessor,
		arg?: { priorListId?: string; currentListId?: string },
	): Promise<void> {
		const daemon = accessor.get(IInsrcDaemonService);
		const chatService = accessor.get(IInsrcChatService);
		const todosService = accessor.get(IInsrcTodosService);
		const fileService = accessor.get(IFileService);
		const editorService = accessor.get(IEditorService);
		const notifications = accessor.get(INotificationService);

		const pair = await resolveDataDiffPair(arg, chatService, todosService);
		if (typeof pair === 'string') {
			notifications.info(pair);
			return;
		}

		let result: { markdown: string; stats: { added: number; removed: number; changed: number; unchanged: number } };
		try {
			result = await daemon.rpc(
				'dataAnalyzer.diffRuns',
				{ priorListId: pair.priorListId, currentListId: pair.currentListId },
			);
		} catch (err) {
			notifications.notify({
				severity: Severity.Error,
				message: `Diff failed: ${err instanceof Error ? err.message : String(err)}`,
			});
			return;
		}

		const diffId = `${pair.priorListId.slice(0, 8)}__${pair.currentListId.slice(0, 8)}`;
		const target = joinPath(EphemeralEditorInput.getTmpDir(), `data-analysis-diff-${diffId}.md`);
		try {
			await fileService.writeFile(target, VSBuffer.fromString(result.markdown));
		} catch (err) {
			notifications.notify({
				severity: Severity.Error,
				message: `Could not write diff file: ${err instanceof Error ? err.message : String(err)}`,
			});
			return;
		}

		await editorService.openEditor({ resource: target });
		notifications.notify({
			severity: Severity.Info,
			message: `Diff: +${result.stats.added} added · -${result.stats.removed} removed · ~${result.stats.changed} changed · ${result.stats.unchanged} unchanged.`,
		});
	}
});

/**
 * Resolve the (prior, current) pair for diff. Mirrors the
 * code-analyzer helper -- prefer the parent-child pairing when
 * available; fall back to the next-most-recent list as `prior`.
 */
async function resolveDataDiffPair(
	arg: { priorListId?: string; currentListId?: string } | undefined,
	chatService: IInsrcChatService,
	todosService: IInsrcTodosService,
): Promise<{ priorListId: string; currentListId: string } | string> {
	if (arg?.priorListId !== undefined && arg?.currentListId !== undefined) {
		return { priorListId: arg.priorListId, currentListId: arg.currentListId };
	}

	const sessionId = chatService.activeSessionId;
	if (sessionId === undefined) {
		return 'No active chat session; run /data-analyze first.';
	}
	const candidates = todosService.lists.filter(
		l => l.sessionId === sessionId && l.owner === DATA_ANALYZER_OWNER && l.body !== undefined && l.body.length > 0,
	);
	if (candidates.length < 2) {
		return 'Need at least two completed data-analyzer reports to diff. Re-run an existing report and try again.';
	}

	const current = arg?.currentListId !== undefined
		? candidates.find(l => l.id === arg.currentListId) ?? candidates[candidates.length - 1]
		: candidates[candidates.length - 1];
	const prior = arg?.priorListId !== undefined
		? candidates.find(l => l.id === arg.priorListId)
		: undefined;

	if (current === undefined) {
		return 'Could not resolve the current run to diff.';
	}

	if (prior !== undefined) {
		return { priorListId: prior.id, currentListId: current.id };
	}

	if (current.parentListId !== undefined) {
		const parent = candidates.find(l => l.id === current.parentListId);
		if (parent !== undefined) {
			return { priorListId: parent.id, currentListId: current.id };
		}
	}

	const olderCandidates = candidates.filter(l => l.id !== current.id);
	if (olderCandidates.length === 0) {
		return 'No prior run available to diff against.';
	}
	const fallback = olderCandidates[olderCandidates.length - 1]!;
	return { priorListId: fallback.id, currentListId: current.id };
}

/**
 * Clear the Data Analyzer's per-task cache (plans/analyzers/data-analyzer.md
 * Phase 2.4). Useful when the connection-roster fingerprint hasn't
 * changed but the user wants fresh introspection (e.g. an out-of-band
 * schema migration the roster-level fingerprint can't detect).
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.dataAnalyzer.clearCache',
			title: localize2('insrc.dataAnalyzer.clearCache', 'Clear Data Analyzer Cache'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const daemon = accessor.get(IInsrcDaemonService);
		const notifications = accessor.get(INotificationService);
		try {
			const result = await daemon.rpc<{ removed: number }>('dataAnalyzer.clearCache');
			const removed = result?.removed ?? 0;
			notifications.notify({
				severity: Severity.Info,
				message: removed === 0
					? 'Data Analyzer cache was already empty.'
					: `Cleared Data Analyzer cache (${removed} entr${removed === 1 ? 'y' : 'ies'} removed).`,
			});
		} catch (err) {
			notifications.notify({
				severity: Severity.Error,
				message: `Failed to clear Data Analyzer cache: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}
});
