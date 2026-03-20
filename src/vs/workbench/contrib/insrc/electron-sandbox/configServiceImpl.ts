/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IInsrcDaemonService } from '../common/daemonService.js';
import { IInsrcConfigService } from '../common/configService.js';

export class InsrcConfigServiceImpl extends Disposable implements IInsrcConfigService {
	declare readonly _serviceBrand: undefined;

	private _cachedConfig: Record<string, unknown> | undefined;

	private readonly _onDidChangeConfig = this._register(new Emitter<void>());
	readonly onDidChangeConfig: Event<void> = this._onDidChangeConfig.event;

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async showConfig(): Promise<Record<string, unknown>> {
		if (this._cachedConfig) {
			return this._cachedConfig;
		}
		if (!this.daemonService.isConnected) {
			return {};
		}
		const result = await this.daemonService.rpc<Record<string, unknown>>('config.show', {});
		this._cachedConfig = result;
		return result;
	}

	async setConfigValue(path: string, value: unknown): Promise<void> {
		if (!this.daemonService.isConnected) {
			throw new Error('Not connected to daemon');
		}
		await this.daemonService.rpc('config.write', { path, value });
		this._cachedConfig = undefined;
		this._onDidChangeConfig.fire();
		this.logService.info('[insrc-config] Set', path);
	}

	async reloadConfig(): Promise<void> {
		if (!this.daemonService.isConnected) {
			return;
		}
		await this.daemonService.rpc('config.reload', {});
		this._cachedConfig = undefined;
		this._onDidChangeConfig.fire();
		this.logService.info('[insrc-config] Reloaded');
	}

	async getSystemInfo(): Promise<Record<string, unknown>> {
		if (!this.daemonService.isConnected) {
			return {};
		}
		return this.daemonService.rpc<Record<string, unknown>>('system.info', {});
	}

	async getRecommendation(): Promise<Record<string, unknown>> {
		if (!this.daemonService.isConnected) {
			return {};
		}
		return this.daemonService.rpc<Record<string, unknown>>('system.recommend', {});
	}

	async listOllamaModels(): Promise<Array<{ name: string; size: number; parameterSize?: string; quantization?: string; family?: string }>> {
		if (!this.daemonService.isConnected) {
			return [];
		}
		return this.daemonService.rpc('ollama.list', {});
	}

	async searchOllamaModels(query: string): Promise<Array<Record<string, unknown>>> {
		if (!this.daemonService.isConnected) {
			return [];
		}
		return this.daemonService.rpc('ollama.search', { query });
	}

	async listClaudeModels(): Promise<Array<{ id: string; displayName: string; createdAt: string }>> {
		if (!this.daemonService.isConnected) {
			return [];
		}
		return this.daemonService.rpc('claude.models', {});
	}
}
