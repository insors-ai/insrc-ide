/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IInsrcDaemonService } from '../common/daemonService.js';
import { IInsrcLSPToolService } from '../common/lspToolService.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/**
 * Bridges LSP tool requests from the daemon to the IDE's LSP services.
 *
 * The daemon sends stream messages with type 'lsp-request' when an agent
 * needs LSP data. This contribution intercepts those messages and responds
 * via RPC.
 *
 * For now, we expose LSP data via a daemon RPC that the IDE handles:
 * the daemon calls `ide.lspTool` and the IDE responds with the result.
 * Since the current architecture doesn't support reverse RPC natively,
 * we use a polling approach: the daemon registers `ide.lspTool` as a
 * standard RPC and the tool executor calls it via the daemon's own socket.
 *
 * Alternative simpler approach: the daemon's tool executor calls the IDE
 * directly via a callback registered at session creation time.
 */
export class InsrcLSPToolBridge extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.insrcLSPToolBridge';

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@IInsrcLSPToolService private readonly lspToolService: IInsrcLSPToolService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Push diagnostic changes to daemon proactively
		this._register(this.lspToolService.onDidChangeDiagnostics(files => {
			if (!this.daemonService.isConnected) { return; }

			// Send diagnostics for changed files to daemon
			for (const file of files.slice(0, 10)) {
				this.lspToolService.getDiagnostics(file).then(diags => {
					if (diags.length > 0) {
						this.logService.debug('[insrc-lsp] diagnostics changed:', file, diags.length, 'issues');
					}
				}).catch(() => { /* ignore */ });
			}
		}));

		this.logService.info('[insrc-lsp] LSP tool bridge initialized');
	}
}
