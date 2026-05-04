/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-workspace data-analyzer DB management commands.
 *
 *   - `insrc.analyzer.status` -- shows DB state (path, size, schema
 *     version, per-table row counts) in the "Insrc: Data Analyzer DB"
 *     output channel.
 *   - `insrc.analyzer.reset`  -- closes the workspace's analyzer pool
 *     and deletes the .db + .db.wal files; the next analyzer call
 *     lazy-recreates an empty DB. Confirms via modal warning.
 *
 * Backing store lives at `<workspaceRoot>/.insrc/data-analyzer.db`.
 * Workspace root is resolved IDE-side (multi-root .code-workspace
 * dirname OR first folder); the daemon RPC just receives a string
 * path -- it has no concept of VS Code's multi-root workspaces.
 */

import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { dirname } from '../../../../../base/common/resources.js';
import {
	Extensions as OutputExt,
	IOutputChannelRegistry,
	IOutputService,
} from '../../../../services/output/common/output.js';
import {
	IInsrcDataAnalyzerService,
	type AnalyzerDbStatus,
} from '../../common/dataAnalyzerService.js';

const CATEGORY = localize2('insrc', 'insrc');
const OUTPUT_CHANNEL_ID = 'insrc.dataAnalyzerDb';
const OUTPUT_CHANNEL_LABEL = 'Insrc: Data Analyzer DB';

// Register the channel once at module load so `IOutputService.getChannel`
// can resolve it later. Idempotent -- safe under HMR / repeated loads.
Registry.as<IOutputChannelRegistry>(OutputExt.OutputChannels)
	.registerChannel({ id: OUTPUT_CHANNEL_ID, label: OUTPUT_CHANNEL_LABEL, log: false });

// ---------------------------------------------------------------------------
// insrc.analyzer.status
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.analyzer.status',
			title: localize2('insrc.analyzer.status', 'Show Data Analyzer DB Status'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const workspaceService = accessor.get(IWorkspaceContextService);
		const analyzerService = accessor.get(IInsrcDataAnalyzerService);
		const outputService = accessor.get(IOutputService);
		const notifications = accessor.get(INotificationService);

		const workspaceRoot = resolveWorkspaceRoot(workspaceService);
		if (workspaceRoot === undefined) {
			notifications.info('No workspace open; cannot resolve a workspace root for the analyzer DB.');
			return;
		}

		let status: AnalyzerDbStatus;
		try {
			status = await analyzerService.status(workspaceRoot);
		} catch (err) {
			notifications.notify({
				severity: Severity.Error,
				message: `analyzer.status failed: ${err instanceof Error ? err.message : String(err)}`,
			});
			return;
		}

		const channel = outputService.getChannel(OUTPUT_CHANNEL_ID);
		if (channel === undefined) {
			notifications.info('Output channel unavailable; status reported via toast instead.');
			notifications.info(
				`Analyzer DB ${status.state}: ${status.dbPath} (${formatBytes(status.fileSize)}).`,
			);
			return;
		}

		channel.append(formatStatus(status));
		await outputService.showChannel(OUTPUT_CHANNEL_ID, /* preserveFocus */ false);
	}
});

// ---------------------------------------------------------------------------
// insrc.analyzer.reset
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.analyzer.reset',
			title: localize2('insrc.analyzer.reset', 'Reset Data Analyzer DB'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const workspaceService = accessor.get(IWorkspaceContextService);
		const analyzerService = accessor.get(IInsrcDataAnalyzerService);
		const dialogService = accessor.get(IDialogService);
		const notifications = accessor.get(INotificationService);

		const workspaceRoot = resolveWorkspaceRoot(workspaceService);
		if (workspaceRoot === undefined) {
			notifications.info('No workspace open; cannot resolve a workspace root for the analyzer DB.');
			return;
		}

		// Pre-fetch status so the confirm dialog can show what's about
		// to be deleted (size, last-write). Tolerate failure silently
		// here -- the confirm just won't include the size hint.
		let status: AnalyzerDbStatus | null;
		try {
			status = await analyzerService.status(workspaceRoot);
		} catch {
			status = null;
		}

		if (status !== null && status.state === 'not_initialized') {
			notifications.info(`Analyzer DB at ${status.dbPath} is not initialized; nothing to delete.`);
			return;
		}

		const detail = status === null
			? `${workspaceRoot}/.insrc/data-analyzer.db will be deleted.`
			: `${status.dbPath}\nSize: ${formatBytes(status.fileSize + status.walSize)}`
			+ (status.fileMtime !== undefined ? `\nLast write: ${status.fileMtime}` : '');

		const result = await dialogService.confirm({
			message: 'Reset Data Analyzer DB?',
			detail,
			primaryButton: 'Delete',
			type: 'warning',
		});
		if (!result.confirmed) {
			return;
		}

		try {
			const reset = await analyzerService.reset(workspaceRoot);
			notifications.notify({
				severity: Severity.Info,
				message: `Reset complete -- freed ${formatBytes(reset.bytesFreed)}.`
					+ (reset.poolWasOpen ? ' Pool was open and has been closed.' : ''),
			});
		} catch (err) {
			notifications.notify({
				severity: Severity.Error,
				message: `Reset failed: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve "the workspace" to a single absolute fs path.
 *
 *   - Multi-root workspaces with a `.code-workspace` file -> dirname
 *     of the .code-workspace file (so the analyzer DB lives next to
 *     the workspace file, regardless of how many folders are open).
 *   - Single-folder workspace -> that folder's fs path.
 *   - Untitled multi-root (no workspace file) -> first folder's fs
 *     path. Rare; same fallback behaviour as `resolveRepoRoot` in
 *     `dataAnalyzerCommands.ts`.
 *   - Empty workspace (no folders, no file) -> undefined; caller
 *     surfaces a notification.
 */
function resolveWorkspaceRoot(workspaceService: IWorkspaceContextService): string | undefined {
	const ws = workspaceService.getWorkspace();
	if (ws.configuration !== null && ws.configuration !== undefined) {
		return dirname(ws.configuration).fsPath;
	}
	if (ws.folders.length > 0) {
		return ws.folders[0]!.uri.fsPath;
	}
	return undefined;
}

function formatStatus(s: AnalyzerDbStatus): string {
	const lines: string[] = [];
	const ts = new Date().toISOString();
	lines.push(`[${ts}] Data Analyzer DB status`);
	lines.push(`  workspace:      ${s.workspaceRoot}`);
	lines.push(`  db path:        ${s.dbPath}`);
	lines.push(`  state:          ${s.state}`);
	lines.push(`  file size:      ${formatBytes(s.fileSize)}`);
	lines.push(`  wal size:       ${formatBytes(s.walSize)}`);
	if (s.fileMtime !== undefined) {
		lines.push(`  last write:     ${s.fileMtime}`);
	}
	if (s.schemaVersion !== undefined) {
		lines.push(`  schema version: ${s.schemaVersion}`);
	}
	if (s.tableRowCounts !== undefined) {
		const entries = Object.entries(s.tableRowCounts);
		if (entries.length === 0) {
			lines.push('  tables:         (none yet -- pool initialized but no analyzer-owned tables created)');
		} else {
			lines.push('  tables:');
			const nameWidth = Math.max(...entries.map(([n]) => n.length));
			for (const [name, count] of entries) {
				lines.push(`    ${name.padEnd(nameWidth)}  ${count.toString().padStart(8)} rows`);
			}
		}
	}
	lines.push('');
	return lines.join('\n');
}

function formatBytes(n: number): string {
	if (n === 0) {
		return '0 B';
	}
	if (n < 1024) {
		return `${n} B`;
	}
	if (n < 1024 * 1024) {
		return `${(n / 1024).toFixed(1)} KB`;
	}
	if (n < 1024 * 1024 * 1024) {
		return `${(n / 1024 / 1024).toFixed(1)} MB`;
	}
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
