/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IInsrcDiffService } from '../../common/diffService.js';
import { IInsrcChatService } from '../../common/chatService.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ILogService } from '../../../../../platform/log/common/log.js';

/**
 * Registers diff-related commands and CodeLens provider.
 */
export class InsrcDiffContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.insrcDiff';

	constructor(
		@IInsrcDiffService private readonly diffService: IInsrcDiffService,
		@IInsrcChatService private readonly chatService: IInsrcChatService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._registerCommands();
		this._registerCodeLens();
		this._wireChatIntegration();
	}

	private _registerCommands(): void {
		this._register(CommandsRegistry.registerCommand('insrc.diffAccept', async (_accessor, filePath: string) => {
			await this.diffService.acceptFile(filePath);
		}));

		this._register(CommandsRegistry.registerCommand('insrc.diffReject', (_accessor, filePath: string) => {
			this.diffService.rejectFile(filePath);
		}));

		this._register(CommandsRegistry.registerCommand('insrc.diffEdit', async (_accessor, filePath: string) => {
			await this.diffService.editFile(filePath);
		}));

		this._register(CommandsRegistry.registerCommand('insrc.diffAcceptAll', async () => {
			await this.diffService.acceptAll();
		}));

		this._register(CommandsRegistry.registerCommand('insrc.diffRejectAll', () => {
			this.diffService.rejectAll();
		}));
	}

	private _registerCodeLens(): void {
		this.diffService.registerCodeLens(this.languageFeaturesService);
	}

	private _wireChatIntegration(): void {
		this._register(this.diffService.onDidAction(action => {
			this.logService.info('[insrc-diff] action:', action.type, action.filePath, action.gateId);

			const replyAction = action.type === 'accept' ? 'approve'
				: action.type === 'reject' ? 'reject'
					: 'edit';

			this.chatService.replyToGate(action.gateId, replyAction, action.feedback).catch(err => {
				this.logService.warn('[insrc-diff] Failed to send gate reply:', err);
			});
		}));
	}
}
