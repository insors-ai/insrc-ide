/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Synthesizer driver.
 *
 * plans/exploration-based-context-build.md Section 6. Takes an
 * `ExecutedPlan` (exploration outputs) + the classified intent
 * + the synthesis hint, and asks the shaper model to compose the
 * 7-layer `AnalyzeContextBundle`.
 *
 * Bounded input: the synthesizer NEVER runs tools or reads new
 * files. Its input is the pre-computed evidence pack. This bounds
 * output-token growth + eliminates the "LLM decided to look at X
 * instead of Y" failure mode.
 *
 * V1 only ships the code-target synthesizer prompt. Other targets
 * fall back to the legacy shaper. See analyze/context/driver.ts
 * for the dispatch logic.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OllamaProvider } from '../../agent/providers/ollama.js';
import { loadAnalyzeConfig } from '../../config/analyze.js';
import { loadLocalProviderConfig } from '../../config/local.js';
import { getLogger } from '../../shared/logger.js';
import type {
	LLMMessage,
	LLMProvider,
} from '../../shared/types.js';
import type { ClassifiedIntent } from '../../shared/analyze-types.js';

import { ANALYZE_CONTEXT_BUNDLE_SCHEMA } from './schema.js';
import type { AnalyzeContextBundle } from './types.js';
import type {
	ExecutedPlan,
} from '../explore/index.js';

const log = getLogger('analyze:context:synthesizer');

const SYNTHESIZE_CODE_PROMPT_REL = 'prompts/analyze/synthesize.code.system.md';

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class SynthesizerLlmUnavailableError extends Error {
	constructor(cause: string) {
		super(`Local Ollama unavailable for synthesizer: ${cause}`);
		this.name = 'SynthesizerLlmUnavailableError';
	}
}

export class SynthesizerSchemaUnrecoverable extends Error {
	constructor(errors: readonly string[]) {
		super(`Synthesizer structured output unrecoverable: ${errors.join('; ')}`);
		this.name = 'SynthesizerSchemaUnrecoverable';
	}
}

export class SynthesizerPromptMissingError extends Error {
	constructor(path: string) {
		super(`Synthesizer prompt file missing: ${path}`);
		this.name = 'SynthesizerPromptMissingError';
	}
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export interface SynthesizeArgs {
	readonly runId:    string;
	readonly intent:   ClassifiedIntent;
	readonly executed: ExecutedPlan;
	/** Which target's synthesizer prompt to use. Phase 1 only ships
	 *  'code'; other targets throw `SynthesizerPromptMissingError`
	 *  so the driver knows to fall back. */
	readonly target:   'code';
	readonly provider?: LLMProvider;
}

/**
 * Compose the run-mode `AnalyzeContextBundle` from the executed
 * plan. Returns the bundle WITHOUT `meta` -- the shaper driver
 * stamps `meta` from framework-side info (mode, shaperId, model,
 * schemaVersion, ...) after synthesis.
 */
export async function synthesize(args: SynthesizeArgs): Promise<Omit<AnalyzeContextBundle, 'meta'>> {
	const cfg = loadAnalyzeConfig();
	const promptContent = loadPromptFile(args.target);
	const provider = args.provider ?? buildProvider(cfg.shaperModel, cfg.shaper.ollamaNumCtx);

	const messages = buildMessages(promptContent, args.intent, args.executed);

	let raw: Omit<AnalyzeContextBundle, 'meta'>;
	try {
		raw = await provider.completeStructured<Omit<AnalyzeContextBundle, 'meta'>>(
			messages,
			// Reuse the bundle schema but drop the `meta` requirement --
			// the driver stamps `meta` post-synthesis.
			stripMetaFromSchema(ANALYZE_CONTEXT_BUNDLE_SCHEMA as Record<string, unknown>),
			{
				maxAttempts:     cfg.shaper.structuredOutputRetries,
				disableThinking: true,
				// Same output-token budget as the legacy shaper -- the
				// bundle shape is unchanged.
				maxTokens:       cfg.shaper.ollamaNumPredict,
			},
		);
	} catch (err) {
		const errClass = classifyError(err);
		throw errClass;
	}

	log.info(
		{
			runId:            args.runId,
			target:           args.target,
			explorationCount: args.executed.results.length,
			summaryLen:       raw.summary?.length ?? 0,
			structureLen:     raw.structure?.length ?? 0,
			surfaceLen:       raw.surface?.length ?? 0,
			artefactsLen:     raw.artefacts?.length ?? 0,
		},
		'synthesizer: bundle emitted',
	);

	return raw;
}

// ---------------------------------------------------------------------------
// Message composition
// ---------------------------------------------------------------------------

function buildMessages(
	promptContent: string,
	intent:        ClassifiedIntent,
	executed:      ExecutedPlan,
): LLMMessage[] {
	// Render the executed plan as a series of numbered blocks the LLM
	// can scan sequentially. Each block: id, type, purpose, output as
	// pretty-printed JSON.
	const evidenceBlocks = executed.results
		.map(r =>
			`### ${r.exploration.id} :: ${r.exploration.type}\n` +
			`purpose: ${r.exploration.purpose}\n` +
			`output:\n` +
			'```json\n' +
			JSON.stringify(r.output, null, 2) +
			'\n```',
		)
		.join('\n\n');

	const userContent =
		`Classified intent:\n` +
		'```json\n' +
		JSON.stringify(intent, null, 2) +
		'\n```\n' +
		`\n` +
		`Answer type: ${executed.plan.answerType}\n` +
		`Synthesis hint: ${executed.plan.synthesisHint}\n` +
		`\n` +
		`Executed explorations (${executed.results.length}):\n\n` +
		evidenceBlocks +
		`\n\n` +
		`Compose the AnalyzeContextBundle now. Emit the seven layers as strings. ` +
		`First char \`{\`, no markdown fence, no prose intro. Every string non-empty ` +
		`unless the layer's contract says empty is allowed (upstream = empty in ` +
		`run-mode). No claim without an exploration output.`;

	return [
		{ role: 'system', content: promptContent.trimEnd() },
		{ role: 'user',   content: userContent },
	];
}

// ---------------------------------------------------------------------------
// Schema: bundle schema minus the meta requirement
// ---------------------------------------------------------------------------

function stripMetaFromSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const cloned = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
	if (Array.isArray(cloned['required'])) {
		cloned['required'] = (cloned['required'] as string[]).filter(k => k !== 'meta');
	}
	if (typeof cloned['properties'] === 'object' && cloned['properties'] !== null) {
		const props = cloned['properties'] as Record<string, unknown>;
		delete props['meta'];
	}
	return cloned;
}

// ---------------------------------------------------------------------------
// Prompt loading + provider construction
// ---------------------------------------------------------------------------

const PROMPT_PATHS: Readonly<Record<'code', string>> = {
	code: SYNTHESIZE_CODE_PROMPT_REL,
};

function loadPromptFile(target: keyof typeof PROMPT_PATHS): string {
	const rel = PROMPT_PATHS[target];
	if (rel === undefined) {
		throw new SynthesizerPromptMissingError(`no synthesizer prompt for target '${target}'`);
	}
	const abs = isAbsolute(rel) ? rel : resolveRelativeToInsrcRoot(rel);
	try {
		return readFileSync(abs, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new SynthesizerPromptMissingError(abs);
		}
		throw err;
	}
}

function resolveRelativeToInsrcRoot(relativePath: string): string {
	const thisFile = fileURLToPath(import.meta.url);
	const insrcRoot = resolve(thisFile, '..', '..', '..');
	return resolve(insrcRoot, relativePath);
}

function buildProvider(modelId: string, numCtx: number): LLMProvider {
	const local = loadLocalProviderConfig();
	return new OllamaProvider(modelId, local.host, numCtx);
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const UNAVAILABLE_PATTERNS = [
	'Ollama is not running',
	'Model not found',
	'ECONNREFUSED',
	'ECONNRESET',
	'fetch failed',
	'socket hang up',
	'EPIPE',
	'other side closed',
	'Did not receive done or success response in stream',
];

function classifyError(err: unknown): Error {
	if (!(err instanceof Error)) return new SynthesizerSchemaUnrecoverable([String(err)]);
	const msg = err.message;
	for (const pat of UNAVAILABLE_PATTERNS) {
		if (msg.includes(pat)) return new SynthesizerLlmUnavailableError(msg);
	}
	return new SynthesizerSchemaUnrecoverable([msg]);
}

// ---------------------------------------------------------------------------
// Boot validator hook
// ---------------------------------------------------------------------------

export const SYNTHESIZE_CODE_PROMPT_PATH = SYNTHESIZE_CODE_PROMPT_REL;

export function getSynthesizerPromptPathForBoot(): string {
	return SYNTHESIZE_CODE_PROMPT_REL;
}
