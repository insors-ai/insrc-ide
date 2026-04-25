/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IInsrcDaemonService } from '../../common/daemonService.js';
import {
	type DbConnectionInfo,
	type DbConnectionInput,
	type DeleteConnectionResult,
	type DriverKindInfo,
	IInsrcDbConnectionsService,
	type SaveConnectionResult,
	type TestConnectionResult,
} from '../../common/dbConnectionsService.js';

/**
 * Browser-side impl of IInsrcDbConnectionsService. Every method
 * round-trips to the daemon; no local cache.
 */
export class InsrcDbConnectionsServiceImpl extends Disposable implements IInsrcDbConnectionsService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async list(opts: { readonly repoRoot: string }): Promise<readonly DbConnectionInfo[]> {
		try {
			const result = await this.daemonService.rpc<readonly DbConnectionInfo[]>(
				'db.listConnections', { repoRoot: opts.repoRoot },
			);
			return Array.isArray(result) ? result : [];
		} catch (err) {
			this.logService.warn(
				`[insrc-db] listConnections failed: ${(err as Error).message}`,
			);
			return [];
		}
	}

	async listDriverKinds(): Promise<readonly DriverKindInfo[]> {
		try {
			const result = await this.daemonService.rpc<readonly DriverKindInfo[]>(
				'db.listDriverKinds', {},
			);
			return Array.isArray(result) ? result : [];
		} catch (err) {
			this.logService.warn(
				`[insrc-db] listDriverKinds failed: ${(err as Error).message}`,
			);
			return [];
		}
	}

	async save(opts: {
		readonly repoRoot: string;
		readonly config: DbConnectionInput;
	}): Promise<SaveConnectionResult> {
		const result = await this.daemonService.rpc<SaveConnectionResult | { error: string }>(
			'db.saveConnection', { repoRoot: opts.repoRoot, config: opts.config },
		);
		if (result !== null && typeof result === 'object' && 'error' in result) {
			throw new Error(`db.saveConnection: ${(result as { error: string }).error}`);
		}
		return result;
	}

	async remove(opts: {
		readonly repoRoot: string;
		readonly id: string;
	}): Promise<DeleteConnectionResult> {
		const result = await this.daemonService.rpc<DeleteConnectionResult | { error: string }>(
			'db.deleteConnection', { repoRoot: opts.repoRoot, id: opts.id },
		);
		if (result !== null && typeof result === 'object' && 'error' in result) {
			throw new Error(`db.deleteConnection: ${(result as { error: string }).error}`);
		}
		return result;
	}

	async test(opts: {
		readonly repoRoot: string;
		readonly config: DbConnectionInput;
	}): Promise<TestConnectionResult> {
		const result = await this.daemonService.rpc<TestConnectionResult | { error: string }>(
			'db.testConnection', { repoRoot: opts.repoRoot, config: opts.config },
		);
		if (result !== null && typeof result === 'object' && 'error' in result && !('ok' in result)) {
			throw new Error(`db.testConnection: ${(result as { error: string }).error}`);
		}
		return result as TestConnectionResult;
	}
}
