/**
 * Provider factory -- single construction point for LLMProvider instances.
 *
 * Takes a `StepBinding` and reads everything else from the new
 * `cfg.models.providers.*` schema: host, coreModel, per-model
 * maxInputTokens, API key from `cfg.keys.*`. Callers never
 * instantiate providers directly.
 *
 * Stage 2 scope: dispatches only to Anthropic (cloud) and Ollama (local).
 * Stage 3 will add OpenAI / Gemini / Mistral branches.
 */

import type {
  AgentConfig, CloudProviderName, LLMProvider, ProviderName, StepBinding,
} from '../../shared/types.js';
import { AnthropicProvider } from './anthropic.js';
import { OllamaProvider } from './ollama.js';
import { OpenAIProvider } from './openai.js';
import { GeminiProvider } from './gemini.js';
import { MistralProvider } from './mistral.js';

export function buildProvider(binding: StepBinding, cfg: AgentConfig): LLMProvider {
  switch (binding.provider) {
    case 'local':     return buildLocal(binding, cfg);
    case 'anthropic': return buildCloud('anthropic', binding, cfg);
    case 'openai':    return buildCloud('openai', binding, cfg);
    case 'gemini':    return buildCloud('gemini', binding, cfg);
    case 'mistral':   return buildCloud('mistral', binding, cfg);
    default: {
      const unknown: never = binding.provider;
      throw new Error(`Unknown provider: ${String(unknown)}`);
    }
  }
}

function buildLocal(binding: StepBinding, cfg: AgentConfig): LLMProvider {
  const local = cfg.models.providers.local;
  const model = binding.model ?? local.coreModel;
  const params = local.params[model];
  const numCtx = params?.maxInputTokens ?? 16_384;
  return new OllamaProvider(model, local.host, numCtx);
}

function buildCloud(name: CloudProviderName, binding: StepBinding, cfg: AgentConfig): LLMProvider {
  const provider = cfg.models.providers[name];
  const model = binding.model ?? provider.default;
  if (!model) {
    throw new Error(`${name} requested but no model specified and no default configured.`);
  }
  const apiKey = cfg.keys[name];
  switch (name) {
    case 'anthropic': return new AnthropicProvider({ model, ...(apiKey ? { apiKey } : {}) });
    case 'openai':    return new OpenAIProvider({ model, ...(apiKey ? { apiKey } : {}) });
    case 'gemini':    return new GeminiProvider({ model, ...(apiKey ? { apiKey } : {}) });
    case 'mistral':   return new MistralProvider({ model, ...(apiKey ? { apiKey } : {}) });
  }
}

// Exported so callers that want to introspect can ask the factory
// "is this provider construction going to work with the current config?"
// without actually instantiating a client. Useful for the agent step
// resolver and the future UI that shows "greyed out" options.
export function providerAvailable(provider: ProviderName, cfg: AgentConfig): boolean {
  if (provider === 'local') return true;
  const cloud = cfg.models.providers[provider];
  if (!cfg.keys[provider as CloudProviderName]) return false;
  if (cloud.enabled.length === 0) return false;
  return cloud.default !== null;
}
