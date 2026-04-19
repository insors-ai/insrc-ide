/**
 * Per-turn provider routing.
 *
 * Flat lookup (no tiers, no complexity assessment, no auto-escalation):
 *
 *   1. Vision override:     image/PDF attachment -> `models.visionDefault`
 *                            (or error -- handled in stage 6; for now falls
 *                             through to step 5)
 *   2. Explicit @mention:   caller-supplied `ExplicitProvider` wins
 *   3. No-LLM intents:      `code-analysis` -> graphOnly
 *   4. (reserved for future per-intent overrides; no-op today)
 *   5. Active provider:     `providers[activeProvider].default`
 *   6. Local fallback:      if no activeProvider configured -> ollamaProvider
 */

import type {
  AgentConfig, Attachment, ExplicitProvider, Intent, LLMProvider, ProviderName,
} from '../shared/types.js';
import { buildProvider } from './providers/factory.js';
import { hasEscalationAttachment } from './attachments/router.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('router');

/** Intent that uses no LLM at all -- pure structural code queries */
const NO_LLM: Set<Intent> = new Set(['code-analysis']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteResult {
  provider: LLMProvider;
  /** Display label for status line ("Local", "Anthropic", "OpenAI: gpt-4o", ...). */
  label: string;
  /** Whether this is a graph-only intent (no LLM call needed). */
  graphOnly: boolean;
  /** Whether routing was forced by a vision attachment. */
  attachmentForced?: boolean | undefined;
}

export interface RouterDeps {
  ollamaProvider: LLMProvider;
  /** Cloud provider instance for the `activeProvider`, if any. May be null
   *  if no cloud provider is configured or the key is missing. */
  cloudProvider: LLMProvider | null;
  config: AgentConfig;
  attachments?: Attachment[] | undefined;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export function selectProvider(
  intent: Intent,
  explicit: ExplicitProvider | undefined,
  deps: RouterDeps,
): RouteResult {
  const { ollamaProvider, cloudProvider, config, attachments } = deps;

  // 1. Vision override -- for now, just route to active cloud (or local if no
  //    cloud configured). Stage 6 will look up `models.visionDefault` and
  //    error when absent.
  if (hasEscalationAttachment(attachments)) {
    const vision = routeVision(config, cloudProvider, ollamaProvider);
    return { ...vision, attachmentForced: true };
  }

  // 2. Explicit @mention
  if (explicit) {
    return routeExplicit(explicit, config, cloudProvider, ollamaProvider);
  }

  // 3. No-LLM intents (code-analysis)
  if (NO_LLM.has(intent)) {
    return { provider: ollamaProvider, label: 'Code Analysis (no LLM)', graphOnly: true };
  }

  // 5. Active provider default
  return routeActive(config, cloudProvider, ollamaProvider);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function routeVision(
  config: AgentConfig,
  cloudProvider: LLMProvider | null,
  ollamaProvider: LLMProvider,
): RouteResult {
  const vd = config.models.visionDefault;
  if (vd) {
    if (vd.provider === 'local') {
      return { provider: ollamaProvider, label: `Local: ${vd.model} (attachment)`, graphOnly: false };
    }
    const apiKey = config.keys[vd.provider];
    if (!apiKey) {
      log.warn(`vision default ${vd.provider} has no API key -- falling back to active provider`);
    } else {
      return {
        provider: buildProvider({ provider: vd.provider, model: vd.model }, config),
        label: `${titleCase(vd.provider)}: ${vd.model} (attachment)`,
        graphOnly: false,
      };
    }
  }
  // Fall back to active provider for now -- stage 6 will make this an error.
  return routeActive(config, cloudProvider, ollamaProvider);
}

function routeExplicit(
  explicit: ExplicitProvider,
  config: AgentConfig,
  cloudProvider: LLMProvider | null,
  ollamaProvider: LLMProvider,
): RouteResult {
  if (explicit === 'local') {
    return { provider: ollamaProvider, label: 'Local', graphOnly: false };
  }
  // Cloud provider mention -- must match activeProvider, else fall back
  const active = config.models.activeProvider;
  if (active !== explicit) {
    log.warn(`@${explicit} is not the active provider (active=${active ?? 'none'}) -- falling back`);
    return routeActive(config, cloudProvider, ollamaProvider);
  }
  const def = config.models.providers[explicit].default;
  if (!def) {
    log.warn(`@${explicit} has no default model configured -- using local`);
    return { provider: ollamaProvider, label: 'Local (no cloud default)', graphOnly: false };
  }
  const apiKey = config.keys[explicit];
  if (!apiKey) {
    log.warn(`@${explicit} has no API key -- using local`);
    return { provider: ollamaProvider, label: 'Local (no API key)', graphOnly: false };
  }
  return {
    provider: buildProvider({ provider: explicit, model: def }, config),
    label: `${titleCase(explicit)}: ${def}`,
    graphOnly: false,
  };
}

function routeActive(
  config: AgentConfig,
  cloudProvider: LLMProvider | null,
  ollamaProvider: LLMProvider,
): RouteResult {
  const active = config.models.activeProvider;
  if (!active || !cloudProvider) {
    return { provider: ollamaProvider, label: 'Local', graphOnly: false };
  }
  const def = config.models.providers[active].default;
  if (!def) {
    return { provider: ollamaProvider, label: 'Local (no cloud default)', graphOnly: false };
  }
  return {
    provider: cloudProvider,
    label: `${titleCase(active)}: ${def}`,
    graphOnly: false,
  };
}

function titleCase(p: ProviderName): string {
  switch (p) {
    case 'openai':    return 'OpenAI';
    case 'anthropic': return 'Anthropic';
    case 'gemini':    return 'Gemini';
    case 'mistral':   return 'Mistral';
    case 'local':     return 'Local';
  }
}
