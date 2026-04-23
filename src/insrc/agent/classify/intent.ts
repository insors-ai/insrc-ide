/**
 * Primary-intent classification wrapper.
 *
 * Thin glue between the generic `classify()` module and the top-level
 * chat pipeline: handles the `/intent` + `@provider` prefix overrides
 * (which bypass LLM classification entirely) and returns the unified
 * shape all callers (chat-handler, agent/index, agent/cli) expect.
 *
 * The wrapper exists because prefix parsing is a pipeline concern that
 * shouldn't leak into the generic classifier. Without it every caller
 * would have to duplicate the same "parse prefixes, skip LLM if
 * override set" dance.
 */

import type { ExplicitProvider, Intent } from '../../shared/types.js';
import type { Session } from '../session.js';
import type { ScopeSize } from '../../shared/classify.js';
import { parsePrefix } from '../prefix.js';
import { classify } from './index.js';
import { resolveClassifierProvider } from './provider.js';
import { INTENT_CLASSES } from '../../shared/intent-classes.js';

export interface IntentClassifyResult {
  /** Resolved primary intent. */
  readonly intent: Intent;
  /** 0..1 confidence (1.0 for prefix-override path). */
  readonly confidence: number;
  /** Explicit provider override if the user prefixed @<provider>. */
  readonly explicit?: ExplicitProvider | undefined;
  /** Message body with prefixes stripped. */
  readonly message: string;
  /** One-sentence reasoning from the LLM. Empty for prefix overrides. */
  readonly reasoning: string;
  /**
   * Scope / size estimate produced alongside the class. 'M' for prefix
   * overrides (no LLM call -- callers can re-classify if they need a
   * real scope) and fallback paths.
   */
  readonly scope: ScopeSize;
  /** True when the classifier errored and fell back to classes[0]. */
  readonly fallback: boolean;
}

/**
 * Classify the primary intent of a user message.
 *
 * 1. Parse `/intent <name>` and `@<provider>` prefixes off the front.
 * 2. If the user set `/intent` explicitly, short-circuit with
 *    `confidence = 1.0` and skip the LLM call.
 * 3. Otherwise run the generic classifier against INTENT_CLASSES using
 *    the session's classifier provider (resolver cascade: per-step
 *    override -> active cloud -> local).
 */
export async function classifyPrimaryIntent(
  raw: string,
  session: Session,
): Promise<IntentClassifyResult> {
  const prefix = parsePrefix(raw);

  if (prefix.intentOverride) {
    return {
      intent: prefix.intentOverride,
      confidence: 1.0,
      explicit: prefix.explicit,
      message: prefix.message,
      reasoning: 'explicit /intent override',
      scope: 'M',
      fallback: false,
    };
  }

  const result = await classify(
    {
      role: 'intent classifier for a coding assistant',
      classes: INTENT_CLASSES,
      text: prefix.message,
    },
    resolveClassifierProvider(session, 'classify'),
  );

  return {
    intent: result.id as Intent,
    confidence: result.confidence,
    explicit: prefix.explicit,
    message: prefix.message,
    reasoning: result.reasoning,
    scope: result.scope,
    fallback: result.fallback,
  };
}
