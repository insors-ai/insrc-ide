/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2, MenuId } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IFileDialogService, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { Codicon } from '../../../../../base/common/codicons.js';

import { IInsrcRepoService } from '../../common/repoService.js';
import { IInsrcAgentRunService } from '../../common/agentRunService.js';
import { IInsrcWorkspaceService } from '../../common/workspaceService.js';
import { IInsrcDaemonService } from '../../common/daemonService.js';
import { IInsrcConfigService } from '../../common/configService.js';
import { IInsrcKeychainService } from '../../common/keychainService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { INSRC_SESSIONS_VIEW_ID, INSRC_RUNS_VIEW_ID } from './insrcViewContainer.js';

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

const INSRC_CATEGORY = localize2('insrc', 'insrc');

// ---------------------------------------------------------------------------
// Add Repository
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.addRepo',
			title: localize2('insrc.addRepo', 'Add Repository'),
			category: INSRC_CATEGORY,
			f1: true,
			icon: Codicon.add,
			menu: {
				id: MenuId.ViewTitle,
				group: 'navigation',
				when: ContextKeyExpr.equals('view', INSRC_SESSIONS_VIEW_ID),
				order: 10,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);
		const repoService = accessor.get(IInsrcRepoService);
		const notificationService = accessor.get(INotificationService);

		const folder = await fileDialogService.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			title: localize('selectRepoFolder', 'Select repository folder to add'),
		});

		if (!folder || folder.length === 0) {
			return;
		}

		try {
			await repoService.addRepo(folder[0]!.fsPath);
			notificationService.info(localize('repoAdded', 'Repository added: {0}', folder[0]!.fsPath));
		} catch (err) {
			notificationService.error(localize('repoAddFailed', 'Failed to add repository: {0}', (err as Error).message));
		}
	}
});

// ---------------------------------------------------------------------------
// Remove Repository
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.removeRepo',
			title: localize2('insrc.removeRepo', 'Remove Repository'),
			category: INSRC_CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const repoService = accessor.get(IInsrcRepoService);
		const quickInputService = accessor.get(IQuickInputService);
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);

		const repos = repoService.repos;
		if (repos.length === 0) {
			notificationService.info(localize('noReposToRemove', 'No repositories to remove.'));
			return;
		}

		const pick = await quickInputService.pick(
			repos.map(r => ({ label: r.name, description: r.path, repoPath: r.path })),
			{ placeHolder: localize('selectRepoToRemove', 'Select repository to remove') }
		);

		if (!pick) {
			return;
		}

		const confirmation = await dialogService.confirm({
			message: localize('confirmRemoveRepo', 'Remove repository "{0}"?', pick.label),
			detail: localize('confirmRemoveRepoDetail', 'This removes the repository from insrc. Source files are not deleted.'),
		});

		if (!confirmation.confirmed) {
			return;
		}

		try {
			await repoService.removeRepo((pick as { repoPath: string }).repoPath);
			notificationService.info(localize('repoRemoved', 'Repository removed: {0}', pick.label));
		} catch (err) {
			notificationService.error(localize('repoRemoveFailed', 'Failed to remove repository: {0}', (err as Error).message));
		}
	}
});

// ---------------------------------------------------------------------------
// Re-index Repository
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.reindexRepo',
			title: localize2('insrc.reindexRepo', 'Re-index Repository'),
			category: INSRC_CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const repoService = accessor.get(IInsrcRepoService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);

		const repos = repoService.repos;
		if (repos.length === 0) {
			notificationService.info(localize('noReposToReindex', 'No repositories to re-index.'));
			return;
		}

		const pick = await quickInputService.pick(
			repos.map(r => ({ label: r.name, description: `[${r.status}] ${r.path}`, repoPath: r.path })),
			{ placeHolder: localize('selectRepoToReindex', 'Select repository to re-index') }
		);

		if (!pick) {
			return;
		}

		try {
			await repoService.reindexRepo((pick as { repoPath: string }).repoPath);
			notificationService.info(localize('repoReindexing', 'Re-indexing: {0}', pick.label));
		} catch (err) {
			notificationService.error(localize('repoReindexFailed', 'Failed to re-index: {0}', (err as Error).message));
		}
	}
});

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.refreshRepos',
			title: localize2('insrc.refreshRepos', 'Refresh'),
			category: INSRC_CATEGORY,
			f1: true,
			icon: Codicon.refresh,
			menu: {
				id: MenuId.ViewTitle,
				group: 'navigation',
				when: ContextKeyExpr.equals('view', INSRC_SESSIONS_VIEW_ID),
				order: 20,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const repoService = accessor.get(IInsrcRepoService);
		await repoService.refresh();
	}
});

// ---------------------------------------------------------------------------
// Rename Workspace
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.renameWorkspace',
			title: localize2('insrc.renameWorkspace', 'Rename Workspace'),
			category: INSRC_CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const workspaceService = accessor.get(IInsrcWorkspaceService);
		const quickInputService = accessor.get(IQuickInputService);

		const name = await quickInputService.input({
			prompt: localize('enterWorkspaceName', 'Enter workspace name'),
			value: workspaceService.workspaceName,
		});

		if (name) {
			await workspaceService.renameWorkspace(name);
		}
	}
});

// ---------------------------------------------------------------------------
// Resume Agent Run
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.agentResume',
			title: localize2('insrc.agentResume', 'Resume Agent Run'),
			category: INSRC_CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const runService = accessor.get(IInsrcAgentRunService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);

		const runs = await runService.getRuns();
		const resumable = runs.filter(r => r.status === 'paused' || r.status === 'crashed');

		if (resumable.length === 0) {
			notificationService.info(localize('noRunsToResume', 'No paused or crashed runs to resume.'));
			return;
		}

		const pick = await quickInputService.pick(
			resumable.map(r => ({ label: r.id, description: `[${r.status}]${r.step ? ' ' + r.step : ''}`, runId: r.id })),
			{ placeHolder: localize('selectRunToResume', 'Select run to resume') }
		);

		if (!pick) {
			return;
		}

		try {
			await runService.resumeRun((pick as { runId: string }).runId);
			notificationService.info(localize('runResumed', 'Resumed: {0}', pick.label));
		} catch (err) {
			notificationService.error(localize('runResumeFailed', 'Failed to resume: {0}', (err as Error).message));
		}
	}
});

// ---------------------------------------------------------------------------
// Discard Agent Run
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.agentDiscard',
			title: localize2('insrc.agentDiscard', 'Discard Agent Run'),
			category: INSRC_CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const runService = accessor.get(IInsrcAgentRunService);
		const quickInputService = accessor.get(IQuickInputService);
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);

		const runs = await runService.getRuns();
		if (runs.length === 0) {
			notificationService.info(localize('noRunsToDiscard', 'No runs to discard.'));
			return;
		}

		const pick = await quickInputService.pick(
			runs.map(r => ({ label: r.id, description: `[${r.status}]${r.step ? ' ' + r.step : ''}`, runId: r.id })),
			{ placeHolder: localize('selectRunToDiscard', 'Select run to discard') }
		);

		if (!pick) {
			return;
		}

		const confirmation = await dialogService.confirm({
			message: localize('confirmDiscardRun', 'Discard run "{0}"?', pick.label),
		});

		if (!confirmation.confirmed) {
			return;
		}

		try {
			await runService.discardRun((pick as { runId: string }).runId);
			notificationService.info(localize('runDiscarded', 'Discarded: {0}', pick.label));
		} catch (err) {
			notificationService.error(localize('runDiscardFailed', 'Failed to discard: {0}', (err as Error).message));
		}
	}
});

// ---------------------------------------------------------------------------
// Set Step Provider (quick pick flow)
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.setStepProvider',
			title: localize2('insrc.setStepProvider', 'Step Provider Settings'),
			category: INSRC_CATEGORY,
			f1: true,
			icon: Codicon.settings,
			// Step Providers view was removed from the Explorer; this command
			// is now invoked from the status-bar "insrc" popup and the command
			// palette (f1). No ViewTitle menu binding.
		});
	}

	run(accessor: ServicesAccessor): void {
		const editorService = accessor.get(IEditorService);
		import('../setup/stepProviderEditorInput.js').then(({ StepProviderEditorInput }) => {
			editorService.openEditor(StepProviderEditorInput.getInstance());
		});
	}
});

// ---------------------------------------------------------------------------
// Set Step Provider (quick pick flow - legacy)
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.setStepProviderQuickPick',
			title: localize2('insrc.setStepProviderQuickPick', 'Set Step Provider (Quick Pick)'),
			category: INSRC_CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configService = accessor.get(IInsrcConfigService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);

		if (!accessor.get(IInsrcDaemonService).isConnected) {
			notificationService.warn(localize('notConnected', 'Not connected to daemon.'));
			return;
		}

		try {
			// 1. Get current config
			const config = await configService.showConfig();
			const models = config?.['models'] as Record<string, unknown> | undefined;
			const agents = (models?.['agents'] ?? {}) as Record<string, Record<string, string>>;

			// 2. Pick agent
			const agentNames = Object.keys(agents);
			if (agentNames.length === 0) {
				notificationService.info(localize('noAgents', 'No agent configurations found.'));
				return;
			}

			const agentPick = await quickInputService.pick(
				agentNames.map(name => ({
					label: name,
					description: `${Object.keys(agents[name]!).length} steps`,
				})),
				{ placeHolder: localize('selectAgent', 'Select agent') }
			);

			if (!agentPick) { return; }
			const agentName = agentPick.label;
			const steps = agents[agentName]!;

			// 3. Pick step
			const stepPick = await quickInputService.pick(
				Object.entries(steps).map(([step, provider]) => ({
					label: step,
					description: provider,
				})),
				{ placeHolder: localize('selectStep', 'Select step for {0}', agentName) }
			);

			if (!stepPick) { return; }
			const stepName = stepPick.label;

			// 4. Pick provider
			const providers = ['local', 'claude:fast', 'claude:standard', 'claude:powerful'];
			const providerPick = await quickInputService.pick(
				providers.map(p => ({
					label: p,
					description: p === stepPick.description ? '(current)' : undefined,
				})),
				{ placeHolder: localize('selectProvider', 'Select provider for {0}.{1}', agentName, stepName) }
			);

			if (!providerPick) { return; }

			// 5. Write config
			await configService.setConfigValue(
				`models.agents.${agentName}.${stepName}`,
				providerPick.label,
			);

			notificationService.info(localize('providerSet', '{0}.{1} -> {2}', agentName, stepName, providerPick.label));
		} catch (err) {
			notificationService.error(localize('setProviderFailed', 'Failed: {0}', (err as Error).message));
		}
	}
});

// ---------------------------------------------------------------------------
// Connect to Daemon
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.connectDaemon',
			title: localize2('insrc.connectDaemon', 'Connect to Daemon'),
			category: INSRC_CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const daemonService = accessor.get(IInsrcDaemonService);
		const notificationService = accessor.get(INotificationService);

		try {
			await daemonService.connect();
			notificationService.info(localize('daemonConnected', 'Connected to insrc daemon.'));
		} catch (err) {
			notificationService.error(localize('daemonConnectFailed', 'Failed to connect: {0}', (err as Error).message));
		}
	}
});

// ---------------------------------------------------------------------------
// Refresh Runs toolbar button
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.refreshRuns',
			title: localize2('insrc.refreshRuns', 'Refresh Runs'),
			category: INSRC_CATEGORY,
			f1: false,
			icon: Codicon.refresh,
			menu: {
				id: MenuId.ViewTitle,
				group: 'navigation',
				when: ContextKeyExpr.equals('view', INSRC_RUNS_VIEW_ID),
				order: 10,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Runs view will refresh on next data source call
		const repoService = accessor.get(IInsrcRepoService);
		await repoService.refresh();
	}
});

// ---------------------------------------------------------------------------
// Manage API Keys
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.manageKeys',
			title: localize2('insrc.manageKeys', 'Manage Keys'),
			category: INSRC_CATEGORY,
			f1: true,
			icon: Codicon.key,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const keychainService = accessor.get(IInsrcKeychainService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		const daemonService = accessor.get(IInsrcDaemonService);

		if (!daemonService.isConnected) {
			notificationService.warn(localize('notConnected', 'Not connected to daemon.'));
			return;
		}

		// Loop: show keys list until user cancels
		for (; ;) {
			const keys = await keychainService.listKeys();

			const items: Array<{ label: string; description?: string; action: 'add' | 'edit' | 'delete'; keyName: string }> = [
				{ label: '$(add) Add New Key', action: 'add', keyName: '', description: 'Store a new secret' },
			];

			for (const k of keys) {
				items.push({
					label: `$(key) ${k.name}`,
					description: k.masked,
					action: 'edit',
					keyName: k.name,
				});
			}

			const pick = await quickInputService.pick(items, {
				placeHolder: keys.length > 0
					? localize('selectKeyOrAdd', '{0} key(s) stored. Select to edit, or add new.', keys.length)
					: localize('noKeys', 'No keys stored. Add one.'),
			});

			if (!pick) {
				return; // user cancelled
			}

			if (pick.action === 'add') {
				// Add new key: name then value
				const name = await quickInputService.input({
					placeHolder: localize('keyNamePlaceholder', 'e.g. ANTHROPIC_API_KEY, DB_PASSWORD'),
					prompt: localize('enterKeyName', 'Key name'),
				});
				if (!name) { continue; }

				const value = await quickInputService.input({
					placeHolder: localize('enterValue', 'Enter secret value'),
					prompt: name,
					password: true,
				});
				if (value === undefined) { continue; }

				await keychainService.setKey(name, value);
				notificationService.info(localize('keyAdded', '{0} saved.', name));

			} else {
				// Existing key: edit or delete
				const action = await quickInputService.pick([
					{ label: '$(edit) Update Value', action: 'update' as const },
					{ label: '$(trash) Delete', action: 'delete' as const },
				], {
					placeHolder: pick.keyName,
				});

				if (!action) { continue; }

				if (action.action === 'update') {
					const value = await quickInputService.input({
						placeHolder: localize('enterNewValue', 'Enter new value'),
						prompt: pick.keyName,
						password: true,
					});
					if (value === undefined) { continue; }

					await keychainService.setKey(pick.keyName, value);
					notificationService.info(localize('keyUpdated', '{0} updated.', pick.keyName));
				} else {
					const confirm = await accessor.get(IDialogService).confirm({
						message: localize('confirmDelete', 'Delete key "{0}"?', pick.keyName),
					});
					if (!confirm.confirmed) { continue; }

					await keychainService.deleteKey(pick.keyName);
					notificationService.info(localize('keyDeleted', '{0} deleted.', pick.keyName));
				}
			}
		}
	}
});

// ---------------------------------------------------------------------------
// Open Chat
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.openChat',
			title: localize2('insrc.openChat', 'Open Chat'),
			category: INSRC_CATEGORY,
			f1: true,
			icon: Codicon.comment,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		await viewsService.openView('insrc.chatView', true);
	}
});

// ---------------------------------------------------------------------------
// Open Setup Wizard
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.openSetupWizard',
			title: localize2('insrc.openSetupWizard', 'Setup Wizard'),
			category: INSRC_CATEGORY,
			f1: true,
			icon: Codicon.gear,
		});
	}

	run(accessor: ServicesAccessor): void {
		const editorService = accessor.get(IEditorService);
		// Import must be static to avoid stale accessor
		import('../setup/setupWizardInput.js').then(({ SetupWizardInput }) => {
			editorService.openEditor(SetupWizardInput.getInstance());
		});
	}
});

// ---------------------------------------------------------------------------
// Open Step Provider Settings
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.openStepProviders',
			title: localize2('insrc.openStepProviders', 'Step Provider Settings'),
			category: INSRC_CATEGORY,
			f1: true,
			icon: Codicon.settingsGear,
		});
	}

	run(accessor: ServicesAccessor): void {
		const editorService = accessor.get(IEditorService);
		import('../setup/stepProviderEditorInput.js').then(({ StepProviderEditorInput }) => {
			editorService.openEditor(StepProviderEditorInput.getInstance());
		});
	}
});

// ---------------------------------------------------------------------------
// Show Daemon Logs
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.showLogs',
			title: localize2('insrc.showLogs', 'Show Daemon Logs'),
			category: INSRC_CATEGORY,
			f1: true,
			icon: Codicon.output,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const terminalService = accessor.get(ITerminalService);
		const instance = await terminalService.createTerminal({
			config: {
				name: 'insrc: Daemon Logs',
				executable: '/bin/bash',
				args: ['-c', 'cat /tmp/.insrc/daemon.log | npx pino-pretty --colorize && echo "--- following ---" && tail -f /tmp/.insrc/daemon.log | npx pino-pretty --colorize'],
			},
		});
		terminalService.setActiveInstance(instance);
		terminalService.revealActiveTerminal();
	}
});

// ---------------------------------------------------------------------------
// Toggle Permission Mode
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.togglePermissions',
			title: localize2('insrc.togglePermissions', 'Toggle Permission Mode'),
			category: INSRC_CATEGORY,
			f1: true,
			icon: Codicon.shield,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configService = accessor.get(IInsrcConfigService);
		const notificationService = accessor.get(INotificationService);

		try {
			const config = await configService.showConfig();
			const permissions = config?.['permissions'] as Record<string, unknown> | undefined;
			const currentMode = (permissions?.['mode'] as string) ?? 'validate';
			const newMode = currentMode === 'validate' ? 'auto-accept' : 'validate';

			await configService.setConfigValue('permissions.mode', newMode);
			notificationService.info(localize('permissionMode', 'Permission mode: {0}', newMode));
		} catch {
			notificationService.warn(localize('permissionFail', 'Failed to toggle permission mode.'));
		}
	}
});
