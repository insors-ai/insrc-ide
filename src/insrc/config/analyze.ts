/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Analyze-framework config loader.
 *
 * The Context Builder's LLM-driven shaper consumes:
 *   - models.analyze.shaperModel               -- Ollama model id; falls
 *     back to loadLocalProviderConfig().coreModel when unset
 *   - models.analyze.shaper.maxToolTurns       -- tool-loop turn cap
 *   - models.analyze.shaper.structuredOutputRetries -- final-emit retry
 *     budget
 *   - models.analyze.shaper.ollamaNumCtx       -- context window override
 *     for the shaper invocation
 *
 * Read from `~/.insrc/config.json` if present, else fall back to defaults
 * declared below. Cached in-process for the daemon's lifetime; the cache
 * is reset only via `_resetAnalyzeConfigCacheForTests()`.
 *
 * See: design/analyze-context-builder.md "Configuration"
 *      plans/analyze-context-builder.md Phase 3
 */

import { existsSync, readFileSync } from 'node:fs';

import { getLogger } from '../shared/logger.js';
import { PATHS } from '../shared/paths.js';

const log = getLogger('config:analyze');

export interface AnalyzeShaperConfig {
	readonly maxToolTurns:            number;
	readonly structuredOutputRetries: number;
	readonly ollamaNumCtx:            number;
}

export interface AnalyzeConfig {
	readonly shaperModel: string;
	readonly shaper:      AnalyzeShaperConfig;
}

/**
 * Defaults sit at sane v1 starting points. `maxToolTurns: 40` matches
 * the design doc; `structuredOutputRetries: 3` matches the Ollama
 * provider's own default; `ollamaNumCtx: 32768` is the standard
 * shaper-context size (large enough to fit an XL-scope bundle without
 * truncation, but not so large the model OOMs).
 */
const DEFAULT_SHAPER: AnalyzeShaperConfig = {
	maxToolTurns:            40,
	structuredOutputRetries: 3,
	ollamaNumCtx:            32_768,
};

/**
 * Default shaper model. `qwen3.6:35b-a3b` is preferred over
 * qwen3-coder for shaper work -- the shaper's job is structural
 * comprehension + tool-loop orchestration rather than code
 * generation, and qwen3.6 is a stronger generalist for that surface.
 *
 * The model is in the qwen3.6 family, which emits empty bodies
 * unless `think: false` is sent in the Ollama request body (memory:
 * qwen3_6_needs_think_false). The driver sets `disableThinking: true`
 * on completeStructured for this reason; tool-loop calls get the
 * quirk treatment via the provider's family check on `hasTools`.
 *
 * Override via config.json `models.analyze.shaperModel`.
 */
const DEFAULT_SHAPER_MODEL = 'qwen3.6:35b-a3b';

let cached: AnalyzeConfig | undefined;

export function loadAnalyzeConfig(): AnalyzeConfig {
	if (cached !== undefined) {
		return cached;
	}

	// Default to the analyze-specific shaper model rather than the
	// generic coreModel: the shaper benefits from a stronger generalist
	// even if the local coreModel is set for code generation.
	const fallbackModel = DEFAULT_SHAPER_MODEL;

	if (!existsSync(PATHS.config)) {
		cached = { shaperModel: fallbackModel, shaper: DEFAULT_SHAPER };
		return cached;
	}

	try {
		const raw = JSON.parse(readFileSync(PATHS.config, 'utf8')) as Record<string, unknown>;
		const models = isObject(raw['models']) ? (raw['models'] as Record<string, unknown>) : {};
		const analyze = isObject(models['analyze'])
			? (models['analyze'] as Record<string, unknown>)
			: {};
		const shaperObj = isObject(analyze['shaper'])
			? (analyze['shaper'] as Record<string, unknown>)
			: {};

		cached = {
			shaperModel:
				typeof analyze['shaperModel'] === 'string'
					? (analyze['shaperModel'] as string)
					: fallbackModel,
			shaper: {
				maxToolTurns:
					typeof shaperObj['maxToolTurns'] === 'number'
						? (shaperObj['maxToolTurns'] as number)
						: DEFAULT_SHAPER.maxToolTurns,
				structuredOutputRetries:
					typeof shaperObj['structuredOutputRetries'] === 'number'
						? (shaperObj['structuredOutputRetries'] as number)
						: DEFAULT_SHAPER.structuredOutputRetries,
				ollamaNumCtx:
					typeof shaperObj['ollamaNumCtx'] === 'number'
						? (shaperObj['ollamaNumCtx'] as number)
						: DEFAULT_SHAPER.ollamaNumCtx,
			},
		};
		return cached;
	} catch (err) {
		log.warn(
			{ err: (err as Error).message },
			'failed to parse config.json; using analyze defaults',
		);
		cached = { shaperModel: fallbackModel, shaper: DEFAULT_SHAPER };
		return cached;
	}
}

function isObject(x: unknown): x is Record<string, unknown> {
	return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function _resetAnalyzeConfigCacheForTests(): void {
	cached = undefined;
}
