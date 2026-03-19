/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IInsrcDaemonService } from '../common/daemonService.js';
import { IInsrcKeychainService } from '../common/keychainService.js';

export class InsrcKeychainServiceImpl extends Disposable implements IInsrcKeychainService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async listKeys(): Promise<Array<{ name: string; masked: string }>> {
		if (!this.daemonService.isConnected) {
			return [];
		}
		return this.daemonService.rpc<Array<{ name: string; masked: string }>>('keys.list', {});
	}

	async setKey(name: string, value: string): Promise<void> {
		if (!this.daemonService.isConnected) {
			throw new Error('Not connected to daemon');
		}
		await this.daemonService.rpc('keys.set', { name, value });
		this.logService.info('[insrc-keychain] Set key:', name);
	}

	async deleteKey(name: string): Promise<void> {
		if (!this.daemonService.isConnected) {
			throw new Error('Not connected to daemon');
		}
		await this.daemonService.rpc('keys.delete', { name });
		this.logService.info('[insrc-keychain] Deleted key:', name);
	}
}
