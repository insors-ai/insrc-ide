/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Shape-the-memory step (planner-section-task-separation P1.c).
 *
 * Given an accumulating working-memory text + the current TODO's
 * objective + a TokenBudget, produces an L1-L5 memory bundle the
 * downstream section planner consumes.
 *
 * Two paths:
 *   - Single-call: memory fits in `numCtx - response - scaffold` headroom.
 *     One LLM call returns the full bundle.
 *   - Chunked map-reduce: memory exceeds headroom; chunk on entry-file
 *     boundaries (sub-split oversized entries via splitDocument), run a
 *     small per-chunk distillation LLM call, then a single reduce call
 *     that consolidates partials into the final L1-L5 bundle.
 *
 * Schema-error retry: if the parsed JSON is missing the required keys
 * (e.g. devstral's documented `{"turns":[...]}` failure on overflow),
 * one corrective retry with a strict schema reminder runs before the
 * caller sees an unrecoverable error.
 *
 * Prompts are positioned with schema TRAILING in the user message
 * (per auto-memory feedback_prompt_structure) and the provider is
 * invoked with `disableThinking: true` so qwen3.x families don't burn
 * the output budget on hidden <think> tokens (per auto-memory
 * qwen3_6_needs_think_false).
 *
 * The single-call regime was validated on 12 GRN runs (13.5k mem,
 * 32k numCtx, qwen3.6:35b-a3b, bit-identical determinism at
 * temperature=0). The chunked regime was validated on 4 Hadoop runs
 * (82k mem, 8 entry-boundary chunks). See
 * /tmp/insrc-memory-experiment/qwen36-*.
 */

import type { TokenBudget } from '../context/budget.js';
import { countTokens } from '../context/budget.js';
import { splitDocument } from '../../daemon/doc-splitter.js';
import type { LLMMessage, LLMProvider } from '../../shared/types.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('working-memory-shape');

/**
 * Reserve for the system prompt + user-template scaffold around the
 * memory body (everything except the memory text itself).
 */
const PROMPT_SCAFFOLD_TOKENS = 1500;

/**
 * Per-chunk distilled output budget. Map calls produce 4 short bullet
 * fields; ~200 tokens per field is plenty.
 */
const MAP_OUTPUT_TOKENS = 800;

/**
 * Per-chunk token size. Derived from numCtx so whole working-memory
 * entries (which can be large -- Hadoop turn reports exceed 18k tokens)
 * fit in one chunk whenever possible.
 */
function chunkTokensFor(numCtx: number): number {
	return Math.max(2000, numCtx - PROMPT_SCAFFOLD_TOKENS - MAP_OUTPUT_TOKENS - 2000);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MemoryShapeBundle {
	readonly system:   string;
	readonly summary:  string;
	readonly recent:   string;
	readonly semantic: string;
	readonly code:     string;
}

/**
 * Chunk boundary hint. When omitted, the shaper splits via
 * `splitDocument` on markdown heading boundaries -- fine for memory
 * text produced by the WorkingMemoryStore (each entry has a clear
 * `=== entry-NNNN (...) ===` header). Provide explicit entries when
 * the boundaries matter more than heading detection (e.g. mixed prose
 * + code blobs).
 */
export interface MemoryChunkHint {
	readonly name:    string;
	readonly content: string;
}

export interface MemoryShapeInput {
	/** Accumulated memory text (from WorkingMemoryStore.accumulatedMemoryText()). */
	readonly memoryText: string;
	/** Optional explicit chunk boundaries (preferred to internal heading split when present). */
	readonly entries?:   readonly MemoryChunkHint[] | undefined;
	/** The current TODO's objective. The shaping LLM uses this to select semantic-layer content. */
	readonly objective:  string;
	readonly budget:     TokenBudget;
	/** Ollama numCtx the provider is configured with -- governs the single-vs-chunked decision. */
	readonly numCtx:     number;
}

export interface MemoryShapeOpts {
	/** Force chunked path even if memory fits in headroom (testing). */
	readonly forceChunk?:  boolean;
	/** Disable schema-error retry. Defaults to enabled. */
	readonly disableRetry?: boolean;
}

export interface MemoryShapeTrace {
	readonly path:               'single' | 'chunked';
	readonly chunkCount:         number;
	readonly mapDurationsMs:     readonly number[];
	readonly mapParseFails:      number;
	readonly reduceDurationMs:   number;
	readonly retryTriggered:     boolean;
	readonly memoryTokens:       number;
}

export interface MemoryShapeResult {
	readonly bundle: MemoryShapeBundle;
	readonly trace:  MemoryShapeTrace;
	readonly rawResponse: string;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

const SHAPING_ROLE = [
	'You are the LOCAL CONTEXT-ASSEMBLY model for an agentic reporting system.',
	'Given a WORKING MEMORY file (chronological prior-turn outputs) and an',
	'INPUT PROMPT, you produce a SINGLE JSON object that packs the memory',
	'into 5 layered context slots for a downstream planner. You always emit',
	'exactly the schema you are given, with no prose, no markdown fences.',
].join('\n');

function buildShapingSchema(budget: TokenBudget): string {
	return [
		'## OUTPUT SHAPE (emit EXACTLY this object, NO other keys)',
		'',
		'{',
		`  "system":   <string, max ${budget.system} tokens>,`,
		`  "summary":  <string, max ${budget.summary} tokens>,`,
		`  "recent":   <string, max ${budget.recent} tokens>,`,
		`  "semantic": <string, max ${budget.semantic} tokens>,`,
		`  "code":     <string, max ${budget.code} tokens>`,
		'}',
		'',
		'## FIELD CONTRACT (every field MUST be filled when source content exists)',
		'',
		'  system    Fixed evergreen context: project name, primary subject, file',
		'            kinds the memory refers to. Stable across iterations.',
		'',
		'  summary   Rolling 1-2 paragraph TL;DR of what the accumulated memory',
		'            says so far. The bullet-point essentials. No citations.',
		'',
		'  recent    REQUIRED if memory has more than one turn. Bullet list of',
		'            salient findings from the LAST 2-3 sections/turns. Cite',
		'            section titles by name. DO NOT leave empty.',
		'',
		'  semantic  REQUIRED if any memory content relates to the INPUT PROMPT.',
		'            Bullet list of items from ANY turn (not just recent) that bear',
		'            on the INPUT PROMPT. Cite section titles. DO NOT leave empty.',
		'',
		'  code      Code / data shapes / schemas / field tables found in memory.',
		'            Verbatim quotes or tight summaries.',
		'',
		'## RULES',
		'  - Token caps are HARD. ~3 chars ~= 1 token. Stay under each cap.',
		'  - Empty string "" ONLY when the source truly has nothing for that field.',
		'  - Do not duplicate content across layers.',
		'  - Do not invent content not in the memory.',
	].join('\n');
}

function buildShapingPrompt(memory: string, objective: string, budget: TokenBudget): { system: string; user: string } {
	const user = [
		'## INPUT PROMPT',
		objective,
		'',
		'## WORKING MEMORY',
		memory,
		'',
		buildShapingSchema(budget),
		'',
		'## TASK',
		'Emit the JSON object now. Begin with "{" and end with "}".',
	].join('\n');
	return { system: SHAPING_ROLE, user };
}

const MAP_ROLE = [
	'You are distilling ONE slice of a larger working-memory document.',
	'Given one CHUNK plus the INPUT PROMPT that the orchestrator is planning',
	'against, you emit a SINGLE JSON object with four distilled fields. You',
	'output exactly the schema given, with no prose, no markdown fences.',
].join('\n');

function buildMapSchema(): string {
	const perFieldCharCap = Math.floor(MAP_OUTPUT_TOKENS / 4) * 3;
	return [
		'## OUTPUT SHAPE (emit EXACTLY this object, NO other keys)',
		'',
		'{',
		`  "summary":  <string, ~${perFieldCharCap} chars>,`,
		`  "recent":   <string, ~${perFieldCharCap} chars>,`,
		`  "semantic": <string, ~${perFieldCharCap} chars>,`,
		`  "code":     <string, ~${perFieldCharCap} chars>`,
		'}',
		'',
		'## FIELD CONTRACT (fill every field that has source content)',
		'',
		'  summary   1-2 sentence TL;DR of THIS chunk.',
		'  recent    Bullet list of salient findings from this chunk. Cite',
		'            section/heading names. REQUIRED unless chunk is empty.',
		'  semantic  Bullet list of items in this chunk relevant to the INPUT',
		'            PROMPT. REQUIRED if anything in the chunk relates to it.',
		'  code      Code / data shapes / schemas / field tables in this chunk.',
		'',
		'## RULES',
		'  - Use empty string "" ONLY when the chunk truly has nothing for that field.',
		'  - Do not invent content not in the chunk.',
		'  - This is one of many chunks; do not speculate about content you have not seen.',
	].join('\n');
}

function buildMapPrompt(chunkContent: string, chunkIndex: number, total: number, objective: string): { system: string; user: string } {
	const user = [
		'## INPUT PROMPT',
		objective,
		'',
		`## CHUNK ${chunkIndex + 1}/${total}`,
		chunkContent,
		'',
		buildMapSchema(),
		'',
		'## TASK',
		`Emit the JSON object for chunk ${chunkIndex + 1}/${total} now. Begin with "{" and end with "}".`,
	].join('\n');
	return { system: MAP_ROLE, user };
}

const REDUCE_ROLE = [
	'You are the LOCAL CONTEXT-ASSEMBLY model.',
	'Given a list of PER-CHUNK DISTILLATIONS and the INPUT PROMPT the',
	'orchestrator is planning against, you consolidate them into a SINGLE',
	'JSON object packing 5 layered context slots for a downstream planner.',
	'You always emit exactly the schema you are given, with no prose, no',
	'markdown fences.',
].join('\n');

function buildReduceSchema(budget: TokenBudget, chunkCount: number): string {
	return [
		'## OUTPUT SHAPE (emit EXACTLY this object, NO other keys)',
		'',
		'{',
		`  "system":   <string, max ${budget.system} tokens>,`,
		`  "summary":  <string, max ${budget.summary} tokens>,`,
		`  "recent":   <string, max ${budget.recent} tokens>,`,
		`  "semantic": <string, max ${budget.semantic} tokens>,`,
		`  "code":     <string, max ${budget.code} tokens>`,
		'}',
		'',
		'## FIELD CONTRACT (every field MUST be filled when source content exists)',
		'',
		'  system    Fixed evergreen context: project name, primary subject, file',
		'            kinds. Infer from distillations. Stable across iterations.',
		'',
		'  summary   Rolling TL;DR. Merge the per-chunk `summary` fields into a',
		'            coherent 1-2 paragraph overview.',
		'',
		`  recent    REQUIRED. Bullet list. Pull the per-chunk \`recent\` entries`,
		`            from the LAST ~3 of ${chunkCount} chunk(s) (the most recent`,
		'            turns). DO NOT leave empty if any later chunk had `recent`',
		'            content. This is the single most important field for the',
		'            downstream planner.',
		'',
		'  semantic  REQUIRED. Bullet list. Pull per-chunk `semantic` entries',
		'            from ANY chunk -- these are items relevant to the INPUT',
		'            PROMPT regardless of chunk position. DO NOT leave empty if',
		'            any chunk had `semantic` content.',
		'',
		'  code      Code / schemas / field tables from any chunk\'s `code`',
		'            field. Verbatim or tight summary.',
		'',
		'## RULES',
		'  - Token caps are HARD. ~3 chars ~= 1 token. Stay under each cap.',
		'  - Empty string "" ONLY when NO chunk has content for that field.',
		'  - Do not duplicate content across layers.',
		'  - Do not invent content beyond what the distillations contain.',
	].join('\n');
}

interface ChunkPartial {
	readonly summary:  string;
	readonly recent:   string;
	readonly semantic: string;
	readonly code:     string;
}

function buildReducePrompt(partials: readonly ChunkPartial[], objective: string, budget: TokenBudget): { system: string; user: string } {
	const partialsBlock = partials.map((p, i) => [
		`--- chunk ${i + 1}/${partials.length} ---`,
		`summary:  ${p.summary}`,
		`recent:   ${p.recent}`,
		`semantic: ${p.semantic}`,
		`code:     ${p.code}`,
	].join('\n')).join('\n\n');

	const user = [
		'## INPUT PROMPT',
		objective,
		'',
		'## PER-CHUNK DISTILLATIONS',
		partialsBlock,
		'',
		buildReduceSchema(budget, partials.length),
		'',
		'## TASK',
		'Emit the consolidated JSON object now. Begin with "{" and end with "}".',
	].join('\n');
	return { system: REDUCE_ROLE, user };
}

// ---------------------------------------------------------------------------
// Chunk boundary detection
// ---------------------------------------------------------------------------

/**
 * Chunk the memory on entry-file boundaries first (preferred when the
 * caller supplied `entries`), then sub-split any entries that exceed
 * `maxTokensPerChunk` via splitDocument on their internal markdown
 * headings. This avoids producing fine-grained chunks (the 99-chunk
 * Hadoop pathology from the offline experiment) while still bounding
 * each chunk's size.
 */
export function chunkMemory(
	entries: readonly MemoryChunkHint[] | undefined,
	fallbackMemory: string,
	maxTokensPerChunk: number,
): Array<{ heading: string; content: string }> {
	const maxChars = maxTokensPerChunk * 3;
	if (entries === undefined || entries.length === 0) {
		// No entry hints: lean on splitDocument for heading-aware split.
		const split = splitDocument(fallbackMemory, 'memory.md', {
			maxTokensPerChunk,
			includeHeader: false,
		});
		return split.chunks.map(c => ({ heading: c.heading, content: c.content }));
	}
	const out: Array<{ heading: string; content: string }> = [];
	for (const entry of entries) {
		const wrapped = `=== ${entry.name} ===\n\n${entry.content}`;
		if (wrapped.length <= maxChars) {
			out.push({ heading: entry.name, content: wrapped });
			continue;
		}
		const split = splitDocument(entry.content, entry.name, {
			maxTokensPerChunk,
			includeHeader: false,
		});
		for (let i = 0; i < split.chunks.length; i++) {
			const c = split.chunks[i]!;
			out.push({
				heading: `${entry.name} part ${i + 1}/${split.chunks.length} (${c.heading})`,
				content: `=== ${entry.name} (part ${i + 1}/${split.chunks.length}) ===\n\n${c.content}`,
			});
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Parsing + validation
// ---------------------------------------------------------------------------

function stripFences(text: string): string {
	let out = text.trim();
	if (out.startsWith('```')) {
		out = out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
	}
	return out.trim();
}

function tryParse(raw: string): unknown {
	try {
		return JSON.parse(stripFences(raw));
	} catch {
		return undefined;
	}
}

function hasRequiredKeys(parsed: unknown): boolean {
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return false;
	}
	const obj = parsed as Record<string, unknown>;
	const keys: readonly string[] = ['system', 'summary', 'recent', 'semantic', 'code'];
	return keys.some(k => typeof obj[k] === 'string');
}

function bundleFromParsed(parsed: unknown): MemoryShapeBundle {
	const obj = parsed as Record<string, unknown>;
	return {
		system:   typeof obj['system']   === 'string' ? obj['system']   : '',
		summary:  typeof obj['summary']  === 'string' ? obj['summary']  : '',
		recent:   typeof obj['recent']   === 'string' ? obj['recent']   : '',
		semantic: typeof obj['semantic'] === 'string' ? obj['semantic'] : '',
		code:     typeof obj['code']     === 'string' ? obj['code']     : '',
	};
}

function parseChunkPartial(raw: string): ChunkPartial | { parseError: string } {
	const parsed = tryParse(raw);
	if (parsed === undefined) {
		return { parseError: 'invalid JSON' };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { parseError: 'not a JSON object' };
	}
	const obj = parsed as Record<string, unknown>;
	return {
		summary:  typeof obj['summary']  === 'string' ? obj['summary']  : '',
		recent:   typeof obj['recent']   === 'string' ? obj['recent']   : '',
		semantic: typeof obj['semantic'] === 'string' ? obj['semantic'] : '',
		code:     typeof obj['code']     === 'string' ? obj['code']     : '',
	};
}

const RETRY_ADDENDUM = [
	'',
	'## RETRY CORRECTION',
	'Your previous response did not match the required schema. The schema is:',
	'  { "system": string, "summary": string, "recent": string, "semantic": string, "code": string }',
	'Emit EXACTLY this object. Do not wrap in any other key. Do not emit arrays.',
].join('\n');

// ---------------------------------------------------------------------------
// LLM call wrappers
// ---------------------------------------------------------------------------

async function callShape(
	provider: LLMProvider,
	system: string,
	user: string,
	maxTokens: number,
): Promise<string> {
	const messages: LLMMessage[] = [
		{ role: 'system', content: system },
		{ role: 'user',   content: user   },
	];
	const response = await provider.complete(messages, {
		maxTokens,
		temperature:     0,
		responseFormat:  'json',
		disableThinking: true,
	});
	return response.text;
}

async function callWithSchemaRetry(
	provider: LLMProvider,
	system: string,
	user: string,
	maxTokens: number,
	enableRetry: boolean,
): Promise<{ raw: string; retried: boolean }> {
	const raw = await callShape(provider, system, user, maxTokens);
	if (!enableRetry) {
		return { raw, retried: false };
	}
	const parsed = tryParse(raw);
	if (hasRequiredKeys(parsed)) {
		return { raw, retried: false };
	}
	log.warn({ rawPreview: raw.slice(0, 200) }, 'shape response missing required keys, retrying with schema reminder');
	const retried = await callShape(provider, system + RETRY_ADDENDUM, user, maxTokens);
	return { raw: retried, retried: true };
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Shape an accumulated working memory into the L1-L5 bundle. Picks
 * single-call or chunked map-reduce path based on memory size vs
 * `numCtx` headroom. Caller passes their own LLMProvider; thread the
 * Ollama numCtx through so the chunk threshold is correct.
 *
 * Failure modes:
 *   - Empty memory + no entries -> returns a bundle with all-empty
 *     strings + path: 'single'. No LLM call.
 *   - Malformed final JSON after retry -> throws an Error with the
 *     raw response preview. Q9 classifies this as recoverable; the
 *     orchestrator restarts the in-flight TODO.
 *   - LLM provider error -> bubbles up unchanged.
 */
export async function shapeMemory(
	provider: LLMProvider,
	input: MemoryShapeInput,
	opts: MemoryShapeOpts = {},
): Promise<MemoryShapeResult> {
	const memTokens = countTokens(input.memoryText);
	const enableRetry = opts.disableRetry !== true;
	const responseBudget = Math.max(2048, input.budget.response);
	const singleCallHeadroom = input.numCtx - PROMPT_SCAFFOLD_TOKENS - responseBudget;
	const triggerChunk = opts.forceChunk === true || memTokens > singleCallHeadroom;

	if (input.memoryText.length === 0 && (input.entries === undefined || input.entries.length === 0)) {
		log.debug('shapeMemory: empty memory -> empty bundle');
		return {
			bundle: { system: '', summary: '', recent: '', semantic: '', code: '' },
			trace: {
				path:             'single',
				chunkCount:       0,
				mapDurationsMs:   [],
				mapParseFails:    0,
				reduceDurationMs: 0,
				retryTriggered:   false,
				memoryTokens:     0,
			},
			rawResponse: '',
		};
	}

	if (!triggerChunk) {
		const { system, user } = buildShapingPrompt(input.memoryText, input.objective, input.budget);
		const started = Date.now();
		const { raw, retried } = await callWithSchemaRetry(provider, system, user, responseBudget, enableRetry);
		const dur = Date.now() - started;
		const parsed = tryParse(raw);
		if (!hasRequiredKeys(parsed)) {
			throw new Error(`shapeMemory: single-call response did not match schema after retry. Preview: ${raw.slice(0, 200)}`);
		}
		const bundle = bundleFromParsed(parsed);
		log.info({ memTokens, durationMs: dur, retried }, 'shapeMemory: single-call complete');
		return {
			bundle,
			trace: {
				path:             'single',
				chunkCount:       0,
				mapDurationsMs:   [],
				mapParseFails:    0,
				reduceDurationMs: dur,
				retryTriggered:   retried,
				memoryTokens:     memTokens,
			},
			rawResponse: raw,
		};
	}

	const chunks = chunkMemory(input.entries, input.memoryText, chunkTokensFor(input.numCtx));
	if (chunks.length === 0) {
		log.warn('shapeMemory: chunking produced 0 chunks; falling back to empty bundle');
		return {
			bundle: { system: '', summary: '', recent: '', semantic: '', code: '' },
			trace: {
				path:             'chunked',
				chunkCount:       0,
				mapDurationsMs:   [],
				mapParseFails:    0,
				reduceDurationMs: 0,
				retryTriggered:   false,
				memoryTokens:     memTokens,
			},
			rawResponse: '',
		};
	}

	const partials: ChunkPartial[] = [];
	const mapDurationsMs: number[] = [];
	let mapParseFails = 0;

	// Sequential per the auto-memory `no_parallel_llm_calls` rule.
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i]!;
		const { system, user } = buildMapPrompt(chunk.content, i, chunks.length, input.objective);
		const started = Date.now();
		try {
			const raw = await callShape(provider, system, user, MAP_OUTPUT_TOKENS);
			mapDurationsMs.push(Date.now() - started);
			const partial = parseChunkPartial(raw);
			if ('parseError' in partial) {
				mapParseFails += 1;
				log.warn({ chunkIndex: i, error: partial.parseError, preview: raw.slice(0, 200) }, 'shapeMemory: chunk parse failure -- empty partial');
				partials.push({ summary: '', recent: '', semantic: '', code: '' });
			} else {
				partials.push(partial);
			}
		} catch (err) {
			mapDurationsMs.push(Date.now() - started);
			mapParseFails += 1;
			log.warn({ chunkIndex: i, error: (err as Error).message }, 'shapeMemory: chunk provider error -- empty partial');
			partials.push({ summary: `[error: ${(err as Error).message}]`, recent: '', semantic: '', code: '' });
		}
	}

	const { system, user } = buildReducePrompt(partials, input.objective, input.budget);
	const reduceStart = Date.now();
	const { raw, retried } = await callWithSchemaRetry(provider, system, user, responseBudget, enableRetry);
	const reduceDuration = Date.now() - reduceStart;
	const parsed = tryParse(raw);
	if (!hasRequiredKeys(parsed)) {
		throw new Error(`shapeMemory: reduce response did not match schema after retry. Preview: ${raw.slice(0, 200)}`);
	}
	const bundle = bundleFromParsed(parsed);
	log.info({
		memTokens,
		chunkCount:       chunks.length,
		mapParseFails,
		reduceDurationMs: reduceDuration,
		retried,
	}, 'shapeMemory: chunked map-reduce complete');

	return {
		bundle,
		trace: {
			path:             'chunked',
			chunkCount:       chunks.length,
			mapDurationsMs,
			mapParseFails,
			reduceDurationMs: reduceDuration,
			retryTriggered:   retried,
			memoryTokens:     memTokens,
		},
		rawResponse: raw,
	};
}

// ---------------------------------------------------------------------------
// Test-only exports (underscore-prefixed per project convention)
// ---------------------------------------------------------------------------

export const _chunkTokensForTest      = chunkTokensFor;
export const _hasRequiredKeysForTest  = hasRequiredKeys;
export const _bundleFromParsedForTest = bundleFromParsed;
export const _stripFencesForTest      = stripFences;
