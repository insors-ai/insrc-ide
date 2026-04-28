/**
 * Per-turn provider routing.
 *
 * Flat lookup (no tiers, no complexity assessment, no auto-escalation):
 *
 *   1. Vision override:     image/PDF attachment -> `models.visionDefault`.
 *                            If unset, returns RouteResult with `error`
 *                            populated (turn aborts in the caller).
 *   2. Explicit @mention:   caller-supplied `ExplicitProvider` wins
 *   3. (reserved for future per-intent overrides; no-op today)
 *   4. Active provider:     `providers[activeProvider].default`
 *   5. Local fallback:      if no activeProvider configured -> ollamaProvider
 *
 * Phase 2.B: `code-analysis` was previously a "no-LLM" intent that
 * bypassed provider routing entirely (the legacy CodeAnalysisController
 * answered structural queries from Kuzu / LanceDB without ever calling
 * an LLM). The new tier-aware orchestrator IS LLM-driven (cloud
 * planner + cloud reviewer + local analyzer), so the no-LLM
 * short-circuit is gone; `code-analysis` now follows the standard
 * active-provider cascade.
 */

import type {
  AgentConfig, Attachment, ExplicitProvider, Intent, LLMProvider, ProviderName,
} from '../shared/types.js';
import { buildProvider } from './providers/factory.js';
import { hasEscalationAttachment } from './attachments/router.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('router');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteResult {
  /** Provider to use. Still populated even when `error` is set (points at a
   *  usable fallback like `ollamaProvider`) so callers can narrow without
   *  null checks; they just must check `error` first and abort the turn. */
  provider: LLMProvider;
  /** Display label for status line ("Local", "Anthropic", "OpenAI: gpt-4o", ...). */
  label: string;
  /** Whether this is a graph-only intent (no LLM call needed). */
  graphOnly: boolean;
  /** Whether routing was forced by a vision attachment. */
  attachmentForced?: boolean | undefined;
  /** If set, the turn cannot proceed. Message is user-facing. */
  error?: string | undefined;
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

  // 3. Active provider default. Phase 2.B removed the legacy
  //    code-analysis "no-LLM" branch; the orchestrator handles
  //    provider resolution per-step now.
  void intent;
  return routeActive(config, cloudProvider, ollamaProvider);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function routeVision(
  config: AgentConfig,
  _cloudProvider: LLMProvider | null,
  ollamaProvider: LLMProvider,
): RouteResult {
  const vd = config.models.visionDefault;
  if (!vd) {
    return {
      provider: ollamaProvider,
      label: 'Vision default not configured',
      graphOnly: false,
      error:
        'This turn includes an image or PDF attachment, but no Vision Default is configured. '
        + 'Open the Model Providers pane (command: insrc.openModelProviders) to set a vision-capable '
        + '(provider, model) binding, or remove the attachment.',
    };
  }

  if (vd.provider === 'local') {
    return {
      provider: ollamaProvider,
      label: `Local: ${vd.model} (attachment)`,
      graphOnly: false,
    };
  }

  const apiKey = config.keys[vd.provider];
  if (!apiKey) {
    return {
      provider: ollamaProvider,
      label: 'Vision default missing API key',
      graphOnly: false,
      error:
        `Vision default is set to ${vd.provider}:${vd.model}, but no ${vd.provider} API key is configured. `
        + 'Set the key in Model Providers, pick a different vision default, or remove the attachment.',
    };
  }

  return {
    provider: buildProvider({ provider: vd.provider, model: vd.model }, config),
    label: `${titleCase(vd.provider)}: ${vd.model} (attachment)`,
    graphOnly: false,
  };
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
