/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IInsrcDaemonService } from '../common/daemonService.js';

/**
 * Pushes `insrc.tools.*` settings to the daemon on connect and on
 * configuration changes. The daemon holds the snapshot in memory;
 * tool execution reads via `getToolSettings()`. Scoped to a single
 * responsibility so the renderer-side daemon service stays free of
 * VS Code configuration plumbing.
 */
export class InsrcToolSettingsBridge extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.insrcToolSettingsBridge';

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Push once on startup if we're already connected; otherwise
		// the state-change handler below will push on connect.
		if (this.daemonService.isConnected) {
			void this._push();
		}

		// Push whenever the daemon connects (first time and reconnects).
		this._register(this.daemonService.onDidChangeState(state => {
			if (state === 'connected') {
				void this._push();
			}
		}));

		// Push whenever any `insrc.tools.*` setting changes.
		this._register(this.configurationService.onDidChangeConfiguration(evt => {
			if (evt.affectsConfiguration('insrc.tools')) {
				void this._push();
			}
		}));
	}

	private async _push(): Promise<void> {
		if (!this.daemonService.isConnected) { return; }
		const c = this.configurationService;
		const payload: Record<string, unknown> = {
			enabledCategories: c.getValue('insrc.tools.enabledCategories'),
			'approval.defaultAction': c.getValue('insrc.tools.approval.defaultAction'),
			'approval.maxEditRounds': c.getValue('insrc.tools.approval.maxEditRounds'),
			'approval.showStructuredDiff': c.getValue('insrc.tools.approval.showStructuredDiff'),
			'loop.maxIterations': c.getValue('insrc.tools.loop.maxIterations'),
			'loop.maxNudges': c.getValue('insrc.tools.loop.maxNudges'),
			'output.inlineMaxChars': c.getValue('insrc.tools.output.inlineMaxChars'),
			'output.retainSpills': c.getValue('insrc.tools.output.retainSpills'),
			'shell.defaultTimeoutMs': c.getValue('insrc.tools.shell.defaultTimeoutMs'),
			'shell.detachedMaxRuntimeMs': c.getValue('insrc.tools.shell.detachedMaxRuntimeMs'),
			'web.braveApiKeySource': c.getValue('insrc.tools.web.braveApiKeySource'),
			'destructive.requireDoubleConfirm': c.getValue('insrc.tools.destructive.requireDoubleConfirm'),
			'notify.slack.defaultWebhookRef': c.getValue('insrc.tools.notify.slack.defaultWebhookRef'),
			'notify.teams.defaultWebhookRef': c.getValue('insrc.tools.notify.teams.defaultWebhookRef'),
			'notify.discord.defaultWebhookRef': c.getValue('insrc.tools.notify.discord.defaultWebhookRef'),
			'notify.email.smtpHost': c.getValue('insrc.tools.notify.email.smtpHost'),
			'notify.email.smtpPort': c.getValue('insrc.tools.notify.email.smtpPort'),
			'notify.email.smtpUserRef': c.getValue('insrc.tools.notify.email.smtpUserRef'),
			'notify.email.smtpPassRef': c.getValue('insrc.tools.notify.email.smtpPassRef'),
			'notify.email.fromAddress': c.getValue('insrc.tools.notify.email.fromAddress'),
		};
		try {
			await this.daemonService.rpc('tools.config.set', payload);
			this.logService.debug('[insrc-tools-settings] pushed to daemon');
		} catch (err) {
			this.logService.warn('[insrc-tools-settings] push failed:', (err as Error).message);
		}
	}
}
