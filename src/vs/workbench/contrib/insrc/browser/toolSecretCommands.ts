/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInsrcKeychainService } from '../common/keychainService.js';

const CATEGORY = localize2('insrc', 'insrc');

/**
 * Palette commands that stash tool secrets in the OS keychain under
 * the `insrc` service. The settings.json layer carries only
 * references (account names); the actual URL / password / token
 * lives in keytar / Secret Service / Keychain depending on OS.
 */

async function promptAndStore(
	accessor: ServicesAccessor,
	opts: {
		account: string;
		promptLabel: string;
		placeHolder: string;
		password?: boolean;
		successMessage: string;
	},
): Promise<void> {
	const quickInput = accessor.get(IQuickInputService);
	const keychain = accessor.get(IInsrcKeychainService);
	const notify = accessor.get(INotificationService);

	const value = await quickInput.input({
		prompt: opts.promptLabel,
		placeHolder: opts.placeHolder,
		password: opts.password ?? true,
		ignoreFocusLost: true,
	});
	if (!value) { return; }

	try {
		await keychain.setKey(opts.account, value);
		notify.info(opts.successMessage);
	} catch (err) {
		notify.notify({
			severity: Severity.Error,
			message: `Failed to store secret under account "${opts.account}": ${(err as Error).message}`,
		});
	}
}

// ---------------------------------------------------------------------------
// Brave API key (for web:search)
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.tools.setBraveApiKey',
			title: localize2('insrc.tools.setBraveApiKey', 'Set Brave API Key (for web:search)'),
			f1: true,
			category: CATEGORY,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await promptAndStore(accessor, {
			account: 'brave',
			promptLabel: 'Brave Search API key',
			placeHolder: 'BSA... (paste your key)',
			successMessage: 'Brave API key stored. Set `insrc.tools.web.braveApiKeySource` to "keychain" to use it.',
		});
	}
});

// ---------------------------------------------------------------------------
// Notification webhooks
// ---------------------------------------------------------------------------

async function runWebhookPrompt(
	accessor: ServicesAccessor,
	target: 'slack' | 'teams' | 'discord',
): Promise<void> {
	const quickInput = accessor.get(IQuickInputService);
	const keychain = accessor.get(IInsrcKeychainService);
	const notify = accessor.get(INotificationService);

	const account = await quickInput.input({
		prompt: `Keychain account name (referenced by insrc.tools.notify.${target}.defaultWebhookRef)`,
		placeHolder: `e.g. personal-${target} or team-alerts`,
		ignoreFocusLost: true,
	});
	if (!account) { return; }
	const value = await quickInput.input({
		prompt: `${target} webhook URL`,
		placeHolder: `https://hooks.${target}.com/... (paste your webhook)`,
		password: true,
		ignoreFocusLost: true,
	});
	if (!value) { return; }

	try {
		await keychain.setKey(account, value);
		notify.info(`${target} webhook stored under account "${account}". Set insrc.tools.notify.${target}.defaultWebhookRef to "${account}" to use it.`);
	} catch (err) {
		notify.notify({
			severity: Severity.Error,
			message: `Failed to store webhook: ${(err as Error).message}`,
		});
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.tools.setSlackWebhook',
			title: localize2('insrc.tools.setSlackWebhook', 'Set Slack Webhook URL (for notify:slack)'),
			f1: true,
			category: CATEGORY,
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return runWebhookPrompt(accessor, 'slack');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.tools.setTeamsWebhook',
			title: localize2('insrc.tools.setTeamsWebhook', 'Set Teams Webhook URL (for notify:teams)'),
			f1: true,
			category: CATEGORY,
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return runWebhookPrompt(accessor, 'teams');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.tools.setDiscordWebhook',
			title: localize2('insrc.tools.setDiscordWebhook', 'Set Discord Webhook URL (for notify:discord)'),
			f1: true,
			category: CATEGORY,
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return runWebhookPrompt(accessor, 'discord');
	}
});

// ---------------------------------------------------------------------------
// SMTP credentials (for notify:email)
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.tools.setEmailSmtpCredentials',
			title: localize2('insrc.tools.setEmailSmtpCredentials', 'Set Email SMTP Credentials (for notify:email)'),
			f1: true,
			category: CATEGORY,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const keychain = accessor.get(IInsrcKeychainService);
		const notify = accessor.get(INotificationService);

		const userAccount = await quickInput.input({
			prompt: 'Keychain account name for SMTP username (insrc.tools.notify.email.smtpUserRef)',
			placeHolder: 'e.g. work-smtp-user',
			ignoreFocusLost: true,
		});
		if (!userAccount) { return; }
		const userValue = await quickInput.input({
			prompt: 'SMTP username',
			placeHolder: 'user@example.com',
			ignoreFocusLost: true,
		});
		if (!userValue) { return; }

		const passAccount = await quickInput.input({
			prompt: 'Keychain account name for SMTP password (insrc.tools.notify.email.smtpPassRef)',
			placeHolder: 'e.g. work-smtp-pass',
			ignoreFocusLost: true,
		});
		if (!passAccount) { return; }
		const passValue = await quickInput.input({
			prompt: 'SMTP password',
			password: true,
			ignoreFocusLost: true,
		});
		if (!passValue) { return; }

		try {
			await keychain.setKey(userAccount, userValue);
			await keychain.setKey(passAccount, passValue);
			notify.info(
				`SMTP credentials stored. Set insrc.tools.notify.email.smtpUserRef to "${userAccount}" and ` +
				`insrc.tools.notify.email.smtpPassRef to "${passAccount}".`,
			);
		} catch (err) {
			notify.notify({
				severity: Severity.Error,
				message: `Failed to store SMTP credentials: ${(err as Error).message}`,
			});
		}
	}
});

// ---------------------------------------------------------------------------
// Clear-all-tool-secrets (confirmation-gated)
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.tools.clearAllSecrets',
			title: localize2('insrc.tools.clearAllSecrets', 'Clear All Tool Secrets'),
			f1: true,
			category: CATEGORY,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const dialog = accessor.get(IDialogService);
		const keychain = accessor.get(IInsrcKeychainService);
		const notify = accessor.get(INotificationService);

		const keys = await keychain.listKeys();
		if (keys.length === 0) {
			notify.info('No tool secrets stored.');
			return;
		}

		const confirmation = await dialog.confirm({
			type: 'warning',
			message: `Delete all ${keys.length} secrets stored under the "insrc" keychain service?`,
			detail: keys.map(k => `  - ${k.name}`).join('\n'),
			primaryButton: 'Delete All',
		});
		if (!confirmation.confirmed) { return; }

		let deleted = 0;
		for (const key of keys) {
			try {
				await keychain.deleteKey(key.name);
				deleted += 1;
			} catch {
				// continue, count what succeeded
			}
		}
		notify.info(`Deleted ${deleted} / ${keys.length} tool secrets.`);
	}
});
