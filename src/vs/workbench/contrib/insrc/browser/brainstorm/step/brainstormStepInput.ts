/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, type IEditorCloseHandler } from '../../../../../common/editor/editorInput.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { IDialogService, ConfirmResult } from '../../../../../../platform/dialogs/common/dialogs.js';
import { IInsrcChatService } from '../../../common/chatService.js';
import { IInsrcBrainstormSessionService } from '../../../common/brainstormSessionService.js';

/**
 * Shared base for every per-gate brainstorm editor input. Each subclass picks
 * its own scheme path so VSCode's editor group doesn't dedupe two different
 * steps as the same document. Matching is identity-on-sessionId -- we only
 * ever want one instance of a given step open per session.
 *
 * Closing the pane prompts the user first: the daemon holds in-flight state
 * for the brainstorm session, so silently closing would leave it orphaned.
 * Confirming the dialog cancels the daemon stream and ends the chat session;
 * declining it vetoes the close.
 */
export abstract class BrainstormStepInputBase extends EditorInput {
	constructor(
		readonly sessionId: string,
		@IDialogService private readonly _dialogService: IDialogService,
		@IInsrcChatService private readonly _chatService: IInsrcChatService,
		@IInsrcBrainstormSessionService private readonly _sessionService: IInsrcBrainstormSessionService,
	) {
		super();
	}

	abstract override get typeId(): string;
	abstract override getName(): string;

	/** Route path inside the `insrc-brainstorm` scheme (e.g. `/ideas`, `/themes`). */
	protected abstract get stepPath(): string;

	override get resource(): URI {
		return URI.from({ scheme: 'insrc-brainstorm', path: `${this.stepPath}/${this.sessionId}` });
	}

	override getIcon(): ThemeIcon {
		return Codicon.lightbulb;
	}

	override matches(other: unknown): boolean {
		return other instanceof BrainstormStepInputBase
			&& other.typeId === this.typeId
			&& other.sessionId === this.sessionId;
	}

	override readonly closeHandler: IEditorCloseHandler = {
		// Only prompt while the session is actually live; after the user has
		// already terminated / completed the brainstorm, closing is benign.
		showConfirm: () => this._sessionService.isSessionActive,
		confirm: async () => {
			const { confirmed } = await this._dialogService.confirm({
				type: 'warning',
				message: 'Close brainstorm and end the session?',
				detail: 'Closing this pane will cancel the in-progress brainstorm. '
					+ 'The daemon stream will be terminated and any uncommitted '
					+ 'decisions will be lost.',
				primaryButton: 'End Session',
				cancelButton: 'Keep Open',
			});
			if (!confirmed) {
				return ConfirmResult.CANCEL;
			}
			try {
				await this._chatService.cancelStream();
				await this._chatService.closeSession();
			} catch {
				// If the daemon is already gone we still want the pane to
				// close; the close handler path can't meaningfully recover
				// here, and vetoing would strand the user on a dead pane.
			}
			return ConfirmResult.DONT_SAVE;
		},
	};
}
