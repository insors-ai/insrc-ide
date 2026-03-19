/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { IInsrcWorkspaceService } from '../common/workspaceService.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INSRC_DIR = '.insrc';
const WORKSPACE_FILENAME = 'insrc.code-workspace';

function getWorkspaceUri(): URI {
	// Use home directory via environment
	const home = (typeof process !== 'undefined' && process.env['HOME']) || '/tmp';
	return URI.file(`${home}/${INSRC_DIR}/${WORKSPACE_FILENAME}`);
}

// ---------------------------------------------------------------------------
// InsrcWorkspaceServiceImpl
// ---------------------------------------------------------------------------

export class InsrcWorkspaceServiceImpl extends Disposable implements IInsrcWorkspaceService {
	declare readonly _serviceBrand: undefined;

	private _workspaceName = 'insrc';

	private readonly _onDidChangeFolders = this._register(new Emitter<void>());
	readonly onDidChangeFolders: Event<void> = this._onDidChangeFolders.event;

	get workspaceName(): string { return this._workspaceName; }

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Try to read workspace name from settings
		const workspace = this.contextService.getWorkspace();
		if (workspace.configuration) {
			this._readWorkspaceName(workspace.configuration);
		}
	}

	async ensureWorkspace(): Promise<URI> {
		const uri = getWorkspaceUri();

		const exists = await this.fileService.exists(uri);
		if (!exists) {
			const content = JSON.stringify({
				folders: [],
				settings: {
					'insrc.workspaceName': this._workspaceName,
				},
			}, null, '\t');

			// Ensure parent directory exists
			const parentUri = URI.file(uri.path.substring(0, uri.path.lastIndexOf('/')));
			await this.fileService.createFolder(parentUri);

			await this.fileService.writeFile(uri, VSBuffer.fromString(content));
			this.logService.info('[insrc] Created workspace file:', uri.fsPath);
		}

		return uri;
	}

	async addFolder(path: string): Promise<void> {
		const folderUri = URI.file(path);

		// Check if already a workspace folder
		const existing = this.contextService.getWorkspace().folders;
		if (existing.some(f => f.uri.fsPath === folderUri.fsPath)) {
			this.logService.info('[insrc] Folder already in workspace:', path);
			return;
		}

		await this.workspaceEditingService.addFolders([{ uri: folderUri }]);
		this._onDidChangeFolders.fire();
		this.logService.info('[insrc] Added folder to workspace:', path);
	}

	async removeFolder(path: string): Promise<void> {
		const folderUri = URI.file(path);
		await this.workspaceEditingService.removeFolders([folderUri]);
		this._onDidChangeFolders.fire();
		this.logService.info('[insrc] Removed folder from workspace:', path);
	}

	async renameWorkspace(name: string): Promise<void> {
		this._workspaceName = name;

		// Write to workspace file settings
		const uri = getWorkspaceUri();
		try {
			const content = await this.fileService.readFile(uri);
			const json = JSON.parse(content.value.toString());
			json.settings = json.settings || {};
			json.settings['insrc.workspaceName'] = name;
			await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(json, null, '\t')));
			this.logService.info('[insrc] Renamed workspace to:', name);
		} catch {
			this.logService.warn('[insrc] Failed to write workspace name to file');
		}
	}

	private async _readWorkspaceName(configUri: URI): Promise<void> {
		try {
			const content = await this.fileService.readFile(configUri);
			const json = JSON.parse(content.value.toString());
			if (json.settings?.['insrc.workspaceName']) {
				this._workspaceName = json.settings['insrc.workspaceName'];
			}
		} catch {
			// Workspace file might not exist yet
		}
	}
}
