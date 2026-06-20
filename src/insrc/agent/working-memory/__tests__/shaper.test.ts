/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Tests for the shape-the-memory step (P1.c).
 *
 * Uses a scripted LLMProvider that returns canned responses per call,
 * so we can pin the routing decisions and the parse/retry path without
 * hitting a real model. The live model behavior was validated in the
 * offline experiment (`scripts/test-memory-shape.ts`) and is locked in
 * the auto-memory note `qwen3_6_needs_think_false`.
 *
 * Covered routing:
 * - Empty memory short-circuits without an LLM call.
 * - Small memory + 32k numCtx triggers the single-call path.
 * - Large memory + 16k numCtx triggers the chunked path.
 * - `forceChunk: true` forces the chunked path on small memory.
 * - Chunk count is bounded by entry count when entries are provided.
 *
 * Covered parsing:
 * - Markdown-fenced JSON is unwrapped.
 * - Missing required keys triggers ONE corrective retry; if retry
 *   also fails, shapeMemory throws.
 * - `disableRetry: true` skips the retry path.
 * - Chunk-step parse failures are counted and result in empty
 *   partials (the reduce step still runs).
 *
 * Covered LLM contract:
 * - Every call sends `disableThinking: true` (the P1.a path).
 * - Every call sends `temperature: 0` and `responseFormat: 'json'`.
 * - Every call has a system message + a user message (system fully
 *   describes the role; schema sits trailing in the user message).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	shapeMemory,
	chunkMemory,
	_chunkTokensForTest,
	_hasRequiredKeysForTest,
} from '../shaper.js';
import type { MemoryShapeInput } from '../shaper.js';
import { createBudget } from '../../context/budget.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import { _resetPromptRegistryForTest, registerAllPromptWriters } from '../../prompts/index.js';

test.beforeEach(() => {
	_resetPromptRegistryForTest();
	registerAllPromptWriters();
});

// ---------------------------------------------------------------------------
// Scripted provider
// ---------------------------------------------------------------------------

interface RecordedCall {
	readonly messages: LLMMessage[];
	readonly opts:     CompletionOpts;
	readonly schema:   unknown;
}

// plans/structured-output.md Phase C.6. shapeMemory now calls
// provider.completeStructured for both the map (chunk-partial) and
// reduce/single (full bundle) shapes. Malformed text replays as `{}`
// so the application-level `hasRequiredKeys` retry path stays exercised.
function scriptedProvider(responses: readonly string[]): { provider: LLMProvider; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	let cursor = 0;
	const provider = {
		supportsTools: true,
		capabilities: {
			structuredOutput: true, toolCalling: true, vision: false,
			webSearch: false, streaming: false, embeddings: false,
		},
		async complete(messages: LLMMessage[], opts: CompletionOpts = {}): Promise<LLMResponse> {
			calls.push({ messages, opts, schema: undefined });
			if (cursor >= responses.length) {
				throw new Error(`scriptedProvider: ran out of responses at call ${cursor + 1}`);
			}
			const text = responses[cursor]!;
			cursor++;
			return { text, stopReason: 'end_turn' };
		},
		async completeStructured<T>(messages: LLMMessage[], schema: unknown, opts: CompletionOpts = {}): Promise<T> {
			calls.push({ messages, opts, schema });
			if (cursor >= responses.length) {
				throw new Error(`scriptedProvider: ran out of responses at call ${cursor + 1}`);
			}
			const text = responses[cursor]!;
			cursor++;
			try { return JSON.parse(text) as T; }
			catch { return {} as T; }
		},
		async *stream(): AsyncIterable<string> { yield ''; },
		async embed(): Promise<number[]> { return []; },
	} as unknown as LLMProvider;
	return { provider, calls };
}

const VALID_BUNDLE_JSON = JSON.stringify({
	system:   'project: insrc',
	summary:  'memory contains 3 prior turns about GRN field mappings',
	recent:   '- turn-2: pydantic validator gaps',
	semantic: '- timestamp fields: grn_date, invoice_date',
	code:     'class INGRN(BaseModel): ...',
});

const VALID_PARTIAL_JSON = JSON.stringify({
	summary:  'this chunk covers the discover phase',
	recent:   '- finding X',
	semantic: '- relevant Y to the prompt',
	code:     'class Foo: pass',
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('hasRequiredKeys: passes when any one of the 5 keys is a string', () => {
	assert.equal(_hasRequiredKeysForTest({ system: 'x' }), true);
	assert.equal(_hasRequiredKeysForTest({ system: '', summary: '', recent: '', semantic: '', code: '' }), true);
});

test('hasRequiredKeys: fails on objects missing all keys (e.g. devstral {"turns":[]} failure)', () => {
	assert.equal(_hasRequiredKeysForTest({ turns: [] }), false);
	assert.equal(_hasRequiredKeysForTest(null), false);
	assert.equal(_hasRequiredKeysForTest([]), false);
	assert.equal(_hasRequiredKeysForTest('not an object'), false);
});

test('chunkTokensFor: scales with numCtx and stays positive', () => {
	assert.ok(_chunkTokensForTest(16_384) >= 2000);
	assert.ok(_chunkTokensForTest(32_768) > _chunkTokensForTest(16_384));
	assert.ok(_chunkTokensForTest(4_096)  >= 2000);   // floor protects tiny numCtx
});

// ---------------------------------------------------------------------------
// Empty-memory short-circuit
// ---------------------------------------------------------------------------

test('shapeMemory: empty memory + no entries -> empty bundle, zero LLM calls', async () => {
	const { provider, calls } = scriptedProvider([]);
	const result = await shapeMemory(provider, {
		memoryText: '',
		objective:  'next TODO',
		budget:     createBudget(16_384),
		numCtx:     16_384,
	});
	assert.equal(calls.length, 0);
	assert.equal(result.bundle.system, '');
	assert.equal(result.bundle.summary, '');
	assert.equal(result.trace.path, 'single');
	assert.equal(result.trace.chunkCount, 0);
});

// ---------------------------------------------------------------------------
// Single-call path
// ---------------------------------------------------------------------------

test('shapeMemory: small memory -> single-call path; one LLM call', async () => {
	const { provider, calls } = scriptedProvider([VALID_BUNDLE_JSON]);
	const input: MemoryShapeInput = {
		memoryText: 'small memory text\n'.repeat(20),
		objective:  'next TODO',
		budget:     createBudget(32_768),
		numCtx:     32_768,
	};
	const result = await shapeMemory(provider, input);
	assert.equal(calls.length, 1);
	assert.equal(result.trace.path, 'single');
	assert.equal(result.bundle.system, 'project: insrc');
	assert.equal(result.bundle.summary.startsWith('memory contains'), true);
});

test('shapeMemory: every LLM call has disableThinking=true + temperature=0 + schema to completeStructured', async () => {
	// plans/structured-output.md Phase C.6. responseFormat is gone; the
	// schema travels as the second arg to provider.completeStructured.
	const { provider, calls } = scriptedProvider([VALID_BUNDLE_JSON]);
	await shapeMemory(provider, {
		memoryText: 'small',
		objective:  'next TODO',
		budget:     createBudget(32_768),
		numCtx:     32_768,
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.opts.disableThinking, true);
	assert.equal(calls[0]!.opts.temperature, 0);
	assert.ok(calls[0]!.schema !== undefined && typeof calls[0]!.schema === 'object');
});

test('shapeMemory: prompt structure has system role + trailing schema in user message', async () => {
	const { provider, calls } = scriptedProvider([VALID_BUNDLE_JSON]);
	await shapeMemory(provider, {
		memoryText: 'memory content here',
		objective:  'specific objective here',
		budget:     createBudget(32_768),
		numCtx:     32_768,
	});
	const messages = calls[0]!.messages;
	assert.equal(messages.length, 2);
	assert.equal(messages[0]!.role, 'system');
	assert.equal(messages[1]!.role, 'user');

	const user = messages[1]!.content;
	const promptIdx = user.indexOf('## INPUT PROMPT');
	const memoryIdx = user.indexOf('## WORKING MEMORY');
	const schemaIdx = user.indexOf('## OUTPUT SHAPE');
	const taskIdx   = user.indexOf('## TASK');
	// All four sections appear, in trailing-schema order.
	assert.ok(promptIdx > -1);
	assert.ok(memoryIdx > promptIdx);
	assert.ok(schemaIdx > memoryIdx);
	assert.ok(taskIdx > schemaIdx);

	// The objective is in the prompt section, not the schema/task.
	assert.ok(user.includes('specific objective here'));
	assert.ok(user.includes('memory content here'));
});

// ---------------------------------------------------------------------------
// Single-call: schema retry
// ---------------------------------------------------------------------------

test('shapeMemory: missing-keys response triggers ONE schema-corrective retry that succeeds', async () => {
	const bogus = JSON.stringify({ turns: [] });   // devstral-style schema violation
	const { provider, calls } = scriptedProvider([bogus, VALID_BUNDLE_JSON]);
	const result = await shapeMemory(provider, {
		memoryText: 'small',
		objective:  'next TODO',
		budget:     createBudget(32_768),
		numCtx:     32_768,
	});
	assert.equal(calls.length, 2);
	assert.equal(result.trace.retryTriggered, true);
	assert.equal(result.bundle.system, 'project: insrc');
	// The retry system prompt carries the RETRY CORRECTION block.
	assert.match(calls[1]!.messages[0]!.content, /RETRY CORRECTION/);
});

test('shapeMemory: retry-also-fails -> throws', async () => {
	const bogus = JSON.stringify({ turns: [] });
	const { provider } = scriptedProvider([bogus, bogus]);
	await assert.rejects(
		() => shapeMemory(provider, {
			memoryText: 'small',
			objective:  'next TODO',
			budget:     createBudget(32_768),
			numCtx:     32_768,
		}),
		/did not match schema after retry/,
	);
});

test('shapeMemory: disableRetry=true skips retry path -> direct throw on bad shape', async () => {
	const bogus = JSON.stringify({ turns: [] });
	const { provider, calls } = scriptedProvider([bogus]);
	await assert.rejects(
		() => shapeMemory(provider, {
			memoryText: 'small',
			objective:  'next TODO',
			budget:     createBudget(32_768),
			numCtx:     32_768,
		}, { disableRetry: true }),
		/did not match schema/,
	);
	// Only one call -- no retry attempted.
	assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// Markdown-fenced response
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Chunked map-reduce path
// ---------------------------------------------------------------------------

test('shapeMemory: large memory + small numCtx -> chunked path; N map calls + 1 reduce call', async () => {
	// 4 entries totaling >12k tokens so the single-call headroom at
	// numCtx=16384 is exceeded; each entry stays under the per-chunk
	// budget so no sub-split fires.
	const entries = [
		{ name: 'turn-0.md', content: 'turn 0 content line\n'.repeat(2000) },
		{ name: 'turn-1.md', content: 'turn 1 content line\n'.repeat(2000) },
		{ name: 'turn-2.md', content: 'turn 2 content line\n'.repeat(2000) },
		{ name: 'turn-3.md', content: 'turn 3 content line\n'.repeat(2000) },
	];
	const memoryText = entries.map(e => `=== ${e.name} ===\n\n${e.content}`).join('\n');
	const responses = [
		VALID_PARTIAL_JSON,   // map 0
		VALID_PARTIAL_JSON,   // map 1
		VALID_PARTIAL_JSON,   // map 2
		VALID_PARTIAL_JSON,   // map 3
		VALID_BUNDLE_JSON,    // reduce
	];
	const { provider, calls } = scriptedProvider(responses);
	const result = await shapeMemory(provider, {
		memoryText,
		entries,
		objective: 'next TODO',
		budget:    createBudget(16_384),
		numCtx:    16_384,
	});
	assert.equal(result.trace.path, 'chunked');
	assert.equal(result.trace.chunkCount, 4);
	assert.equal(calls.length, 5);              // 4 map + 1 reduce
	assert.equal(result.trace.mapDurationsMs.length, 4);
	assert.equal(result.trace.mapParseFails, 0);
	// Reduce produces the final bundle.
	assert.equal(result.bundle.system, 'project: insrc');
});

test('shapeMemory: forceChunk=true engages chunked path even on small memory', async () => {
	const entries = [{ name: 'turn-0.md', content: 'tiny\n' }];
	const responses = [VALID_PARTIAL_JSON, VALID_BUNDLE_JSON];
	const { provider, calls } = scriptedProvider(responses);
	const result = await shapeMemory(provider, {
		memoryText: 'tiny',
		entries,
		objective:  'next TODO',
		budget:     createBudget(32_768),
		numCtx:     32_768,
	}, { forceChunk: true });
	assert.equal(result.trace.path, 'chunked');
	assert.equal(result.trace.chunkCount, 1);
	assert.equal(calls.length, 2);              // 1 map + 1 reduce
});

test('shapeMemory: chunked-path map parse failure counted but reduce still runs', async () => {
	const entries = [
		{ name: 'turn-0.md', content: 'good content\n' },
		{ name: 'turn-1.md', content: 'good content\n' },
	];
	const responses = [
		VALID_PARTIAL_JSON,
		'this is not JSON at all',   // map 1 fails to parse
		VALID_BUNDLE_JSON,           // reduce still proceeds
	];
	const { provider, calls } = scriptedProvider(responses);
	const result = await shapeMemory(provider, {
		memoryText: entries.map(e => e.content).join(''),
		entries,
		objective: 'next TODO',
		budget:    createBudget(32_768),
		numCtx:    32_768,
	}, { forceChunk: true });
	assert.equal(result.trace.mapParseFails, 1);
	assert.equal(calls.length, 3);
	assert.equal(result.bundle.system, 'project: insrc');
});

test('shapeMemory: chunked path also has disableThinking=true on every call', async () => {
	const entries = [
		{ name: 'turn-0.md', content: 'a\n' },
		{ name: 'turn-1.md', content: 'b\n' },
	];
	const { provider, calls } = scriptedProvider([VALID_PARTIAL_JSON, VALID_PARTIAL_JSON, VALID_BUNDLE_JSON]);
	await shapeMemory(provider, {
		memoryText: 'a\nb\n',
		entries,
		objective:  'next TODO',
		budget:     createBudget(32_768),
		numCtx:     32_768,
	}, { forceChunk: true });
	assert.equal(calls.length, 3);
	for (const call of calls) {
		assert.equal(call.opts.disableThinking, true);
		assert.equal(call.opts.temperature, 0);
		// plans/structured-output.md Phase C.6. Each call now carries a
		// schema via the second arg to completeStructured.
		assert.ok(call.schema !== undefined && typeof call.schema === 'object');
	}
});

// ---------------------------------------------------------------------------
// chunkMemory (the chunking primitive)
// ---------------------------------------------------------------------------

test('chunkMemory: small entries -> one chunk per entry (no sub-split)', () => {
	const entries = [
		{ name: 'a', content: 'small content a\n' },
		{ name: 'b', content: 'small content b\n' },
	];
	const chunks = chunkMemory(entries, 'unused', 8_000);
	assert.equal(chunks.length, 2);
	assert.match(chunks[0]!.content, /=== a ===/);
	assert.match(chunks[1]!.content, /=== b ===/);
});

test('chunkMemory: entry exceeding chunk budget gets sub-split via splitDocument', () => {
	// splitMarkdown splits on H2; subSplitChunk further splits on
	// `\n\n+` paragraph boundaries. We need the entry's wrapped size
	// (>=15k chars) to exceed the per-chunk budget (4500 chars at
	// maxTokensPerChunk=1500) AND each H2 section to itself exceed
	// the sub-split threshold so subSplitChunk actually runs.
	const para = (label: string): string => `${label}\n\n` + (`${label} paragraph.\n\n`.repeat(400));
	const big = [
		'# Title\n\n',
		'## Section A\n\n', para('a'),
		'## Section B\n\n', para('b'),
		'## Section C\n\n', para('c'),
	].join('');
	const entries = [{ name: 'big.md', content: big }];
	const chunks = chunkMemory(entries, 'unused', 1_500);
	assert.ok(chunks.length > 1, `expected >1 chunks, got ${chunks.length}`);
	for (const c of chunks) {
		assert.match(c.heading, /big\.md part \d+\/\d+/);
	}
});

test('chunkMemory: no entries -> falls back to splitDocument on the full text', () => {
	const memory = '# Section A\n' + 'a'.repeat(5_000) + '\n# Section B\n' + 'b'.repeat(5_000);
	const chunks = chunkMemory(undefined, memory, 4_000);
	assert.ok(chunks.length >= 1);
});

// ---------------------------------------------------------------------------
// Trace accounting
// ---------------------------------------------------------------------------

test('shapeMemory: trace reports memoryTokens >= input character / 3', async () => {
	const memory = 'x'.repeat(900);
	const { provider } = scriptedProvider([VALID_BUNDLE_JSON]);
	const result = await shapeMemory(provider, {
		memoryText: memory,
		objective:  'q',
		budget:     createBudget(32_768),
		numCtx:     32_768,
	});
	assert.ok(result.trace.memoryTokens >= 300);
});
