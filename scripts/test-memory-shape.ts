/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Memory-shape experiment.
 *
 * Goal: validate whether a local LLM (Ollama) can take an accumulated
 * working-memory file (concatenated prior-turn reports) + a candidate
 * input prompt, and produce a properly-shaped L1-L5 memory bundle
 * that fits the existing TokenBudget (agent/context/budget.ts).
 *
 * Inputs:
 *   - one of the existing ~/.insrc/tmp/<session>/reports/turn-*.md
 *     corpora (multi-turn report archives) -- pick a session
 *   - a list of candidate input prompts (continuation / drill-down /
 *     cross-reference / off-topic), each tested independently
 *
 * Output:
 *   - per-prompt per-session: the LLM's filled L1-L5 bundle + a
 *     compliance check (did each layer fit its token cap?) + raw
 *     response for human inspection
 *
 * Usage:
 *   npx tsx scripts/test-memory-shape.ts
 *     [--session=<id>]   default: cycles through 088b8433 + 45073724
 *     [--prompts=N]      default: all four variations
 *     [--budget=16k|32k] default: 16k
 *     [--model=<name>]   default: from local config
 *     [--out=<dir>]      default: /tmp/insrc-memory-experiment/
 *     [--trials=N]       default: 1 (repeat each prompt N times for stability)
 *     [--chunk]          force chunking path even for in-context memory
 *     [--no-retry]       disable schema-error retry
 *
 * Run via:
 *   source ~/.insors && npx tsx scripts/test-memory-shape.ts
 *
 * Heads-up: this calls Ollama locally; large memory files + 16K
 * budgets put real load on the model. Each prompt run is 1-10 minutes
 * on CPU-bound Ollama. Plan accordingly.
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

import { createBudget, countTokens, type TokenBudget } from '../src/insrc/agent/context/budget.js';
import { splitDocument } from '../src/insrc/daemon/doc-splitter.js';

// Direct Ollama HTTP client. Sends `think: false` on every call (the project
// OllamaProvider gates that on tools.length > 0; this experiment makes pure
// JSON-completion calls with no tools, so we bypass the provider).
class DirectOllama {
	readonly model: string;
	readonly numCtx: number;
	readonly host: string;
	constructor(model: string, numCtx: number, host = 'http://127.0.0.1:11434') {
		this.model = model;
		this.numCtx = numCtx;
		this.host = host;
	}
	async complete(system: string, user: string, maxTokens: number): Promise<string> {
		const body = {
			model:    this.model,
			messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
			think:    false,
			format:   'json',
			stream:   false,
			keep_alive: '24h',
			options: { num_ctx: this.numCtx, num_predict: maxTokens, temperature: 0 },
		};
		const resp = await fetch(`${this.host}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!resp.ok) {
			throw new Error(`ollama chat failed: ${resp.status} ${await resp.text()}`);
		}
		const json = await resp.json() as { message?: { content?: string } };
		return json.message?.content ?? '';
	}
}

// Reserve for system prompt + user-template scaffold around the memory body
// (everything except the WORKING MEMORY block itself).
const PROMPT_SCAFFOLD_TOKENS = 1500;
// Per-chunk distilled output budget (used for the reduce input).
const MAP_OUTPUT_TOKENS = 800;
// Per-chunk size is derived from numCtx -- maximise chunk size so whole
// turn-N.md reports fit in one chunk whenever possible.
function chunkTokensFor(numCtx: number): number {
	// Reserve scaffold + map output, then leave a safety margin.
	return Math.max(2000, numCtx - PROMPT_SCAFFOLD_TOKENS - MAP_OUTPUT_TOKENS - 2000);
}

// ---------------------------------------------------------------------------
// Sessions + prompt fixtures
// ---------------------------------------------------------------------------

interface SessionFixture {
	readonly id:           string;
	readonly label:        string;
	readonly turnsToLoad:  number;   // simulate "memory at start of turn N"
	readonly prompts:      readonly PromptVariation[];
}

interface PromptVariation {
	readonly kind:   'continuation' | 'drill-down' | 'cross-reference' | 'off-topic';
	readonly prompt: string;
}

const SESSIONS: readonly SessionFixture[] = [
	{
		id:    '088b8433-63e3-4b0b-ab1a-89c9d120f2db',
		label: 'GRN <-> pydantic class',
		turnsToLoad: 6,
		prompts: [
			{ kind: 'continuation', prompt: 'Based on the prior turns, propose additional test cases that would close the validator-coverage gaps identified for the INGRN class.' },
			{ kind: 'drill-down', prompt: 'Focus specifically on the timestamp fields (grn_date, invoice_date). How does the {micros} object shape map to the pydantic datetime field, and what validators are needed?' },
			{ kind: 'cross-reference', prompt: 'Cross-reference the SKU detail tax fields (sgst_rate / cgst_rate / igst_rate) with how INGRN defines tax computation. Are there any structural gaps?' },
			{ kind: 'off-topic', prompt: 'What deployment strategy would you recommend for rolling out the GRN extraction service to production?' },
		],
	},
	{
		id:    '45073724-ff90-466e-917f-31a54a94b9d9',
		label: 'Hadoop HDFS comprehensive',
		turnsToLoad: 8,
		prompts: [
			{ kind: 'continuation', prompt: 'Based on the architectural analysis so far, what are the next three subsystems worth investigating in order of importance?' },
			{ kind: 'drill-down', prompt: 'Drill into the NameNode\'s edit log + checkpointing flow. How does it interact with HA failover?' },
			{ kind: 'cross-reference', prompt: 'How do the BlockManager, DataNode, and the client I/O paths interact during a write that spans multiple blocks?' },
			{ kind: 'off-topic', prompt: 'What is the role of YARN in Hadoop\'s overall architecture, and how does it differ from HDFS?' },
		],
	},
];

// ---------------------------------------------------------------------------
// Memory file loader (concatenates prior turns into a single scratchpad)
// ---------------------------------------------------------------------------

interface TurnFile {
	readonly name:    string;
	readonly content: string;
}

function loadMemoryFile(sessionId: string, upToTurn: number): {
	content:   string;
	bytes:     number;
	turnCount: number;
	turns:     readonly TurnFile[];
} {
	const reportsDir = join(homedir(), '.insrc', 'tmp', sessionId, 'reports');
	if (!existsSync(reportsDir)) {
		throw new Error(`session reports dir not found: ${reportsDir}`);
	}
	const files = readdirSync(reportsDir)
		.filter(f => /^turn-\d+\.md$/.test(f))
		.sort((a, b) => {
			const ai = parseInt(a.match(/turn-(\d+)/)?.[1] ?? '0', 10);
			const bi = parseInt(b.match(/turn-(\d+)/)?.[1] ?? '0', 10);
			return ai - bi;
		})
		.slice(0, upToTurn);

	const turns: TurnFile[] = [];
	const parts: string[] = [];
	for (const f of files) {
		const text = readFileSync(join(reportsDir, f), 'utf8');
		turns.push({ name: f, content: text });
		parts.push(`=== ${f} ===\n\n${text}\n`);
	}
	const content = parts.join('\n');
	return { content, bytes: content.length, turnCount: files.length, turns };
}

// Chunk on turn-file boundary first; sub-split only turns that exceed budget.
function chunkByTurn(turns: readonly TurnFile[], maxTokensPerChunk: number): Array<{ heading: string; content: string }> {
	const out: Array<{ heading: string; content: string }> = [];
	const maxChars = maxTokensPerChunk * 3;
	for (const turn of turns) {
		const wrapped = `=== ${turn.name} ===\n\n${turn.content}`;
		if (wrapped.length <= maxChars) {
			out.push({ heading: turn.name, content: wrapped });
			continue;
		}
		// Sub-split oversized turn via doc-splitter on markdown headings
		const split = splitDocument(turn.content, turn.name, { maxTokensPerChunk, includeHeader: false });
		for (let i = 0; i < split.chunks.length; i++) {
			const c = split.chunks[i]!;
			out.push({
				heading: `${turn.name} part ${i + 1}/${split.chunks.length} (${c.heading})`,
				content: `=== ${turn.name} (part ${i + 1}/${split.chunks.length}) ===\n\n${c.content}`,
			});
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// L1-L5 shape: definitions + prompt builder
// ---------------------------------------------------------------------------

// The contract we ask the local LLM to fill. Maps 1:1 to the existing
// TokenBudget (system / summary / recent / semantic / code / response).
// We omit `response` from the LLM's contract -- it's reserved for the
// downstream cloud call's output, not part of the memory bundle.
interface MemoryBundle {
	readonly system:   string;   // L1 -- core fixed context
	readonly summary:  string;   // L2 -- rolling summary of accumulated state
	readonly recent:   string;   // L3a -- most-recent salient findings
	readonly semantic: string;   // L3b -- prior context semantically relevant to the input prompt
	readonly code:     string;   // L4 -- code / data artifacts referenced
}

// Role-only system prompt. Schema goes trailing in the user message
// (recency-weighted attention; per auto-memory feedback_prompt_structure).
// `think: false` is sent on every Ollama call via DirectOllama -- no need
// to embed `/no_think` in the prompt.
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

function buildShapingPrompt(memory: string, prompt: string, budget: TokenBudget): { system: string; user: string } {
	const user = [
		'## INPUT PROMPT',
		prompt,
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

// ---------------------------------------------------------------------------
// Map step: per-chunk distillation prompt (small structured output)
// ---------------------------------------------------------------------------

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

function buildMapPrompt(chunkContent: string, chunkIndex: number, total: number, prompt: string): { system: string; user: string } {
	const user = [
		`## INPUT PROMPT`,
		prompt,
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

interface ChunkPartial {
	readonly summary:  string;
	readonly recent:   string;
	readonly semantic: string;
	readonly code:     string;
}

function parseChunkPartial(raw: string): ChunkPartial | { parseError: string; raw: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripFences(raw));
	} catch (err) {
		return { parseError: (err as Error).message, raw };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { parseError: 'not a JSON object', raw };
	}
	const obj = parsed as Record<string, unknown>;
	return {
		summary:  typeof obj['summary']  === 'string' ? obj['summary']  : '',
		recent:   typeof obj['recent']   === 'string' ? obj['recent']   : '',
		semantic: typeof obj['semantic'] === 'string' ? obj['semantic'] : '',
		code:     typeof obj['code']     === 'string' ? obj['code']     : '',
	};
}

// ---------------------------------------------------------------------------
// Reduce step: consolidate per-chunk distillations into L1-L5
// ---------------------------------------------------------------------------

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
		'  recent    REQUIRED. Bullet list. Pull the per-chunk `recent` entries',
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

function buildReducePrompt(partials: ChunkPartial[], prompt: string, budget: TokenBudget): { system: string; user: string } {
	const partialsBlock = partials.map((p, i) => {
		return [
			`--- chunk ${i + 1}/${partials.length} ---`,
			`summary:  ${p.summary}`,
			`recent:   ${p.recent}`,
			`semantic: ${p.semantic}`,
			`code:     ${p.code}`,
		].join('\n');
	}).join('\n\n');

	const user = [
		'## INPUT PROMPT',
		prompt,
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
// Schema-error retry wrapper
// ---------------------------------------------------------------------------

interface ShapingTrace {
	readonly path:           'single' | 'chunked';
	readonly chunkCount:     number;
	readonly mapDurations:   number[];
	readonly mapParseFails:  number;
	readonly reduceDuration: number;
	readonly retryTriggered: boolean;
	readonly raw:            string;
}

function hasRequiredKeys(parsed: unknown): boolean {
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return false;
	}
	const obj = parsed as Record<string, unknown>;
	const keys: readonly string[] = ['system', 'summary', 'recent', 'semantic', 'code'];
	return keys.some(k => typeof obj[k] === 'string');
}

function buildRetrySystemAddendum(): string {
	return [
		'',
		'## RETRY CORRECTION',
		'Your previous response did not match the required schema. The schema is:',
		'  { "system": string, "summary": string, "recent": string, "semantic": string, "code": string }',
		'Emit EXACTLY this object. Do not wrap in any other key. Do not emit arrays.',
	].join('\n');
}

async function callWithSchemaRetry(
	client: DirectOllama,
	system: string,
	user: string,
	maxTokens: number,
	enableRetry: boolean,
): Promise<{ raw: string; retried: boolean }> {
	const text = await client.complete(system, user, maxTokens);

	if (!enableRetry) {
		return { raw: text, retried: false };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stripFences(text));
	} catch {
		parsed = undefined;
	}
	if (hasRequiredKeys(parsed)) {
		return { raw: text, retried: false };
	}

	const retryText = await client.complete(system + buildRetrySystemAddendum(), user, maxTokens);
	return { raw: retryText, retried: true };
}

// ---------------------------------------------------------------------------
// Chunking dispatcher
// ---------------------------------------------------------------------------

async function shapeMemory(
	client: DirectOllama,
	memory: string,
	turns: readonly TurnFile[],
	prompt: string,
	budget: TokenBudget,
	numCtx: number,
	opts: { forceChunk: boolean; enableRetry: boolean; debugPartialsPath?: string | undefined },
): Promise<ShapingTrace> {
	const memTokens = countTokens(memory);
	// Single-call needs: scaffold + memory + response. Anything beyond numCtx
	// gets silently truncated by Ollama, so chunk when memory blows the headroom.
	const singleCallHeadroom = numCtx - PROMPT_SCAFFOLD_TOKENS - Math.max(2048, budget.response);
	const triggerChunk = opts.forceChunk || memTokens > singleCallHeadroom;

	if (!triggerChunk) {
		const { system, user } = buildShapingPrompt(memory, prompt, budget);
		const started = Date.now();
		const { raw, retried } = await callWithSchemaRetry(client, system, user, Math.max(2048, budget.response), opts.enableRetry);
		return {
			path:           'single',
			chunkCount:     0,
			mapDurations:   [],
			mapParseFails:  0,
			reduceDuration: Date.now() - started,
			retryTriggered: retried,
			raw,
		};
	}

	// Chunked path: turn-boundary first, sub-split only oversized turns.
	const chunks = chunkByTurn(turns, chunkTokensFor(numCtx));

	const partials: ChunkPartial[] = [];
	const mapDurations: number[] = [];
	let mapParseFails = 0;

	const debugRecords: Array<{ chunkIndex: number; heading: string; chunkTokens: number; rawResponse: string; partial: ChunkPartial | { parseError: string } }> = [];

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i]!;
		const { system, user } = buildMapPrompt(chunk.content, i, chunks.length, prompt);
		const started = Date.now();
		try {
			const text = await client.complete(system, user, MAP_OUTPUT_TOKENS);
			mapDurations.push(Date.now() - started);
			const partial = parseChunkPartial(text);
			if ('parseError' in partial) {
				mapParseFails += 1;
				partials.push({ summary: '', recent: '', semantic: '', code: '' });
				if (opts.debugPartialsPath !== undefined) {
					debugRecords.push({ chunkIndex: i, heading: chunk.heading, chunkTokens: countTokens(chunk.content), rawResponse: text, partial: { parseError: partial.parseError } });
				}
			} else {
				partials.push(partial);
				if (opts.debugPartialsPath !== undefined) {
					debugRecords.push({ chunkIndex: i, heading: chunk.heading, chunkTokens: countTokens(chunk.content), rawResponse: text, partial });
				}
			}
		} catch (err) {
			mapDurations.push(Date.now() - started);
			mapParseFails += 1;
			partials.push({ summary: `[error: ${(err as Error).message}]`, recent: '', semantic: '', code: '' });
			if (opts.debugPartialsPath !== undefined) {
				debugRecords.push({ chunkIndex: i, heading: chunk.heading, chunkTokens: countTokens(chunk.content), rawResponse: '', partial: { parseError: (err as Error).message } });
			}
		}
	}

	if (opts.debugPartialsPath !== undefined) {
		writeFileSync(opts.debugPartialsPath, JSON.stringify({ chunkCount: chunks.length, partials: debugRecords }, null, 2));
	}

	const { system, user } = buildReducePrompt(partials, prompt, budget);
	const reduceStart = Date.now();
	const { raw, retried } = await callWithSchemaRetry(client, system, user, Math.max(2048, budget.response), opts.enableRetry);
	return {
		path:           'chunked',
		chunkCount:     chunks.length,
		mapDurations,
		mapParseFails,
		reduceDuration: Date.now() - reduceStart,
		retryTriggered: retried,
		raw,
	};
}

// ---------------------------------------------------------------------------
// Compliance check (post-LLM)
// ---------------------------------------------------------------------------

interface ComplianceReport {
	readonly bundle:        MemoryBundle | { parseError: string; raw: string };
	readonly tokenCounts:   Partial<Record<keyof MemoryBundle, number>>;
	readonly capViolations: Partial<Record<keyof MemoryBundle, { tokens: number; cap: number; overBy: number }>>;
	readonly totalTokens:   number;
}

function stripFences(text: string): string {
	let out = text.trim();
	if (out.startsWith('```')) {
		out = out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
	}
	return out.trim();
}

function check(raw: string, budget: TokenBudget): ComplianceReport {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripFences(raw));
	} catch (err) {
		return {
			bundle: { parseError: (err as Error).message, raw },
			tokenCounts: {},
			capViolations: {},
			totalTokens: 0,
		};
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return {
			bundle: { parseError: 'response is not a JSON object', raw },
			tokenCounts: {},
			capViolations: {},
			totalTokens: 0,
		};
	}
	const obj = parsed as Record<string, unknown>;
	const keys: readonly (keyof MemoryBundle)[] = ['system', 'summary', 'recent', 'semantic', 'code'];
	const bundle: MemoryBundle = {
		system:   typeof obj['system']   === 'string' ? obj['system']   : '',
		summary:  typeof obj['summary']  === 'string' ? obj['summary']  : '',
		recent:   typeof obj['recent']   === 'string' ? obj['recent']   : '',
		semantic: typeof obj['semantic'] === 'string' ? obj['semantic'] : '',
		code:     typeof obj['code']     === 'string' ? obj['code']     : '',
	};
	const tokenCounts: Partial<Record<keyof MemoryBundle, number>> = {};
	const capViolations: Partial<Record<keyof MemoryBundle, { tokens: number; cap: number; overBy: number }>> = {};
	const caps: Record<keyof MemoryBundle, number> = {
		system:   budget.system,
		summary:  budget.summary,
		recent:   budget.recent,
		semantic: budget.semantic,
		code:     budget.code,
	};
	let total = 0;
	for (const k of keys) {
		const t = countTokens(bundle[k]);
		tokenCounts[k] = t;
		total += t;
		if (t > caps[k]) {
			capViolations[k] = { tokens: t, cap: caps[k], overBy: t - caps[k] };
		}
	}
	return { bundle, tokenCounts, capViolations, totalTokens: total };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function parseArgs(): {
	sessionFilter?: string;
	promptLimit:    number;
	budgetSize:     number;
	model?:         string;
	outDir:         string;
	trials:         number;
	forceChunk:     boolean;
	enableRetry:    boolean;
} {
	const args = process.argv.slice(2);
	const get = (flag: string) => {
		const a = args.find(x => x.startsWith(flag + '='));
		return a !== undefined ? a.slice(flag.length + 1) : undefined;
	};
	const has = (flag: string) => args.includes(flag);
	const sessionFilter = get('--session');
	const promptLimit   = Number(get('--prompts') ?? '4');
	const budgetSpec    = get('--budget') ?? '16k';
	const budgetSize    = budgetSpec === '32k' ? 32_768 : budgetSpec === '64k' ? 65_536 : 16_384;
	const model         = get('--model');
	const outDir        = get('--out') ?? '/tmp/insrc-memory-experiment';
	const trials        = Math.max(1, Number(get('--trials') ?? '1'));
	const forceChunk    = has('--chunk');
	const enableRetry   = !has('--no-retry');
	const debugPartials = has('--debug-partials');
	const result: {
		promptLimit:    number;
		budgetSize:     number;
		outDir:         string;
		trials:         number;
		forceChunk:     boolean;
		enableRetry:    boolean;
		debugPartials:  boolean;
		sessionFilter?: string;
		model?:         string;
	} = { promptLimit, budgetSize, outDir, trials, forceChunk, enableRetry, debugPartials };
	if (sessionFilter !== undefined) {
		result.sessionFilter = sessionFilter;
	}
	if (model !== undefined) {
		result.model = model;
	}
	return result;
}

async function main(): Promise<void> {
	const opts = parseArgs();
	const budget = createBudget(opts.budgetSize);

	const sessions = opts.sessionFilter !== undefined
		? SESSIONS.filter(s => s.id.startsWith(opts.sessionFilter!))
		: SESSIONS;
	if (sessions.length === 0) {
		console.error(`no sessions matched filter "${opts.sessionFilter}"`);
		process.exit(1);
	}

	mkdirSync(opts.outDir, { recursive: true });
	console.log(`output dir: ${resolve(opts.outDir)}`);
	console.log(`budget:    `, JSON.stringify(budget));
	console.log('');

	if (opts.model === undefined) {
		console.error('--model=<name> is required (e.g. qwen3.6:35b-a3b)');
		process.exit(1);
	}
	const client = new DirectOllama(opts.model, opts.budgetSize);
	console.log(`ollama:    model=${client.model} numCtx=${client.numCtx} think=false format=json`);
	console.log('');

	let totalRuns = 0;
	let totalCapHits = 0;
	let totalParseFails = 0;

	for (const session of sessions) {
		const memFile = loadMemoryFile(session.id, session.turnsToLoad);
		const memTokens = countTokens(memFile.content);
		console.log(`> session ${session.id.slice(0, 8)} "${session.label}"`);
		console.log(`  loaded ${memFile.turnCount} turns (${memFile.bytes} bytes, ~${memTokens} tokens)`);

		const prompts = session.prompts.slice(0, opts.promptLimit);
		for (const variation of prompts) {
			for (let trial = 1; trial <= opts.trials; trial++) {
				totalRuns += 1;
				const trialSuffix = opts.trials > 1 ? `-t${trial}` : '';
				const tag = `${session.id.slice(0, 8)}-${variation.kind}${trialSuffix}`;
				const trialLabel = opts.trials > 1 ? ` [trial ${trial}/${opts.trials}]` : '';
				console.log(`  -> ${variation.kind}${trialLabel}: "${variation.prompt.slice(0, 80)}..."`);

				const started = Date.now();
				let trace: ShapingTrace;
				try {
					const debugPartialsPath = opts.debugPartials ? join(opts.outDir, `${tag}.partials.json`) : undefined;
					trace = await shapeMemory(client, memFile.content, memFile.turns, variation.prompt, budget, opts.budgetSize, {
						forceChunk:  opts.forceChunk,
						enableRetry: opts.enableRetry,
						debugPartialsPath,
					});
				} catch (err) {
					console.log(`    [x] provider error: ${(err as Error).message}`);
					continue;
				}
				const durMs = Date.now() - started;

				const compliance = check(trace.raw, budget);
				const outPath = join(opts.outDir, `${tag}.json`);
				writeFileSync(outPath, JSON.stringify({
					session:     session.id,
					sessionLabel: session.label,
					promptKind:  variation.kind,
					prompt:      variation.prompt,
					trial,
					budget,
					memoryInputTokens: memTokens,
					durationMs:  durMs,
					path:        trace.path,
					chunkCount:  trace.chunkCount,
					mapDurations: trace.mapDurations,
					mapParseFails: trace.mapParseFails,
					reduceDuration: trace.reduceDuration,
					retryTriggered: trace.retryTriggered,
					rawResponse: trace.raw,
					compliance,
				}, null, 2));

				const pathTag = trace.path === 'chunked' ? `[chunked ${trace.chunkCount}c]` : '[single]';
				const retryTag = trace.retryTriggered ? ' [retry]' : '';
				if ('parseError' in compliance.bundle) {
					totalParseFails += 1;
					console.log(`    [x] ${pathTag}${retryTag} JSON parse failed (${durMs}ms): ${compliance.bundle.parseError}`);
					console.log(`      raw saved -> ${outPath}`);
				} else {
					const violations = Object.entries(compliance.capViolations);
					if (violations.length > 0) {
						totalCapHits += 1;
						const summary = violations.map(([k, v]) => `${k} +${v.overBy}`).join(', ');
						console.log(`    [!] ${pathTag}${retryTag} cap violations (${durMs}ms): ${summary}`);
					} else {
						console.log(`    [ok] ${pathTag}${retryTag} ok (${durMs}ms, total=${compliance.totalTokens}t)`);
					}
					console.log(`      layers: ${
						(['system','summary','recent','semantic','code'] as const)
							.map(k => `${k}=${compliance.tokenCounts[k] ?? 0}/${budget[k]}t`)
							.join(' ')
					}`);
					console.log(`      saved  -> ${outPath}`);
				}
			}
		}
		console.log('');
	}

	console.log('-------------------------------------------------------------');
	console.log(`Summary: ${totalRuns} runs total`);
	console.log(`  parse failures:  ${totalParseFails}`);
	console.log(`  cap violations:  ${totalCapHits}`);
	console.log(`  clean:           ${totalRuns - totalParseFails - totalCapHits}`);
	console.log('');
	console.log(`Inspect per-run JSON in ${resolve(opts.outDir)}`);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
