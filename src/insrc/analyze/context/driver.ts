/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * P3 stub -- shared LLM-driven shaper driver.
 *
 * Phase 3 of plans/analyze-context-builder.md owns this module. The
 * driver is the only LLM-touching surface; per-shaper modules are
 * thin wrappers that point this function at the right prompt file +
 * the right bundle schema.
 *
 * Flow:
 *   1. Resolve cache key (prompt-content hash + schemaVersion + inputs hash)
 *   2. Cache hit -> return cached bundle
 *   3. Cache miss -> load prompt file (boot-time validator catches missing)
 *   4. Build messages: system = prompt content + CONTRACT_FOOTER_MD;
 *      user = serialized inputs
 *   5. OllamaProvider.complete with tools=getReadOnlyTools(), toolLoop=true,
 *      maxToolTurns=config.maxToolTurns
 *   6. completeStructured against the bundle schema with
 *      retries=config.structuredOutputRetries
 *   7. Stamp meta {mode, shaper, toolCalls, modelId, emptyLayers,
 *      schemaVersion, repoLastIndexedAt}
 *   8. Persist + return
 *
 * Failure modes:
 *   - Ollama connection error -> ShaperLlmUnavailableError (hard fail)
 *   - Tool-loop overshoot     -> ShaperToolLoopExhausted
 *   - Schema retries exhausted-> ShaperSchemaUnrecoverable
 *   - Prompt file missing     -> ShaperPromptMissingError (also caught
 *                                at boot)
 *
 * See: design/analyze-context-builder.md "Architecture", "Failure modes"
 *      plans/analyze-context-builder.md Phase 3
 */

import type {
	AnalyzeContextBundle,
	ClassificationShapeInput,
	RunShapeInput,
	ShapeOpts,
	ShaperId,
	ShaperMode,
	TaskShapeInput,
} from './types.js';

export interface RunShaperArgs {
	readonly promptPath:     string;
	readonly invocationMode: ShaperMode;
	readonly shaperId:       ShaperId;
	readonly inputs:
		| ClassificationShapeInput
		| RunShapeInput
		| TaskShapeInput;
	readonly opts: ShapeOpts;
}

export class ShaperLlmUnavailableError extends Error {
	constructor(cause: string) {
		super(`Local Ollama unavailable for shaper invocation: ${cause}`);
		this.name = 'ShaperLlmUnavailableError';
	}
}

export class ShaperToolLoopExhausted extends Error {
	constructor(turns: number) {
		super(`Shaper tool-loop exceeded maxToolTurns=${turns}`);
		this.name = 'ShaperToolLoopExhausted';
	}
}

export class ShaperSchemaUnrecoverable extends Error {
	constructor(retries: number) {
		super(`Shaper completeStructured exhausted ${retries} retries`);
		this.name = 'ShaperSchemaUnrecoverable';
	}
}

export class ShaperPromptMissingError extends Error {
	constructor(promptPath: string) {
		super(`Shaper prompt file missing: ${promptPath}`);
		this.name = 'ShaperPromptMissingError';
	}
}

export async function runShaper(_args: RunShaperArgs): Promise<AnalyzeContextBundle> {
	throw new Error('analyze/context/driver.ts: runShaper is a P3 stub');
}
