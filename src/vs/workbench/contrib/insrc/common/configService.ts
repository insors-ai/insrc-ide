/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { Event } from '../../../../base/common/event.js';

export const IInsrcConfigService = createDecorator<IInsrcConfigService>('insrcConfigService');

export interface IInsrcConfigService {
	readonly _serviceBrand: undefined;

	/** Fires after config is changed (setConfigValue or reloadConfig) */
	readonly onDidChangeConfig: Event<void>;

	/** Read full config.json from daemon */
	showConfig(): Promise<Record<string, unknown>>;

	/** Write a single value at a dotted path (e.g. 'models.agents.pair.propose') */
	setConfigValue(path: string, value: unknown): Promise<void>;

	/** Hot-reload config into active sessions */
	reloadConfig(): Promise<void>;

	/** Get system info (CPU, RAM, GPU, OS) */
	getSystemInfo(): Promise<Record<string, unknown>>;

	/** Get hardware-optimized model recommendation */
	getRecommendation(): Promise<Record<string, unknown>>;

	/** List installed Ollama models */
	listOllamaModels(): Promise<Array<{ name: string; size: number; parameterSize?: string; quantization?: string; family?: string }>>;

	/** Search Ollama model library */
	searchOllamaModels(query: string): Promise<Array<Record<string, unknown>>>;

	/** List available Claude models (API or static fallback) */
	listClaudeModels(): Promise<Array<{ id: string; displayName: string; createdAt: string }>>;

	/** Get all agent step bindings (defaults + config overrides) */
	getAgentBindings(): Promise<Record<string, Record<string, string>>>;
}
