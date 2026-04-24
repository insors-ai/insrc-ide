/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IInsrcDaemonService } from '../../common/daemonService.js';
import {
	type DbConnectionInfo,
	IInsrcDbConnectionsService,
} from '../../common/dbConnectionsService.js';

/**
 * Browser-side impl of IInsrcDbConnectionsService. Phase 3 surface
 * is read-only `list`; add / edit / remove / test land with the
 * phase-2 setup UX.
 */
export class InsrcDbConnectionsServiceImpl extends Disposable implements IInsrcDbConnectionsService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async list(opts: { repoRoot?: string } = {}): Promise<readonly DbConnectionInfo[]> {
		const params: Record<string, unknown> = {};
		if (opts.repoRoot !== undefined) { params['repoRoot'] = opts.repoRoot; }
		try {
			const result = await this.daemonService.rpc<readonly DbConnectionInfo[]>(
				'db.listConnections', params,
			);
			return Array.isArray(result) ? result : [];
		} catch (err) {
			this.logService.warn(
				`[insrc-db] listConnections failed: ${(err as Error).message}`,
			);
			return [];
		}
	}
}
