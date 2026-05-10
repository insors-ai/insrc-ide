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
import { AnalysisReportInput } from './analysisReportInput.js';
import { EphemeralEditorInput } from '../shared/ephemeralEditorInput.js';
import { rewriteCustomUrisForSave } from '../shared/saveReportUris.js';

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

/**
 * Diff a Code Analysis run against a prior run
 * (plans/analyzers/code-analyzer.md section 4.2). Args:
 *
 *   {
 *     priorListId?:   string;  // the older run
 *     currentListId?: string;  // the newer run; defaults to a list
 *                              // whose parentListId === priorListId
 *                              // OR the most-recent list overall.
 *   }
 *
 * Behaviour:
 *   1. Resolve the (prior, current) pair.
 *      Programmatic mode: caller supplies both ids.
 *      Palette mode (no args): pick the most-recent code-analyzer
 *      list as `current`; use its `parentListId` as `prior` when
 *      set, otherwise the next-most-recent.
 *   2. Call the daemon's `codeAnalyzer.diffRuns` RPC; render the
 *      structured diff into markdown (the daemon returns both).
 *   3. Open the markdown in the workbench's default editor under
 *      `~/.insrc/tmp/code-analysis-diff-<id>.md` so the user can
 *      scroll, search, and copy chunks.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.codeAnalyzer.diffWithPrevious',
			title: localize2('insrc.codeAnalyzer.diffWithPrevious', 'Diff Code Analysis With Previous Run'),
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

		const pair = await resolveDiffPair(arg, chatService, todosService);
		if (typeof pair === 'string') {
			notifications.info(pair);
			return;
		}

		let result: { markdown: string; stats: { added: number; removed: number; changed: number; unchanged: number } };
		try {
			result = await daemon.rpc(
				'codeAnalyzer.diffRuns',
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
		const target = joinPath(EphemeralEditorInput.getTmpDir(), `code-analysis-diff-${diffId}.md`);
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
 * Resolve the (prior, current) list-id pair for the diff command.
 * Returns a string error message when no usable pair exists.
 */
async function resolveDiffPair(
	arg: { priorListId?: string; currentListId?: string } | undefined,
	chatService: IInsrcChatService,
	todosService: IInsrcTodosService,
): Promise<{ priorListId: string; currentListId: string } | string> {
	if (arg?.priorListId !== undefined && arg?.currentListId !== undefined) {
		return { priorListId: arg.priorListId, currentListId: arg.currentListId };
	}

	const sessionId = chatService.activeSessionId;
	if (sessionId === undefined) {
		return 'No active chat session; run /code-analyze first.';
	}
	const candidates = todosService.lists.filter(
		l => l.sessionId === sessionId && l.owner === CODE_ANALYZER_OWNER && l.body !== undefined && l.body.length > 0,
	);
	if (candidates.length < 2) {
		return 'Need at least two completed code-analyzer reports to diff. Re-run an existing report and try again.';
	}

	// Prefer the parent-child pair when the most-recent run was a
	// re-run / drill-down; that's the natural "diff against the run
	// that produced me" shape Phase 4 is built around.
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

	// No parent edge -- fall back to the next-most-recent list as the
	// prior. This is best-effort; the daemon-side diff renderer warns
	// when the prompts differ.
	const olderCandidates = candidates.filter(l => l.id !== current.id);
	if (olderCandidates.length === 0) {
		return 'No prior run available to diff against.';
	}
	const fallback = olderCandidates[olderCandidates.length - 1]!;
	return { priorListId: fallback.id, currentListId: current.id };
}

/**
 * Save a Code Analysis report to a real file in the workspace.
 *
 * Today the synthesised markdown lives only in `list.body` (LanceDB)
 * + the Report Pane (ephemeral). Both vanish on session rotation /
 * IDE shutdown. Users want to commit findings alongside code, share
 * snapshots, or just keep a permanent record. This command writes
 * the body out to a real file under the active repo so all of those
 * become possible.
 *
 * Args (all optional):
 *   {
 *     listId?: string;   // the report list to save; defaults to the
 *                        // most-recent code-analyzer list with body.
 *   }
 *
 * Target path:
 *   <repo-root>/docs/code-analysis/<slug>-<short-listId>.md
 *
 * `<slug>` is derived from the list's `description` (the original
 * `/code-analyze` prompt). `<short-listId>` is the first 8 chars of
 * the list id -- gives the file a stable name + makes collisions
 * across re-runs of the same prompt avoidable. Existing-target
 * confirmation goes through `IDialogService.confirm`; on confirm
 * we overwrite, on cancel the command returns silently.
 *
 * Resolution of the repo root: prefer `chatService.activeRepo` (the
 * repo the analysis was run against, when still the active session
 * repo). Fall back to the workspace's first folder. Error with a
 * clear message if neither is available.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.codeAnalyzer.saveReport',
			title: localize2('insrc.codeAnalyzer.saveReport', 'Save Code Analysis Report'),
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

		// ----- Resolve list ----------------------------------------------------
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
				notifications.info('No active chat session; run /code-analyze first.');
				return;
			}
			const candidates = todosService.lists.filter(
				l => l.sessionId === sessionId && l.owner === CODE_ANALYZER_OWNER && l.body !== undefined && l.body.length > 0,
			);
			if (candidates.length === 0) {
				notifications.info('No completed code-analysis report yet for this session.');
				return;
			}
			list = candidates[candidates.length - 1];
		}
		if (list === undefined || list.body === undefined || list.body.trim().length === 0) {
			notifications.info('Save aborted -- the report has no body.');
			return;
		}

		// ----- Resolve repo root ----------------------------------------------
		const repoRoot = resolveRepoRoot(chatService, workspaceService);
		if (repoRoot === undefined) {
			notifications.info('Save aborted -- no active repo or workspace folder available.');
			return;
		}

		// ----- Build target path ----------------------------------------------
		const slug = slugFromRequest(list.description ?? list.title);
		const filename = `${slug}-${list.id.slice(0, 8)}.md`;
		const target = joinPath(repoRoot, 'docs', 'code-analysis', filename);

		// ----- Confirm overwrite if exists ------------------------------------
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
		// shared helper (rewriteCustomUrisForSave). See its docstring
		// for the trade-off (saved-file portability vs click
		// reliability) and which schemes it touches.
		const rewrittenBody = rewriteCustomUrisForSave(list.body, repoRoot);

		// ----- Write + open ----------------------------------------------------
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
 * `chatService.activeRepo` -- that's the repo the analysis was run
 * against when the run started, and it's still the active session's
 * repo unless the user rotated. Falls back to the workspace's first
 * folder when no chat session is active. Returns undefined when
 * neither is available (no folder open + no chat session).
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
