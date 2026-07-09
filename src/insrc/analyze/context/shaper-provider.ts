/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shaper-provider factory for the analyze framework.
 *
 * Every LLM call site under `src/insrc/analyze/` used to build its
 * own `new OllamaProvider(modelId, host, numCtx)`. Introduced for
 * the MCP-integration scenario (see plans/exploration-based-context-
 * build.md tail discussion), this single factory now honours the
 * new `AnalyzeConfig.shaperProvider` setting so a single config
 * flip routes decomposer + synthesizer + narrow-LLM explorations
 * (doc.decision.trace, doc.constraint.enumerate, capability.reuse-
 * check) + classifier + planner + summariser + adherence-aggregator
 * calls through either:
 *   - `OllamaProvider` (default; standalone CLI / IDE usage)
 *   - `CliProvider('claude')` (Claude Code / Codex MCP path)
 *   - `CliProvider('codex')` (same, but codex CLI)
 *
 * The tool-loop path in `analyze/context/driver.ts` is DELIBERATELY
 * unaffected: freeform.probe + classification + task modes still
 * spin their own OllamaProvider because `CliProvider.supportsTools
 * === false` -- the CLI wrappers can't drive a multi-turn tool loop.
 * A future revision may route those through MCP sampling instead;
 * for now they remain Ollama-only regardless of this factory's
 * output.
 *
 * The factory reads config on every call rather than caching so a
 * mid-process config change (via _resetAnalyzeConfigCacheForTests
 * + reload) is picked up without a daemon restart. The underlying
 * provider constructors are cheap.
 */

import type { AnalyzeConfig } from '../../config/analyze.js';
import { loadLocalProviderConfig } from '../../config/local.js';
import { CliProvider } from '../../agent/providers/cli-provider.js';
import { OllamaProvider } from '../../agent/providers/ollama.js';
import { getLogger } from '../../shared/logger.js';
import type { LLMProvider } from '../../shared/types.js';

const log = getLogger('analyze:context:shaper-provider');

/**
 * Return the `LLMProvider` implementation the analyze framework
 * should use for its structured-output calls under the currently-
 * loaded config. Cheap; call per invocation rather than caching
 * because config edits are rare + a stale cache is worse than an
 * extra constructor call.
 */
export function buildShaperProvider(cfg: AnalyzeConfig): LLMProvider {
	if (cfg.shaperProvider === 'cli-claude' || cfg.shaperProvider === 'cli-codex') {
		const kind = cfg.shaperProvider === 'cli-claude' ? 'claude' : 'codex';
		log.debug(
			{ kind, model: cfg.shaperModel },
			'shaper provider: routing through CliProvider',
		);
		return new CliProvider({
			kind,
			// `cfg.shaperModel` is honoured verbatim when set; the CLI's
			// own default applies otherwise. This lets an operator pin
			// (e.g.) `claude-haiku-4-5` for cost-sensitive inner calls
			// while the outer Claude Code session runs Opus.
			model: cfg.shaperModel === '' ? undefined : cfg.shaperModel,
		});
	}
	// Default + explicit 'ollama'.
	log.debug(
		{ model: cfg.shaperModel, numCtx: cfg.shaper.ollamaNumCtx },
		'shaper provider: routing through OllamaProvider',
	);
	const local = loadLocalProviderConfig();
	return new OllamaProvider(cfg.shaperModel, local.host, cfg.shaper.ollamaNumCtx);
}
