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

import type { AgentConfig, LLMProvider, ProviderName, StepBinding } from '../../shared/types.js';
import { ClaudeProvider } from './claude.js';
import { OllamaProvider } from './ollama.js';

export function buildProvider(binding: StepBinding, cfg: AgentConfig): LLMProvider {
  switch (binding.provider) {
    case 'local':    return buildLocal(binding, cfg);
    case 'anthropic':return buildAnthropic(binding, cfg);
    case 'openai':   throw new Error('OpenAI provider not yet wired (stage 3).');
    case 'gemini':   throw new Error('Gemini provider not yet wired (stage 3).');
    case 'mistral':  throw new Error('Mistral provider not yet wired (stage 3).');
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

function buildAnthropic(binding: StepBinding, cfg: AgentConfig): LLMProvider {
  const anthropic = cfg.models.providers.anthropic;
  const model = binding.model ?? anthropic.default;
  if (!model) {
    throw new Error('Anthropic requested but no model specified and no default configured.');
  }
  const apiKey = cfg.keys.anthropic;
  return new ClaudeProvider({
    model,
    ...(apiKey ? { apiKey } : {}),
  });
}

// Exported so callers that want to introspect can ask the factory
// "is this provider construction going to work with the current config?"
// without actually instantiating a client. Useful for the agent step
// resolver and the future UI that shows "greyed out" options.
export function providerAvailable(provider: ProviderName, cfg: AgentConfig): boolean {
  if (provider === 'local') return true;
  const cloud = cfg.models.providers[provider];
  if (!cfg.keys[provider]) return false;
  if (cloud.enabled.length === 0) return false;
  return cloud.default !== null;
}
