/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IInsrcDaemonService } from '../common/daemonService.js';
import { IInsrcAgentRunService, type AgentRunInfo } from '../common/agentRunService.js';

// ---------------------------------------------------------------------------
// AgentRunServiceImpl
// ---------------------------------------------------------------------------

export class InsrcAgentRunServiceImpl extends Disposable implements IInsrcAgentRunService {
	declare readonly _serviceBrand: undefined;

	private _cachedRuns: AgentRunInfo[] = [];

	private readonly _onDidChangeRuns = this._register(new Emitter<void>());
	readonly onDidChangeRuns: Event<void> = this._onDidChangeRuns.event;

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async getRuns(repoPath?: string): Promise<readonly AgentRunInfo[]> {
		if (!this.daemonService.isConnected) {
			return [];
		}

		try {
			const runs = await this.daemonService.rpc<AgentRunInfo[]>('agent.list');
			this._cachedRuns = runs ?? [];
		} catch (err) {
			this.logService.warn('[insrc] Failed to list agent runs:', (err as Error).message);
		}

		if (repoPath) {
			return this._cachedRuns.filter(r => r.repo === repoPath);
		}
		return this._cachedRuns;
	}

	async resumeRun(runId: string): Promise<void> {
		if (!this.daemonService.isConnected) {
			throw new Error('Not connected to daemon');
		}

		await this.daemonService.rpc('agent.resume', { id: runId });
		this._onDidChangeRuns.fire();
		this.logService.info('[insrc] Resumed agent run:', runId);
	}

	async discardRun(runId: string): Promise<void> {
		if (!this.daemonService.isConnected) {
			throw new Error('Not connected to daemon');
		}

		await this.daemonService.rpc('agent.discard', { id: runId });

		// Remove from cache
		this._cachedRuns = this._cachedRuns.filter(r => r.id !== runId);
		this._onDidChangeRuns.fire();
		this.logService.info('[insrc] Discarded agent run:', runId);
	}
}
