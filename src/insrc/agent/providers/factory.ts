/**
 * Provider factory -- single construction point for LLMProvider instances.
 *
 * Stage 1 scope: wraps the existing Claude/Ollama constructors so every
 * call site can go through this module. No behavior change yet.
 *
 * Stage 2 will repoint this at the new `cfg.models.providers.*` schema
 * and add OpenAI/Gemini/Mistral dispatch.
 */

import type { AgentConfig, LLMProvider, StepBinding } from '../../shared/types.js';
import { ClaudeProvider } from './claude.js';
import { OllamaProvider } from './ollama.js';

/**
 * Build an `LLMProvider` from a `StepBinding` and the agent config.
 *
 * For `provider: 'local'`:
 *   - model:  `binding.model` or `cfg.models.local`
 *   - host:   `cfg.ollama.host`
 *   - numCtx: `cfg.models.context.local`
 *
 * For `provider: 'claude'`:
 *   - model:  `binding.model`, or `cfg.models.tiers[binding.tier]`,
 *             or `cfg.models.tiers.standard`
 *   - apiKey: `cfg.keys.anthropic`
 *   (No-op if no api key -- caller is expected to check availability
 *    before invoking.)
 */
export function buildProvider(binding: StepBinding, cfg: AgentConfig): LLMProvider {
  if (binding.provider === 'local') {
    const model = binding.model ?? cfg.models.local;
    return new OllamaProvider(model, cfg.ollama.host, cfg.models.context.local);
  }

  if (binding.provider === 'claude') {
    const model = resolveClaudeModel(binding, cfg);
    const apiKey = cfg.keys.anthropic;
    return new ClaudeProvider({
      model,
      ...(apiKey ? { apiKey } : {}),
    });
  }

  // Future-proof: exhaustiveness guard for when stage 2+ introduces new providers.
  const unknown: never = binding.provider;
  throw new Error(`Unknown provider: ${String(unknown)}`);
}

function resolveClaudeModel(binding: StepBinding, cfg: AgentConfig): string {
  if (binding.model) {
    return binding.model;
  }
  if (binding.tier) {
    return cfg.models.tiers[binding.tier];
  }
  return cfg.models.tiers.standard;
}
