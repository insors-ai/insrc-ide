/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

// ---------------------------------------------------------------------------
// Types -- mirror the daemon's analyzer-pool RPC response shapes.
// ---------------------------------------------------------------------------

export type AnalyzerDbState = 'not_initialized' | 'initialized' | 'pool_open';

export interface AnalyzerDbStatus {
	readonly workspaceRoot: string;
	readonly dbPath: string;
	readonly walPath: string;
	readonly state: AnalyzerDbState;
	readonly fileSize: number;
	readonly walSize: number;
	readonly fileMtime?: string | undefined;
	readonly schemaVersion?: number | undefined;
	readonly tableRowCounts?: Readonly<Record<string, number>> | undefined;
}

export interface AnalyzerDbResetResult {
	readonly workspaceRoot: string;
	readonly dbPath: string;
	readonly walPath: string;
	readonly poolWasOpen: boolean;
	readonly dbDeleted: boolean;
	readonly walDeleted: boolean;
	readonly bytesFreed: number;
}

// ---------------------------------------------------------------------------
// IInsrcDataAnalyzerService
// ---------------------------------------------------------------------------
// Per-workspace data-analyzer DB management. Backing pool lives at
// `<workspaceRoot>/.insrc/data-analyzer.db` on the daemon side; this
// service is a thin RPC wrapper for the IDE commands.
// ---------------------------------------------------------------------------

export const IInsrcDataAnalyzerService = createDecorator<IInsrcDataAnalyzerService>('insrcDataAnalyzerService');

export interface IInsrcDataAnalyzerService {
	readonly _serviceBrand: undefined;

	/**
	 * Snapshot of the workspace's analyzer DB. Does not lazy-init the
	 * pool -- if the file isn't on disk, returns `state: 'not_initialized'`.
	 */
	status(workspaceRoot: string): Promise<AnalyzerDbStatus>;

	/**
	 * Close the workspace's analyzer pool + delete the .db / .db.wal
	 * files. The next analyzer call lazy-recreates an empty DB.
	 */
	reset(workspaceRoot: string): Promise<AnalyzerDbResetResult>;
}
