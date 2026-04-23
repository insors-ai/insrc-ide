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
import { TodosEditorInput } from './todosInput.js';

const CATEGORY = localize2('insrc', 'insrc');

/**
 * Palette command: open the Todos pane for the currently-active chat
 * session. Re-opening for the same session focuses the existing tab
 * (TodosEditorInput.matches() identity check).
 *
 * If no chat session is active the command surfaces an info notice
 * rather than opening an empty pane -- without a sessionId the pane
 * has nothing to render.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.todos.open',
			title: localize2('insrc.todos.open', 'Open Todos'),
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
			notificationService.info('No active chat session; start one first to open its todos.');
			return;
		}
		await editorService.openEditor(new TodosEditorInput(sessionId));
	}
});
