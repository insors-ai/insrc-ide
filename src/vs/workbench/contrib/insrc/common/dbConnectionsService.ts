/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Browser-side interface for daemon-backed data-driver operations
 * (plans/data-driver.md phase 3 -- tool surface).
 *
 * Phase 3 ships `list()` only; setup UX (add / edit / remove /
 * test) lands with phase 2. Every call round-trips to the daemon --
 * no local cache (matches IInsrcArtifactsService).
 */

export type DriverFamily = 'rdbms' | 'kv' | 'file';

export interface DbConnectionInfo {
	readonly id: string;
	readonly kind: string;
	readonly family: DriverFamily;
	readonly label?: string;
}

export interface IInsrcDbConnectionsService {
	readonly _serviceBrand: undefined;

	/** List every configured connection on the active repo (or an
	 *  explicit `repoRoot` for multi-repo surfaces). */
	list(opts?: { repoRoot?: string }): Promise<readonly DbConnectionInfo[]>;
}

export const IInsrcDbConnectionsService =
	createDecorator<IInsrcDbConnectionsService>('insrcDbConnectionsService');
