/**
 * Cloud-by-default LLM provider resolution for the data analyzer
 * (DA-E1 of plans/analyzers/data-analyzer-parity.md).
 *
 * Mirrors the code-analyzer's
 * `INSRC_ANALYZER_USE_LOCAL=1` opt-out pattern from
 * daemon/controllers/code-analyzer-orchestrator.ts (the
 * `useLocal` branch of `resolveProvider` in `buildSkillRunnerDeps`
 * + `runPlanExpandReviewSynthesise`).
 *
 * Why cloud-by-default: live testing on the code-analyzer side
 * (2026-05) showed local Ollama models like Devstral-Small-2 drop
 * tokens to empty content in deep multi-turn loops. The cloud
 * provider (Haiku) handles the same loops reliably. The data
 * analyzer's summarizer / future writer / future cycle reviewer
 * are all multi-turn-style structured-output calls; they get the
 * cloud provider unless explicitly opted out.
 *
 * Future Phase C / E callers (execute-step.ts, write-from-evidence.ts,
 * claim-grounding-reviewer.ts) should import + use this helper
 * rather than calling `session.resolver.resolve(...)` directly. The
 * existing pre-parity orchestrator call sites
 * (data-analyzer-orchestrator.ts, cross-agent/data-analyze.ts) stay
 * on the resolver for now -- their routing behaviour can be
 * migrated in a follow-up PR once the new code paths are wired in
 * and validated.
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
 * Default: cloud (Anthropic Haiku) when available.
 * Fallback when cloud is unavailable (no Anthropic API key in
 * config): local Ollama. Same fallback the code-analyzer uses --
 * cloud-by-default but never hard-fail when cloud is unconfigured.
 * Opt-out: set `INSRC_DATA_ANALYZER_USE_LOCAL=1` to revert to local.
 *
 * The `step` parameter is currently unused for routing but is
 * accepted so future callers can rely on a stable signature. When
 * per-step overrides become useful (e.g. force `synthesise` to
 * cloud even when `INSRC_DATA_ANALYZER_USE_LOCAL=1`), the branch
 * lands here.
 */
export function resolveDataAnalyzerProvider(
	session: Session,
	step:    DataAnalyzerStep,
): LLMProvider {
	const useLocal = process.env['INSRC_DATA_ANALYZER_USE_LOCAL'] === '1';
	if (useLocal) {
		return session.ollamaProvider;
	}
	// `step` reserved for future per-step routing overrides.
	void step;
	return session.claudeProvider ?? session.ollamaProvider;
}

/**
 * True when this run is opted into the local LLM. Surface so callers
 * (logger calls, run banners) can announce the routing decision
 * without re-reading the env var.
 */
export function isDataAnalyzerLocalOptIn(): boolean {
	return process.env['INSRC_DATA_ANALYZER_USE_LOCAL'] === '1';
}
