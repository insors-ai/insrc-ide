/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IInsrcChatService } from '../../common/chatService.js';
import { ArtifactsEditorInput } from './artifactsInput.js';
import { registerEphemeralEditorSerializer } from '../shared/ephemeralEditorInput.js';

const CATEGORY = localize2('insrc', 'insrc');

// Cross-restart restoration: the workbench's editor restorer calls
// this serializer to round-trip the input across IDE restarts. The
// backing 0-byte stub is on disk from the previous session, so
// deserialize() just reconstructs the input. App-lifetime
// registration; the IDisposable is intentionally discarded.
registerEphemeralEditorSerializer(
	ArtifactsEditorInput.ID,
	(instanceId) => new ArtifactsEditorInput(instanceId),
);

/**
 * Palette command: open the Artifacts pane for the currently-active
 * chat session. Re-opening focuses the existing tab.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.artifacts.open',
			title: localize2('insrc.artifacts.open', 'Open Artifacts'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const chatService = accessor.get(IInsrcChatService);
		const fileService = accessor.get(IFileService);
		const notificationService = accessor.get(INotificationService);

		const sessionId = chatService.activeSessionId;
		if (sessionId === undefined) {
			notificationService.info('No active chat session; start one first to open its artifacts.');
			return;
		}
		const input = new ArtifactsEditorInput(sessionId);
		await input.ensureBackingFile(fileService);
		await editorService.openEditor(input);
	}
});
