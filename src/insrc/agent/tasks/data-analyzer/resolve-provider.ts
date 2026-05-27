/**
 * Cloud-by-default LLM provider resolution for the data analyzer.
 *
 * Mirrors the code-analyzer's parallel routing logic (in
 * daemon/controllers/code-analyzer-orchestrator.ts). Both analyzers
 * default to the cloud provider for multi-turn structured-output
 * calls because live testing on the code-analyzer side (2026-05)
 * showed local Ollama models like Devstral-Small-2 drop tokens to
 * empty content in deep multi-turn loops. Cloud (Haiku) handles the
 * same loops reliably.
 *
 * Opt-out: set `analyzer.useLocal: true` in `~/.insrc/config.json`
 * to force local Ollama at every analyzer call site (both code- AND
 * data-analyzer). Single shared toggle by design: there's no use
 * case for "cloud here, local there" mid-run.
 *
 * Falls back to local automatically when cloud is unconfigured (no
 * Anthropic API key), regardless of the `useLocal` setting. Cloud-
 * preferred but never hard-fails when cloud isn't available.
 */

import type { Session } from '../../session.js';
import type { LLMProvider } from '../../../shared/types.js';

/**
 * Per-step provider resolution for the data analyzer. The `step`
 * label is informational only (logged with the resolution decision);
 * the routing logic is the same for every step today, but keeping
 * the parameter means future per-step overrides land in one place.
 */
export type DataAnalyzerStep =
	| 'plan'
	| 'analyzer'
	| 'review'
	| 'synthesise'
	| 'meta'
	| 'summarize-result'
	| 'cycle-review'
	| 'writer'
	| 'claim-grounding';

/**
 * Resolve the LLM provider for one data-analyzer LLM call site.
 *
 * Default: cloud when configured; local Ollama otherwise. Opt-out
 * via `analyzer.useLocal: true` in config.json.
 *
 * The `step` parameter is currently unused for routing but is
 * accepted so future callers can rely on a stable signature. When
 * per-step overrides become useful (e.g. force `synthesise` to
 * cloud even when `useLocal: true`), the branch lands here.
 */
export function resolveDataAnalyzerProvider(
	session: Session,
	step:    DataAnalyzerStep,
): LLMProvider {
	if (isAnalyzerLocalOptIn(session)) {
		return session.ollamaProvider;
	}
	// `step` reserved for future per-step routing overrides.
	void step;
	return session.claudeProvider ?? session.ollamaProvider;
}

/**
 * True when the active config opts every analyzer call site into the
 * local LLM. Used both here for routing and by callers (logger
 * banners) to announce the routing decision once per run instead of
 * re-reading config on every call.
 *
 * Reads from `session.config.analyzer.useLocal`; defaults to false
 * (cloud routing) when the field is absent.
 */
export function isAnalyzerLocalOptIn(session: Session): boolean {
	return session.config.analyzer?.useLocal === true;
}

/**
 * Back-compat alias preserved for callers that imported the old
 * name. New code should use `isAnalyzerLocalOptIn` directly --
 * the data-analyzer-specific naming is misleading now that one
 * config field controls both analyzers.
 */
export const isDataAnalyzerLocalOptIn = isAnalyzerLocalOptIn;
