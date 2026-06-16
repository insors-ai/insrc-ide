/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * TodoList reporter for runHandoff.
 *
 * Each handoff run owns one TodoList (owner = `handoff` agent
 * family). The reporter:
 *
 *   1. Creates the list up front with one TodoItem per pipeline
 *      stage (spec-assembling, spec-ready, worktree-created,
 *      spawned, agent-completed, auditing, audit-ready, final).
 *      Items start in `pending`.
 *   2. Maps every incoming HandoffEvent to the matching item and
 *      advances its status (in_progress -> completed). Earlier
 *      items on the path are auto-completed when a later one
 *      arrives -- the daemon emits stages in order, but in case a
 *      stage is skipped (handoff-error short-circuits), the items
 *      ahead of the failure get a clean `completed` state and the
 *      failure item gets `blocked`.
 *   3. At `handoff-final`: synthesises a markdown report (spec
 *      preview + agent deliverable + diff summary + audit verdict
 *      + cost snapshot if known) and writes it to `list.body` via
 *      `todos.updateListBody`. The workbench's HandoffFlowContribution
 *      watches that field flip non-empty and auto-opens the
 *      HandoffReportPane.
 *
 * The reporter never throws. Failures during item / body updates
 * are logged + swallowed -- the handoff pipeline must not be
 * blocked by todo-framework hiccups.
 *
 * Persistence shape: list.title = intent (truncated); list.description
 * = template + agent; metadata on each item carries `stage`, `kind`,
 * and the event payload. Items survive the daemon shutdown alongside
 * the list (LanceDB-backed).
 */

import type { HandoffEvent, TemplateId } from './types.js';
import type { TodosApi, AddItemOpts } from '../daemon/todos-api.js';
import type { TodoItem, TodoList, TodoItemStatus } from '../shared/todos.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('handoff:todo-reporter');

const STAGE_SEQUENCE: ReadonlyArray<{ key: string; title: string }> = [
	{ key: 'spec-assembling',  title: 'Assemble spec' },
	{ key: 'spec-ready',       title: 'Spec ready' },
	{ key: 'mode-a-gate',      title: 'Pre-flight approval' },
	{ key: 'worktree-created', title: 'Create worktree' },
	{ key: 'spawned',          title: 'Spawn agent' },
	{ key: 'agent-completed',  title: 'Agent run' },
	{ key: 'auditing',         title: 'Audit deliverable' },
	{ key: 'audit-ready',      title: 'Audit verdict' },
	{ key: 'final',            title: 'Handoff complete' },
];

const STAGE_INDEX: Readonly<Record<string, number>> = (() => {
	const m: Record<string, number> = {};
	STAGE_SEQUENCE.forEach((s, i) => { m[s.key] = i; });
	return m;
})();

export interface TodoListReporter {
	/** Apply a single HandoffEvent. Never throws. */
	handle(event: HandoffEvent): void;
	/** The list id owned by this reporter (UI hint). */
	readonly listId: string;
}

export interface StartTodoListReporterOpts {
	readonly todos:      TodosApi;
	readonly sessionId:  string;
	readonly intent:     string;
	readonly templateId: TemplateId;
	readonly agent:      string;
}

const TITLE_TRUNCATE_AT = 80;

export async function startTodoListReporter(opts: StartTodoListReporterOpts): Promise<TodoListReporter> {
	const intentTitle = opts.intent.length > TITLE_TRUNCATE_AT
		? `${opts.intent.slice(0, TITLE_TRUNCATE_AT)}...`
		: opts.intent;
	const list: TodoList = await opts.todos.createList({
		sessionId:   opts.sessionId,
		title:       `Handoff: ${intentTitle}`,
		description: `${opts.templateId} via ${opts.agent}`,
	});
	const items = new Map<string, TodoItem>();
	for (const stage of STAGE_SEQUENCE) {
		try {
			const addOpts: AddItemOpts = {
				title: stage.title,
				meta:  { stageKey: stage.key, sectionFlow: { phase: stage.key } },
			};
			const item = await opts.todos.addItem(list.id, addOpts);
			items.set(stage.key, item);
		} catch (err) {
			log.warn({ err: (err as Error).message, stage: stage.key },
				'todo reporter: failed to add stage item; reporter will skip it');
		}
	}

	// In-memory accumulators that feed the final report markdown.
	let specPreview      = '';
	let worktreePath     = '';
	let modeAGateAllowed: boolean | undefined;
	let agentSeen        = opts.agent;
	let agentExitCode:   number | undefined;
	let agentDurationMs: number | undefined;
	let auditVerdict:    'accept' | 'revise-edits' | 'revise-major' | undefined;
	let auditReason      = '';
	let editHintCount:   number | undefined;
	let machineChecks:   number | undefined;
	let diffBytes:       number | undefined;
	let diffBody         = '';
	let errorStage       = '';
	let errorMessage     = '';

	// The todos framework forbids `pending -> completed` and
	// `pending -> blocked` direct transitions; every item must
	// pass through `in_progress` first. Stages that skip the
	// in-progress phase (spec-ready arrives synchronously after
	// spec-assembling, audit-ready after auditing, etc.) need a
	// silent `markInProgress` before the terminal transition.
	const currentStatus = new Map<string, TodoItemStatus>();
	for (const k of items.keys()) { currentStatus.set(k, 'pending'); }

	const setItemStatus = async (stageKey: string, status: TodoItemStatus, blockedReason?: string): Promise<void> => {
		const item = items.get(stageKey);
		if (item === undefined) { return; }
		const cur = currentStatus.get(stageKey) ?? 'pending';
		try {
			if (status === 'in_progress') {
				if (cur === 'pending') {
					await opts.todos.markInProgress(item.id);
					currentStatus.set(stageKey, 'in_progress');
				}
				return;
			}
			if (status === 'completed') {
				if (cur === 'completed') { return; }
				if (cur === 'pending') {
					await opts.todos.markInProgress(item.id);
				}
				await opts.todos.markComplete(item.id);
				currentStatus.set(stageKey, 'completed');
				return;
			}
			if (status === 'blocked') {
				if (cur === 'blocked' || cur === 'completed') { return; }
				if (cur === 'pending') {
					await opts.todos.markInProgress(item.id);
				}
				await opts.todos.markBlocked(item.id, blockedReason ?? 'unknown');
				currentStatus.set(stageKey, 'blocked');
				return;
			}
		} catch (err) {
			log.warn({ err: (err as Error).message, stageKey, status },
				'todo reporter: status update failed; continuing');
		}
	};

	const completeUpThrough = async (stageKey: string): Promise<void> => {
		const upTo = STAGE_INDEX[stageKey];
		if (upTo === undefined) { return; }
		for (let i = 0; i < upTo; i++) {
			const k = STAGE_SEQUENCE[i]!.key;
			const it = items.get(k);
			if (it !== undefined && it.status !== 'completed') {
				await setItemStatus(k, 'completed');
			}
		}
	};

	const writeReport = async (): Promise<void> => {
		const lines: string[] = [];
		lines.push(`# Handoff: ${opts.intent}`);
		lines.push('');
		lines.push(`**Template:** ${opts.templateId}  ·  **Agent:** ${agentSeen}  ·  **Verdict:** ${auditVerdict ?? '(none)'}`);
		if (agentDurationMs !== undefined) {
			lines.push(`**Run time:** ${(agentDurationMs / 1000).toFixed(1)}s  ·  **Exit:** ${agentExitCode ?? '?'}`);
		}
		if (modeAGateAllowed === false) {
			lines.push('**Mode A gate:** rejected -- worktree not created.');
		}
		lines.push('');

		if (specPreview.length > 0) {
			lines.push('## Spec preview');
			lines.push('');
			lines.push('```');
			lines.push(specPreview.trim());
			lines.push('```');
			lines.push('');
		}

		if (errorStage.length > 0 || errorMessage.length > 0) {
			lines.push('## Failure');
			lines.push('');
			lines.push(`Stage: \`${errorStage || 'unknown'}\``);
			if (errorMessage.length > 0) {
				lines.push('');
				lines.push('```');
				lines.push(errorMessage);
				lines.push('```');
			}
			lines.push('');
		}

		if (auditVerdict !== undefined) {
			lines.push('## Audit');
			lines.push('');
			lines.push(`Verdict: **${auditVerdict}**`);
			if (auditReason.length > 0) {
				lines.push('');
				lines.push(`> ${auditReason}`);
			}
			if (editHintCount !== undefined || machineChecks !== undefined) {
				lines.push('');
				lines.push(`Edit hints: ${editHintCount ?? 0}  ·  Machine checks: ${machineChecks ?? 0}`);
			}
			lines.push('');
		}

		if (diffBody.length > 0) {
			lines.push('## Diff');
			lines.push('');
			lines.push(`Size: ${diffBytes ?? diffBody.length} bytes`);
			lines.push('');
			lines.push('```diff');
			lines.push(diffBody.length > 8000 ? `${diffBody.slice(0, 8000)}\n... (${diffBody.length - 8000} more bytes)` : diffBody);
			lines.push('```');
			lines.push('');
		} else if (diffBytes !== undefined && diffBytes > 0) {
			lines.push('## Diff');
			lines.push('');
			lines.push(`Size: ${diffBytes} bytes (body not surfaced in this report)`);
			lines.push('');
		}

		if (worktreePath.length > 0) {
			lines.push('## Worktree');
			lines.push('');
			lines.push(`\`${worktreePath}\``);
			lines.push('');
		}

		const body = lines.join('\n');
		try {
			await opts.todos.updateListBody(list.id, body);
		} catch (err) {
			log.warn({ err: (err as Error).message, listId: list.id },
				'todo reporter: updateListBody failed; report not surfaced');
		}
	};

	const apply = async (event: HandoffEvent): Promise<void> => {
		switch (event.kind) {
			case 'spec-assembling':
				await setItemStatus('spec-assembling', 'in_progress');
				return;
			case 'spec-ready':
				specPreview = event.preview;
				await setItemStatus('spec-assembling', 'completed');
				await setItemStatus('spec-ready',       'completed');
				return;
			case 'mode-a-gate-request':
				await setItemStatus('mode-a-gate', 'in_progress');
				return;
			case 'mode-a-gate-resolved':
				modeAGateAllowed = event.verdict === 'allow';
				if (event.verdict === 'allow') {
					await setItemStatus('mode-a-gate', 'completed');
				} else {
					await setItemStatus('mode-a-gate', 'blocked', event.stopReason ?? 'denied at pre-flight');
				}
				return;
			case 'worktree-created':
				worktreePath = event.worktreePath;
				await completeUpThrough('worktree-created');
				await setItemStatus('worktree-created', 'completed');
				return;
			case 'spawned':
				agentSeen = event.agent;
				await setItemStatus('spawned', 'in_progress');
				return;
			case 'agent-completed':
				agentExitCode   = event.exitCode;
				agentDurationMs = event.durationMs;
				await setItemStatus('spawned',          'completed');
				await setItemStatus('agent-completed',  'completed');
				return;
			case 'auditing':
				await setItemStatus('auditing', 'in_progress');
				return;
			case 'audit-ready':
				auditVerdict   = event.verdict;
				auditReason    = event.reason;
				editHintCount  = event.editHintCount;
				machineChecks  = event.machineCheckCount;
				diffBytes      = event.diffBytes;
				await setItemStatus('auditing',    'completed');
				await setItemStatus('audit-ready', 'completed');
				return;
			case 'handoff-final':
				auditVerdict = auditVerdict ?? event.verdict;
				diffBody     = event.diff;
				diffBytes    = diffBytes ?? event.diff.length;
				worktreePath = event.worktreePath;
				await setItemStatus('final', 'completed');
				await writeReport();
				return;
			case 'handoff-error': {
				errorStage   = event.stage;
				errorMessage = event.message;
				const blockedKey = mapErrorStageToItem(event.stage);
				if (blockedKey !== undefined) {
					await setItemStatus(blockedKey, 'blocked', event.message);
				}
				await writeReport();
				return;
			}
			default:
				// chunk events + mode-b gates don't move the stage
				// state machine; ignored here intentionally.
				return;
		}
	};

	// Serialise applications so successive events don't race each
	// other's intermediate status updates. The framework rejects
	// out-of-order transitions (`completed -> in_progress`) which
	// happens whenever event B's apply starts before event A's apply
	// has finished marking earlier items completed.
	let chain: Promise<void> = Promise.resolve();
	return {
		listId: list.id,
		handle(event: HandoffEvent): void {
			chain = chain.then(() => apply(event)).catch(err => {
				log.warn({ err: (err as Error).message, kind: event.kind },
					'todo reporter: apply rejected; swallowing');
			});
		},
	};
}

function mapErrorStageToItem(stage: string): string | undefined {
	switch (stage) {
		case 'spec-assemble': return 'spec-assembling';
		case 'worktree':      return 'worktree-created';
		case 'spawn':         return 'spawned';
		case 'audit':         return 'auditing';
		case 'diff':          return 'audit-ready';
		default:              return undefined;
	}
}
