/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import {
	IQuickInputService,
	type IQuickPickItem,
} from '../../../../../platform/quickinput/common/quickInput.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInsrcRepoService } from '../../common/repoService.js';
import {
	type DbConnectionInfo,
	type DbConnectionInput,
	type DriverFamily,
	type DriverKindInfo,
	IInsrcDbConnectionsService,
} from '../../common/dbConnectionsService.js';

/**
 * Four palette commands for managing data-source connections
 * (plans/data-driver.md phase 2.1):
 *
 *   - insrc.addDbConnection
 *   - insrc.editDbConnection
 *   - insrc.removeDbConnection
 *   - insrc.testDbConnection
 *
 * All flows default to the active repo when only one is registered;
 * prompt for a repo otherwise. URLs are submitted as plaintext --
 * the daemon redacts the password into the OS keychain before
 * persistence.
 */

const CATEGORY = localize2('insrc', 'insrc');

interface RepoPickItem extends IQuickPickItem {
	readonly path: string;
}

interface KindPickItem extends IQuickPickItem {
	readonly kind: string;
	readonly family: DriverFamily;
}

interface ConnectionPickItem extends IQuickPickItem {
	readonly conn: DbConnectionInfo;
}

// ---------------------------------------------------------------------------
// Common helpers
// ---------------------------------------------------------------------------

async function pickRepo(
	accessor: ServicesAccessor,
	placeholder: string,
): Promise<string | undefined> {
	const repoService = accessor.get(IInsrcRepoService);
	const quickInput = accessor.get(IQuickInputService);
	const repos = repoService.repos;
	if (repos.length === 0) {
		accessor.get(INotificationService).notify({
			severity: Severity.Warning,
			message: 'No repos registered. Add one via "Add Repository" first.',
		});
		return undefined;
	}
	if (repos.length === 1) { return repos[0].path; }
	const items: RepoPickItem[] = repos.map(r => ({
		path: r.path,
		label: r.name,
		description: r.path,
	}));
	const picked = await quickInput.pick(items, { placeHolder: placeholder });
	return picked?.path;
}

async function pickKind(
	accessor: ServicesAccessor,
	placeholder: string,
): Promise<DriverKindInfo | undefined> {
	const dbService = accessor.get(IInsrcDbConnectionsService);
	const quickInput = accessor.get(IQuickInputService);
	const kinds = await dbService.listDriverKinds();
	if (kinds.length === 0) {
		accessor.get(INotificationService).error('No drivers registered on the daemon.');
		return undefined;
	}
	const items: KindPickItem[] = kinds.map(k => ({
		kind: k.kind,
		family: k.family,
		label: k.kind,
		description: k.family,
	}));
	const picked = await quickInput.pick(items, { placeHolder: placeholder });
	if (picked === undefined) { return undefined; }
	return { kind: picked.kind, family: picked.family };
}

async function preloadConnection(
	accessor: ServicesAccessor,
	repoRoot: string,
	id: string,
): Promise<DbConnectionInfo | undefined> {
	const dbService = accessor.get(IInsrcDbConnectionsService);
	const conns = await dbService.list({ repoRoot });
	const match = conns.find(c => c.id === id);
	if (match === undefined) {
		accessor.get(INotificationService).error(
			`Connection '${id}' is not configured for this repo.`,
		);
		return undefined;
	}
	return match;
}

async function pickConnection(
	accessor: ServicesAccessor,
	repoRoot: string,
	placeholder: string,
): Promise<DbConnectionInfo | undefined> {
	const dbService = accessor.get(IInsrcDbConnectionsService);
	const quickInput = accessor.get(IQuickInputService);
	const conns = await dbService.list({ repoRoot });
	if (conns.length === 0) {
		accessor.get(INotificationService).notify({
			severity: Severity.Info,
			message: 'No connections configured for this repo. Use "Add DB Connection" first.',
		});
		return undefined;
	}
	const items: ConnectionPickItem[] = conns.map(c => ({
		conn: c,
		label: c.id,
		description: `${c.kind} (${c.family})`,
		detail: c.label,
	}));
	const picked = await quickInput.pick(items, { placeHolder: placeholder });
	return picked?.conn;
}

async function promptInput(
	accessor: ServicesAccessor,
	prompt: string,
	value?: string,
	password?: boolean,
): Promise<string | undefined> {
	const quickInput = accessor.get(IQuickInputService);
	const opts: { prompt: string; value?: string; password?: boolean } = { prompt };
	if (value !== undefined) { opts.value = value; }
	if (password === true) { opts.password = true; }
	return quickInput.input(opts);
}

async function buildConnectionInput(
	accessor: ServicesAccessor,
	driver: DriverKindInfo,
	id: string,
	existing?: DbConnectionInfo,
): Promise<DbConnectionInput | undefined> {
	if (driver.family === 'file') {
		const path = await promptInput(
			accessor,
			`Repo-relative path to the ${driver.kind} file (e.g. data/orders.${driver.kind})`,
			existing?.label !== undefined ? '' : undefined,
		);
		if (path === undefined || path === '') { return undefined; }
		const label = await promptInput(accessor, 'Label (optional)', existing?.label);
		const out: { -readonly [K in keyof DbConnectionInput]: DbConnectionInput[K] } = {
			id,
			kind: driver.kind,
			family: 'file',
			path,
		};
		if (label !== undefined && label !== '') { out.label = label; }
		return out;
	}
	const url = await promptInput(
		accessor,
		`Connection URL for ${driver.kind} (e.g. ${urlExampleFor(driver.kind)})`,
	);
	if (url === undefined || url === '') { return undefined; }
	const label = await promptInput(accessor, 'Label (optional)', existing?.label);
	const out: { -readonly [K in keyof DbConnectionInput]: DbConnectionInput[K] } = {
		id,
		kind: driver.kind,
		family: driver.family,
		url,
	};
	if (label !== undefined && label !== '') { out.label = label; }
	return out;
}

function urlExampleFor(kind: string): string {
	switch (kind) {
		case 'postgres': return 'postgres://user:pass@localhost:5432/db';
		case 'mysql':
		case 'mariadb': return 'mysql://user:pass@localhost:3306/db';
		case 'sqlite': return 'file:///abs/path/to/app.sqlite';
		case 'mssql': return 'mssql://user:pass@localhost:1433/db';
		case 'oracle': return 'oracle://user:pass@host:1521/service';
		case 'redis':
		case 'valkey':
		case 'keydb': return 'redis://localhost:6379';
		case 'mongodb': return 'mongodb://user:pass@localhost:27017/db';
		default: return '<protocol>://user:pass@host:port/path';
	}
}

// ---------------------------------------------------------------------------
// insrc.addDbConnection
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.addDbConnection',
			title: localize2('insrc.addDbConnection', 'Add DB Connection'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor, args?: { repoRoot?: string }): Promise<void> {
		const repoRoot = args?.repoRoot
			?? await pickRepo(accessor, 'Add a connection on which repo?');
		if (repoRoot === undefined) { return; }

		const driver = await pickKind(accessor, 'Driver kind (postgres, redis, csv, ...)');
		if (driver === undefined) { return; }

		const id = await promptInput(accessor, 'Connection id (unique within the repo, e.g. "primary")');
		if (id === undefined || id === '') { return; }

		const config = await buildConnectionInput(accessor, driver, id);
		if (config === undefined) { return; }

		const dbService = accessor.get(IInsrcDbConnectionsService);
		const notif = accessor.get(INotificationService);
		try {
			const result = await dbService.save({ repoRoot, config });
			notif.notify({
				severity: Severity.Info,
				message: `Connection '${result.id}' added (${result.family}). Wrote ${result.wrotePath}.`,
			});
		} catch (err) {
			notif.error(`Add connection failed: ${(err as Error).message}`);
		}
	}
});

// ---------------------------------------------------------------------------
// insrc.editDbConnection
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.editDbConnection',
			title: localize2('insrc.editDbConnection', 'Edit DB Connection'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor, args?: { repoRoot?: string; id?: string }): Promise<void> {
		const repoRoot = args?.repoRoot
			?? await pickRepo(accessor, 'Edit a connection on which repo?');
		if (repoRoot === undefined) { return; }

		const conn = args?.id !== undefined
			? await preloadConnection(accessor, repoRoot, args.id)
			: await pickConnection(accessor, repoRoot, 'Connection to edit');
		if (conn === undefined) { return; }

		const driver: DriverKindInfo = { kind: conn.kind, family: conn.family };
		const config = await buildConnectionInput(accessor, driver, conn.id, conn);
		if (config === undefined) { return; }

		const dbService = accessor.get(IInsrcDbConnectionsService);
		const notif = accessor.get(INotificationService);
		try {
			const result = await dbService.save({ repoRoot, config });
			notif.notify({
				severity: Severity.Info,
				message: `Connection '${result.id}' updated (${result.family}).`,
			});
		} catch (err) {
			notif.error(`Edit connection failed: ${(err as Error).message}`);
		}
	}
});

// ---------------------------------------------------------------------------
// insrc.removeDbConnection
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.removeDbConnection',
			title: localize2('insrc.removeDbConnection', 'Remove DB Connection'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor, args?: { repoRoot?: string; id?: string }): Promise<void> {
		const repoRoot = args?.repoRoot
			?? await pickRepo(accessor, 'Remove a connection on which repo?');
		if (repoRoot === undefined) { return; }

		const conn = args?.id !== undefined
			? await preloadConnection(accessor, repoRoot, args.id)
			: await pickConnection(accessor, repoRoot, 'Connection to remove');
		if (conn === undefined) { return; }

		const dialog = accessor.get(IDialogService);
		const confirmation = await dialog.confirm({
			message: `Remove connection '${conn.id}' from this repo?`,
			detail: `Kind: ${conn.kind} (${conn.family})${conn.label !== undefined ? ` -- ${conn.label}` : ''}\n\n` +
				'The connection JSON entry + its keychain secret will be deleted.',
			primaryButton: 'Remove',
			type: 'warning',
		});
		if (!confirmation.confirmed) { return; }

		const dbService = accessor.get(IInsrcDbConnectionsService);
		const notif = accessor.get(INotificationService);
		try {
			const result = await dbService.remove({ repoRoot, id: conn.id });
			if (result.removed) {
				notif.notify({
					severity: Severity.Info,
					message: `Connection '${conn.id}' removed.`,
				});
			} else {
				notif.notify({
					severity: Severity.Info,
					message: `Connection '${conn.id}' was already gone.`,
				});
			}
		} catch (err) {
			notif.error(`Remove connection failed: ${(err as Error).message}`);
		}
	}
});

// ---------------------------------------------------------------------------
// insrc.testDbConnection
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.testDbConnection',
			title: localize2('insrc.testDbConnection', 'Test DB Connection'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor, args?: { repoRoot?: string; id?: string }): Promise<void> {
		const repoRoot = args?.repoRoot
			?? await pickRepo(accessor, 'Test a connection on which repo?');
		if (repoRoot === undefined) { return; }

		const conn = args?.id !== undefined
			? await preloadConnection(accessor, repoRoot, args.id)
			: await pickConnection(accessor, repoRoot, 'Connection to test');
		if (conn === undefined) { return; }

		// Palette flow tests the *persisted* connection. The summary we
		// have lacks url/path; the daemon's test handler hydrates from
		// db-connections.json by id when those fields are absent.
		const dbService = accessor.get(IInsrcDbConnectionsService);
		const notif = accessor.get(INotificationService);
		try {
			const result = await dbService.test({
				repoRoot,
				config: {
					id: conn.id,
					kind: conn.kind,
					family: conn.family,
				},
			});
			if (result.ok) {
				notif.notify({
					severity: Severity.Info,
					message: `Connection '${conn.id}' OK (${result.family}, ${result.tookMs} ms).`,
				});
			} else {
				notif.notify({
					severity: Severity.Error,
					message: `Connection '${conn.id}' failed: ${result.error}`,
				});
			}
		} catch (err) {
			notif.error(`Test connection failed: ${(err as Error).message}`);
		}
	}
});
