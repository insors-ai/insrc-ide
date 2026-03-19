/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { Event } from '../../../../base/common/event.js';
import type { URI } from '../../../../base/common/uri.js';

// ---------------------------------------------------------------------------
// IInsrcWorkspaceService
// ---------------------------------------------------------------------------
// Manages the insrc workspace file (~/.insrc/insrc.code-workspace).
// When a user adds/removes repos, this service keeps the workspace
// folders in sync so the native Explorer shows the right file trees.
// ---------------------------------------------------------------------------

export const IInsrcWorkspaceService = createDecorator<IInsrcWorkspaceService>('insrcWorkspaceService');

export interface IInsrcWorkspaceService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeFolders: Event<void>;

	/** Ensures ~/.insrc/insrc.code-workspace exists, creates if missing. Returns URI. */
	ensureWorkspace(): Promise<URI>;

	/** Add a folder to the workspace (Explorer + workspace file) */
	addFolder(path: string): Promise<void>;

	/** Remove a folder from the workspace (Explorer + workspace file) */
	removeFolder(path: string): Promise<void>;

	/** Get the user-visible workspace name */
	readonly workspaceName: string;

	/** Rename the workspace */
	renameWorkspace(name: string): Promise<void>;
}
