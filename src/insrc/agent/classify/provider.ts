/**
 * Helper that threads a classifier step through the session's provider
 * resolver with the agreed fallback cascade:
 *
 *   per-step override (`models.agents.classifier.<step>`)
 *   -> active cloud default
 *   -> local Ollama
 *   -> throw
 *
 * `session.resolver.resolve('classifier', step)` already implements
 * the per-step / active-cloud / local chain. The only thing missing
 * is the terminal throw when neither is available -- ProviderResolver
 * returns `this.local` unconditionally, and the local OllamaProvider
 * object is always constructed even when Ollama isn't actually running
 * (the call fails later, at `.complete()`). That surfaces as a
 * `fallback: true` result from `classify()` rather than a raise here.
 *
 * Keeping this helper as a thin wrapper so every call site goes
 * through a named function -- makes the "who chose the provider"
 * question findable in a grep.
 */

import type { LLMProvider } from '../../shared/types.js';
import type { Session } from '../session.js';

export function resolveClassifierProvider(session: Session, step: string): LLMProvider {
  return session.resolver.resolve('classifier', step);
}
