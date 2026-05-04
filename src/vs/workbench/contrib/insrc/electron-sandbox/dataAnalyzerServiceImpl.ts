/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IInsrcDaemonService } from '../common/daemonService.js';
import {
	IInsrcDataAnalyzerService,
	type AnalyzerDbResetResult,
	type AnalyzerDbStatus,
} from '../common/dataAnalyzerService.js';

export class InsrcDataAnalyzerServiceImpl extends Disposable implements IInsrcDataAnalyzerService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
	) {
		super();
	}

	async status(workspaceRoot: string): Promise<AnalyzerDbStatus> {
		this._assertConnected();
		const result = await this.daemonService.rpc<AnalyzerDbStatus | { error: string }>(
			'analyzer.status', { workspaceRoot },
		);
		if (result && 'error' in result) {
			throw new Error(`analyzer.status failed: ${result.error}`);
		}
		return result;
	}

	async reset(workspaceRoot: string): Promise<AnalyzerDbResetResult> {
		this._assertConnected();
		const result = await this.daemonService.rpc<AnalyzerDbResetResult | { error: string }>(
			'analyzer.reset', { workspaceRoot },
		);
		if (result && 'error' in result) {
			throw new Error(`analyzer.reset failed: ${result.error}`);
		}
		return result;
	}

	private _assertConnected(): void {
		if (!this.daemonService.isConnected) {
			throw new Error('Not connected to daemon');
		}
	}
}
