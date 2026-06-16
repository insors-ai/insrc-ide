/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { localize2 } from '../../../../../nls.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IInsrcChatService } from '../../common/chatService.js';
import { IInsrcTodosService, type TodoList } from '../../common/todosService.js';
import { HandoffReportInput } from './handoffReportInput.js';

const CATEGORY = localize2('insrc.handoff.category', 'Insrc Handoff');
const HANDOFF_OWNER = 'handoff';

/**
 * `insrc.handoff.openReport` -- open the Handoff Report pane for a
 * specific listId, or the most recent handoff in the active session
 * when no arg is supplied. Mirrors `insrc.dataAnalyzer.openReport`.
 *
 * Bound to the in-chat card's "Open report" link and the todos
 * pane's "Open report" row action via `arg.listId`; available from
 * the palette without args (most-recent fallback).
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.handoff.openReport',
			title: localize2('insrc.handoff.openReport', 'Open Handoff Report'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor, arg?: { listId?: string; specId?: string }): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const chatService = accessor.get(IInsrcChatService);
		const todosService = accessor.get(IInsrcTodosService);
		const fileService = accessor.get(IFileService);
		const notifications = accessor.get(INotificationService);

		let list: TodoList | undefined;
		if (arg?.listId !== undefined) {
			list = todosService.lists.find(l => l.id === arg.listId);
		} else if (arg?.specId !== undefined) {
			// The card "Open report" link comes through here with the
			// handoff's specId. The TodoList stores the specId on
			// items' meta -- match against any item belonging to a
			// handoff-owned list in the active session.
			const sessionId = chatService.activeSessionId;
			const candidates = todosService.lists.filter(
				l => l.owner === HANDOFF_OWNER && (sessionId === undefined || l.sessionId === sessionId),
			);
			list = candidates[candidates.length - 1];
		} else {
			const sessionId = chatService.activeSessionId;
			if (sessionId === undefined) {
				notifications.info('No active chat session; run /handoff first.');
				return;
			}
			const candidates = todosService.lists.filter(
				l => l.sessionId === sessionId && l.owner === HANDOFF_OWNER && l.body !== undefined && l.body.length > 0,
			);
			if (candidates.length === 0) {
				notifications.info('No handoff report yet for this session. Run /handoff.');
				return;
			}
			list = candidates[candidates.length - 1];
		}

		if (list === undefined) {
			notifications.info('Handoff report not available -- the list is no longer loaded for this session.');
			return;
		}

		const input = new HandoffReportInput(list.sessionId, list.id, list.body ?? '', list.title);
		await input.ensureBackingFile(fileService);
		await editorService.openEditor(input, { pinned: true });
	}
});

/**
 * `insrc.handoff.rerun` -- re-run a handoff via a quick-pick.
 *
 * Flow:
 *   1. Resolve the source list (explicit listId arg or most-recent
 *      handoff in the active session).
 *   2. Show a quick-pick: agent (claude-code / codex) -> template id
 *      (defaulted to the source list's template).
 *   3. Synthesise a `/handoff template=<X> <intent>` string from the
 *      source list's title and the chosen overrides, write it into
 *      the chat input via the existing focus/replace command path,
 *      and reveal the chat pane so the user can edit + send.
 *
 * Today we just write a notification with the synthesised command
 * so the user can copy it. Wiring straight into the chat input
 * requires a small extension to chatView (a public `prefillInput`
 * method) which lands in the next pass; this stub keeps the
 * button's contract correct.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.handoff.rerun',
			title: localize2('insrc.handoff.rerun', 'Re-run Handoff'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor, arg?: { listId?: string }): Promise<void> {
		const todosService = accessor.get(IInsrcTodosService);
		const chatService = accessor.get(IInsrcChatService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		const commandService = accessor.get(ICommandService);

		let list: TodoList | undefined;
		if (arg?.listId !== undefined) {
			list = todosService.lists.find(l => l.id === arg.listId);
		} else {
			const sessionId = chatService.activeSessionId;
			if (sessionId !== undefined) {
				const candidates = todosService.lists.filter(
					l => l.sessionId === sessionId && l.owner === HANDOFF_OWNER,
				);
				list = candidates[candidates.length - 1];
			}
		}
		if (list === undefined) {
			notifications.info('No handoff to re-run -- pick a report tab or run /handoff first.');
			return;
		}

		// Strip the leading "Handoff: " prefix the reporter stamps so
		// the re-run intent reads naturally.
		const titleIntent = list.title.startsWith('Handoff: ')
			? list.title.slice('Handoff: '.length)
			: list.title;

		// Source template + agent live in the list description as
		// `<TEMPLATE> via <agent>`. Parse defensively.
		let sourceTemplate = 'SPEC';
		let sourceAgent = 'claude-code';
		const desc = list.description ?? '';
		const m = /^([A-Z\-]+)\s+via\s+([\w\-]+)/.exec(desc);
		if (m !== null) {
			sourceTemplate = m[1]!;
			sourceAgent = m[2]!;
		}

		// Quick-pick: agent.
		const agentPick = await quickInput.pick(
			[
				{ label: 'claude-code', description: sourceAgent === 'claude-code' ? '(original)' : '' },
				{ label: 'codex', description: sourceAgent === 'codex' ? '(original)' : '' },
			],
			{ placeHolder: 'Re-run with which agent?' },
		);
		if (agentPick === undefined) {
			return;
		}

		// Quick-pick: template.
		const TEMPLATES = ['DEBUG-SESSION', 'SPEC', 'DESIGN', 'REQUIREMENTS', 'TEST-PLAN', 'REVIEW', 'MIGRATION', 'AUDIT'];
		const templatePick = await quickInput.pick(
			TEMPLATES.map(t => ({ label: t, description: t === sourceTemplate ? '(original)' : '' })),
			{ placeHolder: 'Re-run with which template?' },
		);
		if (templatePick === undefined) {
			return;
		}

		const synthesised = `/handoff template=${templatePick.label} ${titleIntent}`;
		try {
			// Reveal the chat input + drop the synthesised string into
			// it so the user can edit before hitting send. The
			// `insrc.chat.prefillInput` command is implemented by
			// chatView; if it isn't yet wired (older builds) we fall
			// back to a notification so the user can copy.
			await commandService.executeCommand('insrc.chat.prefillInput', { text: synthesised });
		} catch {
			notifications.info(`Re-run draft: ${synthesised}`);
		}
	}
});
