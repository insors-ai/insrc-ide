/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for `AnthropicProvider.completeStructured` (plans/structured-output.md Phase B.1).
 *
 * Strategy: build a real AnthropicProvider, then override its private
 * `client` field with a mock that records each `messages.create` call
 * and returns a scripted response. Pins:
 *
 *   - Capability flag flipped to structuredOutput: true.
 *   - Happy path: scripted tool_use response parses + ajv-validates.
 *   - Retry path: first response is malformed; second is good. Second
 *     request gets the validation-feedback note appended as a user msg.
 *   - Final failure: 3 malformed responses throw a stable error.
 *   - Schema with discriminated union (the Phase1Ask shape) round-trips.
 *   - Schema with nested arrays.
 *   - Tool always wired with `name: '_emit'` + tool_choice forced.
 *   - `tools` request carries the input_schema verbatim.
 *   - Non-tool text response is treated as a validation failure -> retry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Static, Type } from '@sinclair/typebox';

import { AnthropicProvider } from '../anthropic.js';
import type { LLMMessage } from '../../../shared/types.js';


interface RecordedCreate { req: Record<string, unknown> }
type CreateResponse = {
	id?: string;
	type?: 'message';
	role?: 'assistant';
	model?: string;
	content: Array<
		| { type: 'tool_use'; id: string; name: string; input: unknown }
		| { type: 'text';     text: string }
	>;
	stop_reason?: 'end_turn' | 'tool_use' | 'max_tokens';
	usage: {
		input_tokens:                  number;
		output_tokens:                 number;
		cache_read_input_tokens?:      number | null;
		cache_creation_input_tokens?:  number | null;
	};
};


function makeProvider(scriptedResponses: readonly CreateResponse[]): {
	provider: AnthropicProvider;
	calls:    RecordedCreate[];
} {
	const provider = new AnthropicProvider({ apiKey: 'test', model: 'claude-test' });
	const calls: RecordedCreate[] = [];
	let i = 0;
	const mockClient = {
		messages: {
			create: async (req: Record<string, unknown>) => {
				calls.push({ req });
				const resp = scriptedResponses[i++];
				if (resp === undefined) {
					throw new Error(`mock client: no more scripted responses (call ${i})`);
				}
				return resp;
			},
		},
	};
	// Override the private `client` field. Tests are the canonical
	// dependency-injection seam for this provider.
	(provider as unknown as { client: unknown }).client = mockClient;
	return { provider, calls };
}


function toolUseResp(input: unknown, name = '_emit'): CreateResponse {
	return {
		content: [{ type: 'tool_use', id: 'toolu_1', name, input }],
		stop_reason: 'tool_use',
		usage: { input_tokens: 10, output_tokens: 5 },
	};
}

function textResp(text: string): CreateResponse {
	return {
		content: [{ type: 'text', text }],
		stop_reason: 'end_turn',
		usage: { input_tokens: 10, output_tokens: 5 },
	};
}


// ---------------------------------------------------------------------------
// Capability flag
// ---------------------------------------------------------------------------

test('B.1 capabilities.structuredOutput is true on AnthropicProvider', () => {
	const p = new AnthropicProvider({ apiKey: 'test' });
	assert.equal(p.capabilities.structuredOutput, true);
	assert.equal(p.capabilities.toolCalling,      true);
});


// ---------------------------------------------------------------------------
// Happy path: scripted tool_use round-trips
// ---------------------------------------------------------------------------

test('B.1 completeStructured: scripted tool_use response parses + validates', async () => {
	const Schema = Type.Object({
		category: Type.String(),
		count:    Type.Integer({ minimum: 0 }),
	});
	type R = Static<typeof Schema>;

	const { provider, calls } = makeProvider([toolUseResp({ category: 'good', count: 3 })]);
	const result = await provider.completeStructured<R>(
		[{ role: 'user', content: 'classify this' }],
		Schema as unknown as Record<string, unknown>,
	);
	assert.equal(result.category, 'good');
	assert.equal(result.count,    3);
	assert.equal(calls.length,    1);

	const req = calls[0]!.req as {
		tools:       Array<{ name: string; input_schema: Record<string, unknown> }>;
		tool_choice: { type: string; name: string };
		messages:    Array<{ role: string; content: unknown }>;
	};
	assert.equal(req.tools.length, 1);
	assert.equal(req.tools[0]!.name, '_emit');
	// The schema is forwarded verbatim into input_schema.
	assert.equal((req.tools[0]!.input_schema as { type?: string }).type, 'object');
	assert.deepEqual(req.tool_choice, { type: 'tool', name: '_emit' });
});


// ---------------------------------------------------------------------------
// Retry path
// ---------------------------------------------------------------------------

test('B.1 completeStructured: bad input -> retry with feedback note -> success', async () => {
	const Schema = Type.Object({
		category: Type.String(),
		count:    Type.Integer({ minimum: 0 }),
	});
	type R = Static<typeof Schema>;

	const { provider, calls } = makeProvider([
		toolUseResp({ category: 'good' }),                  // missing `count` -> validation fails
		toolUseResp({ category: 'good', count: 5 }),        // good
	]);
	const r = await provider.completeStructured<R>(
		[{ role: 'user', content: 'classify' }],
		Schema as unknown as Record<string, unknown>,
	);
	assert.equal(r.count, 5);
	assert.equal(calls.length, 2);

	// Second request gets an extra user message with the validation feedback.
	const req2 = calls[1]!.req as {
		messages: Array<{ role: string; content: string }>;
	};
	const lastMsg = req2.messages[req2.messages.length - 1]!;
	assert.equal(lastMsg.role, 'user');
	assert.match(lastMsg.content, /schema validation/);
	assert.match(lastMsg.content, /count|required/);
});


// ---------------------------------------------------------------------------
// Final failure
// ---------------------------------------------------------------------------

test('B.1 completeStructured: exhausts maxAttempts -> throws stable error', async () => {
	const Schema = Type.Object({ count: Type.Integer({ minimum: 0 }) });

	const { provider } = makeProvider([
		toolUseResp({}),
		toolUseResp({}),
		toolUseResp({}),
	]);
	await assert.rejects(
		provider.completeStructured(
			[{ role: 'user', content: 'fail me' }],
			Schema as unknown as Record<string, unknown>,
			{ maxAttempts: 3 },
		),
		(err: Error) => {
			assert.match(err.message, /failed after 3 attempts/);
			return true;
		},
	);
});


// ---------------------------------------------------------------------------
// Discriminated union (Phase1Ask shape)
// ---------------------------------------------------------------------------

test('B.1 completeStructured: discriminated union round-trips (Phase1Ask shape)', async () => {
	const Phase1AskSchema = Type.Union([
		Type.Object({ kind: Type.Literal('sufficient') }),
		Type.Object({
			kind:     Type.Literal('context-needed'),
			requests: Type.Array(Type.Object({ kind: Type.String() })),
		}),
	]);
	type Ask = Static<typeof Phase1AskSchema>;

	// Sufficient branch.
	const { provider: p1 } = makeProvider([toolUseResp({ kind: 'sufficient' })]);
	const r1 = await p1.completeStructured<Ask>(
		[{ role: 'user', content: 'do you need context?' }],
		Phase1AskSchema as unknown as Record<string, unknown>,
	);
	assert.equal(r1.kind, 'sufficient');

	// Context-needed branch.
	const { provider: p2 } = makeProvider([toolUseResp({
		kind: 'context-needed',
		requests: [{ kind: 'files' }, { kind: 'memory' }],
	})]);
	const r2 = await p2.completeStructured<Ask>(
		[{ role: 'user', content: 'do you need context?' }],
		Phase1AskSchema as unknown as Record<string, unknown>,
	);
	assert.equal(r2.kind, 'context-needed');
	if (r2.kind === 'context-needed') {
		assert.equal(r2.requests.length, 2);
		assert.equal(r2.requests[0]!.kind, 'files');
	}
});


// ---------------------------------------------------------------------------
// Non-tool text response -> validation-style retry
// ---------------------------------------------------------------------------

test('B.1 completeStructured: text-instead-of-tool response treated as failure -> retry', async () => {
	const Schema = Type.Object({ ok: Type.Boolean() });

	const { provider, calls } = makeProvider([
		textResp('I refuse to use the tool, here is text'),
		toolUseResp({ ok: true }),
	]);
	const r = await provider.completeStructured<Static<typeof Schema>>(
		[{ role: 'user', content: 'pretty please' }],
		Schema as unknown as Record<string, unknown>,
	);
	assert.equal((r as { ok: boolean }).ok, true);
	assert.equal(calls.length, 2);
});


test('B.1 completeStructured: 3 text responses -> exhausted error', async () => {
	const Schema = Type.Object({ ok: Type.Boolean() });

	const { provider } = makeProvider([
		textResp('not using tool'),
		textResp('still not'),
		textResp('nope'),
	]);
	await assert.rejects(
		provider.completeStructured(
			[{ role: 'user', content: 'pretty please' }],
			Schema as unknown as Record<string, unknown>,
		),
		(err: Error) => {
			assert.match(err.message, /failed after 3 attempts/);
			return true;
		},
	);
});


// ---------------------------------------------------------------------------
// System message routing
// ---------------------------------------------------------------------------

test('B.1 completeStructured: system message routed to top-level system field', async () => {
	const Schema = Type.Object({ ok: Type.Boolean() });

	const { provider, calls } = makeProvider([toolUseResp({ ok: true })]);
	const messages: LLMMessage[] = [
		{ role: 'system', content: 'You are a strict classifier.' },
		{ role: 'user',   content: 'evaluate this' },
	];
	await provider.completeStructured(messages, Schema as unknown as Record<string, unknown>);

	const req = calls[0]!.req as { system?: string; messages: Array<{ role: string }> };
	assert.match(req.system ?? '', /strict classifier/);
	// System message NOT in the messages array.
	assert.equal(req.messages.find(m => m.role === 'system'), undefined);
});


// ---------------------------------------------------------------------------
// Custom maxAttempts honoured
// ---------------------------------------------------------------------------

test('B.1 completeStructured: maxAttempts=1 -> single attempt + immediate fail', async () => {
	const Schema = Type.Object({ count: Type.Integer({ minimum: 0 }) });
	const { provider, calls } = makeProvider([toolUseResp({})]);

	await assert.rejects(
		provider.completeStructured(
			[{ role: 'user', content: 'go' }],
			Schema as unknown as Record<string, unknown>,
			{ maxAttempts: 1 },
		),
		/failed after 1 attempts/,
	);
	assert.equal(calls.length, 1);
});
