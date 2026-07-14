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

	// ---- Multi-provider model configuration ----

	/** List live models for a given provider. Cloud providers require the key
	 *  to be present in the keychain. Local queries Ollama's /api/tags. */
	listProviderModels(provider: ProviderName): Promise<{ models: ProviderModel[] }>;

	/** Quick round-trip to the provider API to confirm the key works. */
	testProviderKey(provider: ProviderName): Promise<{ ok: boolean; error?: string }>;

	/** Read the current `models` slice (keys excluded -- keychain is authoritative). */
	getProvidersConfig(): Promise<ProvidersConfigDTO>;

	/** Write a patch to the `models` slice. Daemon reloads in-memory
	 *  config after the write returns. */
	setProvidersConfig(patch: Partial<ProvidersConfigDTO>): Promise<{ ok: true; models: ProvidersConfigDTO }>;

	/** Whether the daemon considers current config usable. When unusable,
	 *  returns a `NOT_CONFIGURED` payload the IDE uses to auto-open the pane. */
	checkProvidersConfigured(): Promise<{ ok: true } | NotConfiguredPayload>;
}

// ---------------------------------------------------------------------------
// Shared DTOs (mirror insors-ai/insrc:src/daemon/providers.ts over the wire)
// ---------------------------------------------------------------------------

export type ProviderName = 'local' | 'openai' | 'anthropic' | 'gemini' | 'mistral';
export type CloudProviderName = Exclude<ProviderName, 'local'>;

export interface ProviderModel {
	id: string;
	description?: string;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	embedding?: boolean;
}

export interface ModelParams {
	maxInputTokens: number;
	maxOutputTokens: number;
}

export interface LocalProviderDTO {
	host: string;
	coreModel: string;
	embeddingModel: string;
	embeddingDim: number;
	charsPerToken: number;
	params: Record<string, ModelParams>;
}

export interface CloudProviderDTO {
	default: string | null;
	enabled: string[];
	params: Record<string, ModelParams>;
}

export interface ProvidersConfigDTO {
	activeProvider: CloudProviderName | null;
	visionDefault: { provider: ProviderName; model: string } | null;
	providers: {
		local: LocalProviderDTO;
		openai: CloudProviderDTO;
		anthropic: CloudProviderDTO;
		gemini: CloudProviderDTO;
		mistral: CloudProviderDTO;
	};
	agents?: Record<string, Record<string, string | { provider: ProviderName; model?: string }>>;
}

export interface NotConfiguredPayload {
	code: 'NOT_CONFIGURED';
	missing: 'local' | 'provider' | 'both';
	message: string;
}
