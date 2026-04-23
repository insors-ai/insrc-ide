/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IInsrcChatService } from '../../common/chatService.js';
import { NotepadTodosEditorInput } from './notepadTodosInput.js';

const CATEGORY = localize2('insrc', 'insrc');

/**
 * Palette command: open the notepad's "My TODOs" pane for the active
 * chat session. User-owned lists (plans/todo-framework.md Phase 9)
 * live here; the agent todos pane is read-only and covers agent-owned
 * lists.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.notepad.openTodos',
			title: localize2('insrc.notepad.openTodos', 'Open My TODOs'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const chatService = accessor.get(IInsrcChatService);
		const notificationService = accessor.get(INotificationService);

		const sessionId = chatService.activeSessionId;
		if (sessionId === undefined) {
			notificationService.info('No active chat session; start one first -- user TODOs are session-scoped.');
			return;
		}
		await editorService.openEditor(new NotepadTodosEditorInput(sessionId));
	}
});
