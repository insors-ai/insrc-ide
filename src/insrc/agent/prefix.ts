import type { ExplicitProvider, Intent, ProviderName } from '../shared/types.js';

// ---------------------------------------------------------------------------
// All recognized intents for the /intent override
// ---------------------------------------------------------------------------

const VALID_INTENTS = new Set<Intent>([
  'implement', 'refactor', 'test', 'debug', 'review',
  'document', 'research', 'code-analysis', 'plan', 'requirements', 'design',
  'brainstorm', 'deploy', 'release', 'infra',
]);

const PROVIDER_TOKENS: ReadonlyArray<ProviderName> =
  ['local', 'openai', 'anthropic', 'gemini', 'mistral'];

// ---------------------------------------------------------------------------
// Parsed result
// ---------------------------------------------------------------------------

export interface PrefixResult {
  /** Explicit provider override (@local, @openai, @anthropic, @gemini, @mistral) */
  explicit?: ExplicitProvider | undefined;
  /** Explicit intent override (/intent <name>) */
  intentOverride?: Intent | undefined;
  /** Message body with all prefixes stripped */
  message: string;
}

/**
 * Parse prefix overrides from a raw user message.
 *
 * Supports:
 *   /intent <name> [@provider] <message>
 *   @local <message>
 *   @<provider> <message>    where <provider> is openai|anthropic|gemini|mistral
 *
 * Parse order: /intent first, then @provider, then remaining is message.
 */
export function parsePrefix(raw: string): PrefixResult {
  let remaining = raw.trim();
  let explicit: ExplicitProvider | undefined;
  let intentOverride: Intent | undefined;

  // 1. /intent <name>
  const intentMatch = remaining.match(/^\/intent\s+(\S+)\s*/);
  if (intentMatch) {
    const candidate = intentMatch[1]!.toLowerCase();
    if (VALID_INTENTS.has(candidate as Intent)) {
      intentOverride = candidate as Intent;
      remaining = remaining.slice(intentMatch[0].length);
    }
  }

  // 2. @<provider>
  for (const token of PROVIDER_TOKENS) {
    const prefix = `@${token} `;
    if (remaining.toLowerCase().startsWith(prefix)) {
      explicit = token;
      remaining = remaining.slice(prefix.length);
      break;
    }
  }

  return {
    explicit,
    intentOverride,
    message: remaining.trim(),
  };
}
