/**
 * Provider override parsing for gate feedback and step-level resolution.
 *
 * Grammar (stage 2):
 *   @local                        -> force local for the next step
 *   @<provider>                   -> force that cloud provider's default
 *                                    for the next step (must be active)
 *   @sticky @<provider>|@local    -> lock override for the session
 *   @clear                        -> drop the sticky override
 *
 * `<provider>` is one of: openai | anthropic | gemini | mistral.
 * Legacy tokens (@claude, @opus, @sonnet, @haiku) are no longer recognized.
 */

import type { LLMProvider, ProviderName } from '../../shared/types.js';
import type { AgentState, StepContext } from './types.js';
import { buildProvider } from '../providers/factory.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('provider-mention');

// ---------------------------------------------------------------------------
// Provider override type
// ---------------------------------------------------------------------------

export interface ProviderOverride {
  provider: ProviderName | null;
  sticky: boolean;
}

// ---------------------------------------------------------------------------
// Mention parsing
// ---------------------------------------------------------------------------

const PROVIDER_TOKENS = ['local', 'openai', 'anthropic', 'gemini', 'mistral'] as const;
const TOKEN_RE = /^@(local|openai|anthropic|gemini|mistral)\b\s*/i;
const STICKY_RE = /^@sticky\s+@?(local|openai|anthropic|gemini|mistral)\b\s*/i;
const CLEAR_RE  = /^@clear\b\s*/i;

function isProviderToken(s: string): s is ProviderName {
  return (PROVIDER_TOKENS as readonly string[]).includes(s);
}

/**
 * Parse a provider @-mention from gate feedback text.
 * Returns the override (if any) and the feedback with the mention stripped.
 */
export function parseProviderMention(feedback: string): {
  override: ProviderOverride | null;
  cleanFeedback: string;
} {
  const trimmed = feedback.trimStart();

  const stickyMatch = trimmed.match(STICKY_RE);
  if (stickyMatch) {
    const token = stickyMatch[1]!.toLowerCase();
    if (isProviderToken(token)) {
      return {
        override: { provider: token, sticky: true },
        cleanFeedback: trimmed.slice(stickyMatch[0].length).trim(),
      };
    }
  }

  const clearMatch = trimmed.match(CLEAR_RE);
  if (clearMatch) {
    return {
      override: { provider: null, sticky: false },
      cleanFeedback: trimmed.slice(clearMatch[0].length).trim(),
    };
  }

  const match = trimmed.match(TOKEN_RE);
  if (match) {
    const token = match[1]!.toLowerCase();
    if (isProviderToken(token)) {
      return {
        override: { provider: token, sticky: false },
        cleanFeedback: trimmed.slice(match[0].length).trim(),
      };
    }
  }

  return { override: null, cleanFeedback: feedback };
}

// ---------------------------------------------------------------------------
// Step-level provider resolution
// ---------------------------------------------------------------------------

export interface HasProviderOverride extends AgentState {
  providerOverride?: ProviderOverride | undefined;
}

/**
 * Resolve the LLM provider for an agent step.
 *
 * Priority:
 *   1. @-mention override in state.providerOverride
 *   2. Config binding via ctx.providers.resolve(agentName, step)
 */
export function resolveStepProvider<S extends HasProviderOverride>(
  ctx: StepContext,
  state: S,
  agentName: string,
  stepName: string,
): LLMProvider {
  const override = state.providerOverride;
  if (override?.provider) {
    if (override.provider === 'local') {
      return ctx.providers.local;
    }
    // Cloud provider -- must match activeProvider
    const active = ctx.config.models.activeProvider;
    if (active !== override.provider) {
      log.warn(
        `@${override.provider} is not the active provider (active=${active ?? 'none'}) -- ignoring override`,
      );
      return ctx.providers.resolve(agentName, stepName);
    }
    const apiKey = ctx.config.keys[override.provider];
    if (apiKey) {
      const def = ctx.config.models.providers[override.provider].default;
      if (def) {
        return buildProvider({ provider: override.provider, model: def }, ctx.config);
      }
    }
    // Fall through to config-level resolution if key/default missing
  }

  return ctx.providers.resolve(agentName, stepName);
}

// ---------------------------------------------------------------------------
// Override lifecycle
// ---------------------------------------------------------------------------

/** Consume a non-sticky override after an LLM call. */
export function consumeOverride<S extends HasProviderOverride>(state: S): S {
  if (!state.providerOverride) return state;
  if (state.providerOverride.sticky) return state;
  return { ...state, providerOverride: undefined };
}

/** Apply a parsed provider override to state. */
export function applyOverride<S extends HasProviderOverride>(
  state: S,
  override: ProviderOverride,
): S {
  if (override.provider === null) {
    return { ...state, providerOverride: undefined };
  }
  return { ...state, providerOverride: override };
}
