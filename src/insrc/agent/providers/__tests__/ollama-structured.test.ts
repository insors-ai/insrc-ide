/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for `OllamaProvider.completeStructured` (plans/structured-output.md Phase B.5).
 *
 * Pins:
 *   - Capability flag flipped to structuredOutput: true (was already
 *     working through the `complete + responseFormat: { schema }` path
 *     pre-Phase-A; this flips the explicit capability flag).
 *   - Schema is sent verbatim on the `format` field of the chat API.
 *   - Happy / retry / exhausted paths.
 *   - Discriminated union round-trips.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Static, Type } from '@sinclair/typebox';

import { OllamaProvider } from '../ollama.js';


interface RecordedCall { req: Record<string, unknown> }
type OllamaChatResp = { message: { content: string; role?: 'assistant' } };


function makeProvider(scriptedResponses: readonly OllamaChatResp[]): {
	provider: OllamaProvider;
	calls:    RecordedCall[];
} {
	const provider = new OllamaProvider('qwen3-coder:latest', 'http://localhost:11434', 16_384);
	const calls: RecordedCall[] = [];
	let i = 0;
	const mockClient = {
		chat: async (req: Record<string, unknown>) => {
			calls.push({ req });
			const r = scriptedResponses[i++];
			if (r === undefined) { throw new Error(`mock: no more responses (call ${i})`); }
			return r;
		},
	};
	(provider as unknown as { client: unknown }).client = mockClient;
	return { provider, calls };
}

function jsonResp(value: unknown): OllamaChatResp {
	return { message: { content: JSON.stringify(value), role: 'assistant' } };
}

function rawResp(text: string): OllamaChatResp {
	return { message: { content: text, role: 'assistant' } };
}


// ---------------------------------------------------------------------------
// Capability flag
// ---------------------------------------------------------------------------

test('B.5 capabilities.structuredOutput is true on OllamaProvider', () => {
	const p = new OllamaProvider('qwen3-coder:latest', 'http://localhost:11434', 16_384);
	assert.equal(p.capabilities.structuredOutput, true);
	assert.equal(p.capabilities.embeddings,       true);
});


// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('B.5 completeStructured: scripted JSON parses + validates', async () => {
	const Schema = Type.Object({
		category: Type.String(),
		count:    Type.Integer({ minimum: 0 }),
	});
	type R = Static<typeof Schema>;

	const { provider, calls } = makeProvider([
		jsonResp({ category: 'good', count: 3 }),
	]);
	const r = await provider.completeStructured<R>(
		[{ role: 'user', content: 'classify' }],
		Schema as unknown as Record<string, unknown>,
	);
	assert.equal(r.category, 'good');
	assert.equal(r.count, 3);

	// Schema sent verbatim on `format`.
	const req = calls[0]!.req as { format: { type?: string } };
	assert.equal(req.format.type, 'object');
});


// ---------------------------------------------------------------------------
// Retry path
// ---------------------------------------------------------------------------

test('B.5 completeStructured: malformed JSON -> retry -> success', async () => {
	const Schema = Type.Object({ ok: Type.Boolean() });
	const { provider, calls } = makeProvider([
		rawResp('not json'),
		jsonResp({ ok: true }),
	]);
	const r = await provider.completeStructured(
		[{ role: 'user', content: 'go' }],
		Schema as unknown as Record<string, unknown>,
	);
	assert.equal((r as { ok: boolean }).ok, true);
	assert.equal(calls.length, 2);

	// Second call gets the feedback note.
	const req2 = calls[1]!.req as { messages: Array<{ role: string; content: string }> };
	const lastMsg = req2.messages[req2.messages.length - 1]!;
	assert.equal(lastMsg.role, 'user');
	assert.match(lastMsg.content, /schema validation|not valid JSON/);
});


// ---------------------------------------------------------------------------
// Final failure
// ---------------------------------------------------------------------------

test('B.5 completeStructured: 3 bad responses -> exhausted error', async () => {
	const Schema = Type.Object({ count: Type.Integer() });
	const { provider } = makeProvider([
		jsonResp({}),
		jsonResp({}),
		jsonResp({}),
	]);
	await assert.rejects(
		provider.completeStructured(
			[{ role: 'user', content: 'fail' }],
			Schema as unknown as Record<string, unknown>,
		),
		/failed after 3 attempts/,
	);
});


// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

test('B.5 completeStructured: discriminated union round-trips', async () => {
	const Phase1AskSchema = Type.Union([
		Type.Object({ kind: Type.Literal('sufficient') }),
		Type.Object({
			kind:     Type.Literal('context-needed'),
			requests: Type.Array(Type.Object({ kind: Type.String() })),
		}),
	]);
	type Ask = Static<typeof Phase1AskSchema>;

	const { provider } = makeProvider([jsonResp({ kind: 'sufficient' })]);
	const r = await provider.completeStructured<Ask>(
		[{ role: 'user', content: 'need context?' }],
		Phase1AskSchema as unknown as Record<string, unknown>,
	);
	assert.equal(r.kind, 'sufficient');
});


// ---------------------------------------------------------------------------
// Empty content -> retry
// ---------------------------------------------------------------------------

test('B.5 completeStructured: empty content -> retry', async () => {
	const Schema = Type.Object({ ok: Type.Boolean() });
	const { provider, calls } = makeProvider([
		rawResp(''),
		jsonResp({ ok: true }),
	]);
	const r = await provider.completeStructured(
		[{ role: 'user', content: 'go' }],
		Schema as unknown as Record<string, unknown>,
	);
	assert.equal((r as { ok: boolean }).ok, true);
	assert.equal(calls.length, 2);
});


// ---------------------------------------------------------------------------
// keep_alive default
// ---------------------------------------------------------------------------

test('B.5 completeStructured: keep_alive set to 24h for KV cache reuse', async () => {
	const Schema = Type.Object({ ok: Type.Boolean() });
	const { provider, calls } = makeProvider([jsonResp({ ok: true })]);
	await provider.completeStructured(
		[{ role: 'user', content: 'go' }],
		Schema as unknown as Record<string, unknown>,
	);
	const req = calls[0]!.req as { keep_alive: string };
	assert.equal(req.keep_alive, '24h');
});
