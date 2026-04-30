/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IInsrcDaemonService } from '../../common/daemonService.js';
import {
	type AccessSnapshot,
	IInsrcAccessService,
} from '../../common/accessService.js';

/**
 * Browser-side impl of IInsrcAccessService. Round-trips to the
 * daemon's `access.snapshot` / `access.revoke` / `access.revokePrefix`
 * RPCs; no local cache (the pane refreshes on every open + after
 * each revoke).
 */
export class InsrcAccessServiceImpl extends Disposable implements IInsrcAccessService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async snapshot(sessionId: string): Promise<AccessSnapshot | undefined> {
		try {
			const result = await this.daemonService.rpc<AccessSnapshot | { error: string }>(
				'access.snapshot', { sessionId },
			);
			if (result !== null && typeof result === 'object' && 'error' in result) {
				this.logService.warn(
					`[insrc-access] snapshot rejected: ${(result as { error: string }).error}`,
				);
				return undefined;
			}
			return result;
		} catch (err) {
			this.logService.warn(`[insrc-access] snapshot failed: ${(err as Error).message}`);
			return undefined;
		}
	}

	async revoke(sessionId: string, kind: string, key: string): Promise<void> {
		const result = await this.daemonService.rpc<{ ok: true } | { error: string }>(
			'access.revoke', { sessionId, kind, key },
		);
		if (result !== null && typeof result === 'object' && 'error' in result) {
			throw new Error(`access.revoke: ${(result as { error: string }).error}`);
		}
	}

	async revokePrefix(sessionId: string, kind: string, prefix: string): Promise<void> {
		const result = await this.daemonService.rpc<{ ok: true } | { error: string }>(
			'access.revokePrefix', { sessionId, kind, prefix },
		);
		if (result !== null && typeof result === 'object' && 'error' in result) {
			throw new Error(`access.revokePrefix: ${(result as { error: string }).error}`);
		}
	}
}
